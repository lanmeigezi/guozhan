// grab21.js — 抢21 ("Race to 21"), promoted from a player-written mod to a
// built-in game so Bluetooth / local / remote modes all share the same source.
//
// Game interface (see MODDING.md):
//   1. Implement a game class with the Game interface:
//        addPlayer(name) -> seat        (lobby only)
//        applyAction(seat, action)      ('start' begins; throw GameError for illegal moves)
//        snapshot()  -> public state
//        viewFor(seat) -> personalized view (public state + own hand)
//   2. Export `const game = { key, name, card, min, max, create, ai }`.

import { GameError } from '../engine/game-error.js';
import { shuffle } from '../engine/cards.js';

let _id = 0;
const mk = (value) => ({ id: 'g21-' + (_id++), value });

export class Grab21Game {
  constructor({ playerNames = [], options = {}, random } = {}) {
    this.random = random || Math.random;
    this.target = 21;
    this.players = playerNames.map((name, i) => ({ id: i, name, hand: [] }));
    this.phase = 'lobby';   // 'lobby' | 'playing' | 'roundEnd'
    this.current = 0;
    this.winner = null;
    this.pool = 0;          // shared running total
    this.last = null;
    this.deck = [];         // 摸牌堆（发牌后剩余的牌留在这里）
    this.discard = [];      // 出牌后回收的牌，deck 空时洗回
  }

  get n() { return this.players.length; }

  addPlayer(name) {
    if (this.phase !== 'lobby') throw new GameError('GAME_STARTED', '游戏已开始');
    this.players.push({ id: this.players.length, name, hand: [] });
    return this.players.length - 1;
  }

  start() {
    if (this.phase !== 'lobby') throw new GameError('GAME_STARTED', '游戏已开始');
    if (this.n < 2) throw new GameError('NOT_ENOUGH', '抢21 至少需要 2 人');
    // deck: four copies of each value 1..9
    const cards = [];
    for (let v = 1; v <= 9; v++) for (let i = 0; i < 4; i++) cards.push(mk(v));
    this.deck = shuffle(cards, this.random);
    this.discard = [];
    for (const p of this.players) { p.hand = []; for (let i = 0; i < 4 && this.deck.length; i++) p.hand.push(this.deck.pop()); }
    this.phase = 'playing';
    this.current = 0;
    this.winner = null;
    this.pool = 0;
    this.last = { kind: 'start', target: this.target };
    return this.snapshot();
  }

  // 摸一张牌；本堆空时把 discard 全部洗回本堆。
  drawFromPile() {
    if (this.deck.length === 0) {
      if (this.discard.length === 0) return null;
      this.deck = shuffle(this.discard, this.random);
      this.discard = [];
    }
    return this.deck.pop();
  }

  // 出牌后把该玩家手牌补到至少 1 张（避免轮到玩家时手牌为空导致死锁）。
  refill(seat) {
    const p = this.players[seat];
    while (p.hand.length < 1) {
      const c = this.drawFromPile();
      if (!c) break;
      p.hand.push(c);
    }
  }

  // Play one card: adds to the pool. Exactly 21 -> you win. Over 21 -> pool
  // resets (bust) and the turn moves on.
  play(seat, cardId) {
    if (this.phase !== 'playing') throw new GameError('NOT_PLAYING', '游戏未开始');
    if (seat !== this.current) throw new GameError('NOT_YOUR_TURN', '还没轮到你');
    const hand = this.players[seat].hand;
    const i = hand.findIndex((c) => c.id === cardId);
    if (i < 0) throw new GameError('NO_CARD', '你手里没有这张牌');
    const [card] = hand.splice(i, 1);
    this.discard.push(card);               // 回收出掉的牌
    this.rounds = (this.rounds || 0) + 1;  // 出牌计数（用于终止兜底）
    this.pool += card.value;
    this.last = { kind: 'play', seat, value: card.value, pool: this.pool };
    if (this.pool === this.target) { this.phase = 'roundEnd'; this.winner = seat; return this.snapshot(); }
    if (this.pool > this.target) this.pool = 0; // bust -> pool resets to 0
    this.refill(seat);                      // 出牌后补足手牌，避免死锁
    // 终止兜底：出牌过多仍无人凑 21，判和局回 lobby
    if (this.rounds > 500) { this.phase = 'roundEnd'; this.winner = null; return this.snapshot(); }
    this.current = (this.current + 1) % this.n;
    return this.snapshot();
  }

  applyAction(seat, action) {
    const act = action || {};
    switch (act.kind) {
      case 'start': return this.start();
      case 'play': return this.play(seat, act.cardId);
      default: throw new GameError('UNKNOWN_ACT', '未知操作');
    }
  }

  snapshot() {
    return {
      phase: this.phase,
      current: this.current,
      winner: this.winner,
      pool: this.pool,
      target: this.target,
      last: this.last,
      players: this.players.map((p) => ({ id: p.id, name: p.name })),
      counts: this.players.map((p) => p.hand.length),
      you: null, hand: [],
    };
  }

  viewFor(seat) {
    const snap = this.snapshot();
    snap.you = seat;
    snap.hand = this.players[seat].hand.map((c) => ({ ...c }));
    return snap;
  }
}

// Simple AI: hit exactly the target if possible, else play the smallest card.
export function aiGrab21(game, seat) {
  if (game.phase !== 'playing' || game.current !== seat) return null;
  const hand = game.players[seat].hand;
  // 正常情况下手牌不会为空：play() 在每次出牌后都会调用 refill() 补足手牌，
  // 因此轮到本玩家时手牌 ≥1，此分支实际永不触发。仅当整副牌耗尽
  // （deck/discard 全空）时才会空，而该情况已被 play() 中 rounds>500 的
  // 终止兜底提前结束本局，故此处保留 return null 不会导致 host 死锁。
  if (!hand.length) return null;
  const need = game.target - game.pool;
  const hit = hand.find((c) => c.value === need);
  const pick = hit || [...hand].sort((a, b) => a.value - b.value)[0];
  return { kind: 'play', cardId: pick.id };
}

export const game = {
  key: 'grab21',
  name: '抢21',
  card: '21',
  min: 2,
  max: 6,
  create: ({ playerNames = [], options = {}, random }) => new Grab21Game({ playerNames, options, random }),
  ai: aiGrab21,
};
