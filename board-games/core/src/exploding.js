// exploding.js — 炸弹猫 (Exploding Kittens) rules engine.
// A Russian-roulette card game, 2–5 players. Every turn you draw a card; if it's
// an Exploding Kitten and you hold no Defuse, you're out. Last player standing
// wins. Implements the Game interface used by the host. Simplified but faithful:
// turns = play action cards (skip/shuffle/see) then must draw; defuse is applied
// automatically when you hit a kitten.
//
// Card kinds: explode, defuse, skip, see, shuffle, cat (junk).

import { GameError } from './game-error.js';
import { shuffle } from './cards.js';

let _id = 0;
const mk = (kind, extra) => ({ id: 'ek' + (kind) + '-' + (_id++), kind: kind, ...extra });

export function buildEkDeck(playerCount, handSize = 4) {
  const n = Math.max(2, playerCount | 0 || 2);
  const need = n * (handSize + 1) + 12; // serve every player + draw-pile reserve
  const cards = [];
  // cycle: skip, see, shuffle, attack, favor, and 3 cat subtypes (红/黄/蓝, 2 copies each)
  const cycle = ['skip', 'see', 'shuffle', 'attack', 'favor', 'cat红', 'cat红', 'cat黄', 'cat黄', 'cat蓝', 'cat蓝'];
  for (let i = 0; i < need; i++) {
    const t = cycle[i % cycle.length];
    if (t.indexOf('cat') === 0) cards.push(mk('cat', { cat: t.slice(3) }));
    else cards.push(mk(t));
  }
  return cards;
}

const DEFAULT_OPTIONS = {
  handSize: 4,          // cards dealt to each player (besides the starting defuse)
  kittensPerPlayer: 1,  // exploding kittens lookahead handled in start()
};

export class ExplodingKittensGame {
  constructor({ playerNames = [], options = {}, random } = {}) {
    this.opts = { ...DEFAULT_OPTIONS, ...options };
    this.random = random || Math.random;
    this.players = playerNames.map((name, i) => ({ id: i, name, hand: [], alive: true }));
    this.phase = 'lobby';
    this.current = 0;
    this.winner = null;
    this.drawPile = [];
    this.discard = [];
    this.last = null;
    this.seeTop = null; // transient reveal for the "see" action
    this.pendingDefuse = null; // {seat, card} when a player defused a bomb and must choose a position
    this.pendingFavor = null; // {from, target} when a Favor card is being resolved
  }

  get n() { return this.players.length; }

  addPlayer(name) {
    if (this.phase !== 'lobby') throw new GameError('GAME_STARTED', 'Game already started');
    this.players.push({ id: this.players.length, name, hand: [], alive: true });
    return this.players.length - 1;
  }

  start() {
    if (this.phase !== 'lobby') throw new GameError('GAME_STARTED', 'Game already started');
    if (this.n < 2) throw new GameError('NOT_ENOUGH', '炸弹猫至少需要 2 人');
    const n = this.n;
    // 1 defuse per player + handSize random cards
    const junk = shuffle(buildEkDeck(n, this.opts.handSize), this.random);
    for (let p = 0; p < n; p++) {
      const hand = [mk('defuse')];
      for (let i = 0; i < this.opts.handSize; i++) hand.push(junk.pop());
      this.players[p].hand = hand;
    }
    // build the draw pile from the remaining junk + exploding kittens
    const pile = junk.slice();
    const kittens = n - 1;
    for (let i = 0; i < kittens; i++) {
      // put kittens at random spots, but keep the first few draws safe
      const pos = 1 + Math.floor(this.random() * Math.max(1, pile.length - 1));
      const k = mk('explode');
      pile.splice(pos, 0, k);
    }
    this.drawPile = pile;
    this.discard = [];
    this.phase = 'playing';
    this.current = 0;
    this.last = { kind: 'start', kittens: kittens };
    this.seeTop = null;
    this.pendingDefuse = null;
    this.pendingFavor = null;
    return this.snapshot();
  }

  aliveCount() { return this.players.filter((p) => p.alive).length; }
  nextAlive(from) {
    let s = from;
    for (let i = 0; i < this.n; i++) { s = (s + 1) % this.n; if (this.players[s].alive) return s; }
    return from;
  }
  peekTop(k) { return this.drawPile.slice(0, k); }

  // Draw the top card. Drawn cards are REMOVED from the pile (so a later shuffle
  // of the pile never resurrects them, and duplicates can't occur).
  drawFromPile() {
    if (this.drawPile.length === 0) {
      if (this.discard.length === 0) throw new GameError('DECK_EMPTY', '牌库已空');
      this.drawPile = shuffle(this.discard, this.random);
      this.discard = [];
    }
    return this.drawPile.shift();
  }

  applyAction(seat, action) {
    const act = action || {};
    switch (act.kind) {
      case 'start': return this.start();
      case 'play': return this.playCard(seat, act.cardId);
      case 'draw': return this.draw(seat);
      case 'defuse': return this.defuse(seat, act.position);
      case 'cats': return this.cats(seat, act.cardIds, act.targetSeat);
      case 'favor': return this.favor(seat, act.cardId, act.targetSeat);
      case 'give': return this.give(seat, act.cardId);
      case 'attack': return this.attack(seat, act.cardId, act.targetSeat);
      case 'shuffle2': return this.shuffle2(seat, act.cardIds);
      default: throw new GameError('UNKNOWN_ACT', '未知操作');
    }
  }

  playCard(seat, cardId) {
    this.assertPlaying(seat);
    if (this.pendingDefuse || this.pendingFavor) throw new GameError('MUST_FIRST', '请先处理当前事件');
    const hand = this.players[seat].hand;
    const card = hand.find((c) => c.id === cardId);
    if (!card) throw new GameError('NO_CARD', '你手里没有这张牌');
    if (card.kind === 'explode' || card.kind === 'defuse' || card.kind === 'cat' || card.kind === 'favor' || card.kind === 'attack') {
      throw new GameError('ILLEGAL', '这张牌不能单独打出');
    }
    hand.splice(hand.indexOf(card), 1);
    this.discard.push(card);
    if (card.kind === 'skip') {
      this.last = { kind: 'play', seat, card: 'skip' };
      this.current = this.nextAlive(seat);
      this.seeTop = null;
    } else if (card.kind === 'see') {
      this.seeTop = { seat, top: this.peekTop(3).map((c) => c.kind) };
      this.last = { kind: 'play', seat, card: 'see' };
      // player still draws this turn
    } else { // shuffle: reorder the pile only (count & card types unchanged)
      this.drawPile = shuffle(this.drawPile, this.random);
      this.last = { kind: 'play', seat, card: 'shuffle' };
      this.seeTop = null;
    }
    return this.snapshot();
  }

  // Draw ONE card and resolve it. Returns true if the turn is paused (a bomb was
  // defused -> pendingDefuse, or the player was eliminated) so the caller stops.
  _drawOne(seat) {
    const card = this.drawFromPile();
    if (card.kind === 'explode') {
      const defuse = this.players[seat].hand.find((c) => c.kind === 'defuse');
      if (defuse) {
        this.players[seat].hand.splice(this.players[seat].hand.indexOf(defuse), 1);
        this.discard.push(defuse);
        this.pendingDefuse = { seat, card };
        this.last = { kind: 'defused', seat };
        return true;
      }
      this.players[seat].alive = false;
      this.last = { kind: 'exploded', seat };
      if (this.aliveCount() <= 1) { this.phase = 'roundEnd'; this.winner = this.players.findIndex((p) => p.alive); }
      else this.current = this.nextAlive(seat);
      return true;
    }
    this.players[seat].hand.push(card);
    this.last = { kind: 'draw', seat };
    return false;
  }

  draw(seat) {
    this.assertPlaying(seat);
    if (this.pendingDefuse || this.pendingFavor) throw new GameError('MUST_FIRST', '请先处理当前事件');
    const p = this.players[seat];
    const extras = p.attack || 0; p.attack = 0; // consume Attack bonus draws
    if (this._drawOne(seat)) return this.snapshot();
    for (let i = 0; i < extras && p.alive && !this.pendingDefuse; i++) {
      if (this._drawOne(seat)) break;
    }
    if (this.phase === 'playing' && p.alive && !this.pendingDefuse) this.current = this.nextAlive(seat);
    return this.snapshot();
  }

  // Place the defused bomb back at a chosen position (1 = top / next card).
  defuse(seat, position) {
    if (this.phase !== 'playing' || !this.pendingDefuse || this.pendingDefuse.seat !== seat || seat !== this.current) {
      throw new GameError('NOT_DEFUSE', '当前无需拆除炸弹');
    }
    const avail = Math.max(1, this.drawPile.length);
    const pos = (position == null) ? avail : Math.max(1, Math.min(avail, Math.floor(Number(position))));
    this.drawPile.splice(pos - 1, 0, this.pendingDefuse.card);
    this.pendingDefuse = null;
    this.seeTop = null;
    this.last = { kind: 'placed', seat, position: pos };
    this.current = this.nextAlive(seat);
    return this.snapshot();
  }

  // Play 2 or 3 identical cat cards -> take 1 (2 cats) or 2 (3 cats) random cards
  // from the chosen target. Does NOT skip the turn; the player must still draw.
  cats(seat, cardIds, targetSeat) {
    this.assertPlaying(seat);
    if (this.pendingDefuse || this.pendingFavor) throw new GameError('MUST_FIRST', '请先处理当前事件');
    const hand = this.players[seat].hand;
    const cards = (cardIds || []).map((id) => hand.find((c) => c.id === id));
    if (cards.length < 2 || cards.length > 3 || cards.some((c) => !c || c.kind !== 'cat')) {
      throw new GameError('ILLEGAL', '需要用 2 或 3 张相同的猫牌');
    }
    const sub = cards[0].cat;
    if (cards.some((c) => c.cat !== sub)) throw new GameError('ILLEGAL', '需要相同的猫牌才能一起出');
    const target = this.players[targetSeat];
    if (!target || !target.alive || targetSeat === seat) throw new GameError('ILLEGAL', '请选择一位存活的玩家');
    for (const c of cards) { hand.splice(hand.indexOf(c), 1); this.discard.push(c); }
    const n = cards.length - 1; // 2 cats -> 1 card, 3 cats -> 2 cards
    const got = [];
    for (let i = 0; i < n && target.hand.length > 0; i++) {
      const idx = Math.floor(this.random() * target.hand.length);
      const c = target.hand.splice(idx, 1)[0];
      this.players[seat].hand.push(c);
      got.push(c);
    }
    this.last = { kind: 'cats', seat, target: targetSeat, n: got.length };
    this.seeTop = null;
    return this.snapshot();
  }

  // Play a Favor card -> the chosen target must give the player one card.
  favor(seat, cardId, targetSeat) {
    this.assertPlaying(seat);
    if (this.pendingDefuse || this.pendingFavor) throw new GameError('MUST_FIRST', '请先处理当前事件');
    const hand = this.players[seat].hand;
    const card = hand.find((c) => c.id === cardId);
    if (!card || card.kind !== 'favor') throw new GameError('NO_CARD', '你没有这张恩惠牌');
    const target = this.players[targetSeat];
    if (!target || !target.alive || targetSeat === seat || target.hand.length === 0) throw new GameError('ILLEGAL', '请选择一位有手牌的存活玩家');
    hand.splice(hand.indexOf(card), 1);
    this.discard.push(card);
    this.pendingFavor = { from: seat, target: targetSeat };
    this.last = { kind: 'favor', seat, target: targetSeat };
    return this.snapshot();
  }

  // The favor target hands a chosen card to the favor player.
  give(seat, cardId) {
    if (!this.pendingFavor || this.pendingFavor.target !== seat) throw new GameError('NOT_FAVOR', '现在不需要你给牌');
    const hand = this.players[seat].hand;
    const card = hand.find((c) => c.id === cardId);
    if (!card) throw new GameError('NO_CARD', '你手里没有这张牌');
    hand.splice(hand.indexOf(card), 1);
    const from = this.pendingFavor.from;
    this.players[from].hand.push(card);
    this.last = { kind: 'given', seat, from };
    this.pendingFavor = null;
    return this.snapshot();
  }

  // Attack card: the chosen target must draw one extra card on their next draw.
  attack(seat, cardId, targetSeat) {
    this.assertPlaying(seat);
    if (this.pendingDefuse || this.pendingFavor) throw new GameError('MUST_FIRST', '请先处理当前事件');
    const hand = this.players[seat].hand;
    const card = hand.find((c) => c.id === cardId);
    if (!card || card.kind !== 'attack') throw new GameError('NO_CARD', '你没有这张攻击牌');
    const target = this.players[targetSeat];
    if (!target || !target.alive || targetSeat === seat) throw new GameError('ILLEGAL', '请选择一位存活的玩家');
    hand.splice(hand.indexOf(card), 1);
    this.discard.push(card);
    target.attack = (target.attack || 0) + 1;
    this.last = { kind: 'attack', seat, target: targetSeat };
    return this.snapshot(); // turn continues: attacker must still draw
  }

  // Two shuffle cards: RESET the draw pile (merge discard + pile, reshuffle fresh).
  // A single shuffle card only reorders (keeps count/types); two reset the pile.
  shuffle2(seat, cardIds) {
    this.assertPlaying(seat);
    if (this.pendingDefuse || this.pendingFavor) throw new GameError('MUST_FIRST', '请先处理当前事件');
    const hand = this.players[seat].hand;
    const cards = (cardIds || []).map((id) => hand.find((c) => c.id === id));
    if (cards.length !== 2 || cards.some((c) => !c || c.kind !== 'shuffle')) throw new GameError('ILLEGAL', '需要两张洗混牌');
    for (const c of cards) { hand.splice(hand.indexOf(c), 1); this.discard.push(c); }
    const merged = this.discard.concat(this.drawPile);
    this.discard = [];
    this.drawPile = shuffle(merged, this.random);
    this.seeTop = null;
    this.last = { kind: 'shuffle2', seat };
    return this.snapshot(); // turn continues: player must still draw
  }

  assertPlaying(seat) {
    if (this.phase !== 'playing') throw new GameError('NOT_PLAYING', '游戏尚未开始');
    if (!this.players[seat].alive) throw new GameError('ELIMINATED', '你已被淘汰');
    if (seat !== this.current) throw new GameError('NOT_YOUR_TURN', '还没轮到你');
  }

  snapshot() {
    return {
      phase: this.phase,
      current: this.current,
      winner: this.winner,
      drawCount: this.drawPile.length,
      players: this.players.map((p) => ({ id: p.id, name: p.name, handCount: p.hand.length, alive: p.alive })),
      counts: this.players.map((p) => p.hand.length),
      alive: this.players.map((p) => p.alive),
      last: this.last,
      seeTop: this.seeTop,
      pendingDefuse: this.pendingDefuse ? { seat: this.pendingDefuse.seat } : null,
      pendingFavor: this.pendingFavor ? { from: this.pendingFavor.from, target: this.pendingFavor.target } : null,
    };
  }

  viewFor(seat) {
    const snap = this.snapshot();
    snap.you = seat;
    snap.hand = this.players[seat].hand.map((c) => ({ ...c }));
    return snap;
  }
}

// ---- AI ----
export function aiEk(game, seat) {
  if (game.phase !== 'playing') return null;
  // When targeted by a Favor, hand a card (prefer not a defuse).
  if (game.pendingFavor && game.pendingFavor.target === seat) {
    const hand = game.players[seat].hand;
    if (hand.length === 0) return null;
    const sorted = [...hand].sort((a, b) => (a.kind === 'defuse' ? 1 : 0) - (b.kind === 'defuse' ? 1 : 0));
    return { kind: 'give', cardId: sorted[0].id };
  }
  if (game.current !== seat) return null;
  // Must place the defused bomb back: aim at the opponent most likely to win
  // (fewest cards), i.e. put it at the top if the immediate next drawer is them.
  if (game.pendingDefuse && game.pendingDefuse.seat === seat) {
    const avail = Math.max(1, game.drawPile.length);
    const next = game.nextAlive(seat);
    const opps = game.players.map((p, i) => ({ i, c: p.hand.length, alive: p.alive }))
      .filter((o) => o.alive && o.i !== seat);
    let threat = opps.length ? opps.reduce((a, b) => (b.c < a.c ? b : a), opps[0]).i : next;
    const pos = next === threat ? 1 : Math.max(2, Math.floor(game.random() * Math.max(1, avail)) + 1);
    return { kind: 'defuse', position: Math.min(avail, pos) };
  }
  const hand = game.players[seat].hand;
  const explodeLeft = game.drawPile.filter((c) => c.kind === 'explode').length;
  const hasDefuse = hand.some((c) => c.kind === 'defuse');
  const skips = hand.filter((c) => c.kind === 'skip');
  if (skips.length && explodeLeft >= 2 && !hasDefuse) return { kind: 'play', cardId: skips[0].id };
  // Use an Attack card on the opponent closest to winning (fewest cards).
  const attacks = hand.filter((c) => c.kind === 'attack');
  if (attacks.length) {
    const opps = game.players.map((p, i) => ({ i, c: p.hand.length, alive: p.alive })).filter((o) => o.alive && o.i !== seat);
    if (opps.length) {
      const threat = opps.reduce((a, b) => (b.c < a.c ? b : a), opps[0]).i;
      return { kind: 'attack', cardId: attacks[0].id, targetSeat: threat };
    }
  }
  // When leading with a defuse in hand, use an identical cat pair to steal a card.
  const cats = {};
  for (const c of hand) if (c.kind === 'cat') (cats[c.cat] = cats[c.cat] || []).push(c);
  for (const sub of Object.keys(cats)) {
    if (cats[sub].length >= 2) {
      const target = game.players.findIndex((p, i) => p.alive && i !== seat && p.hand.length > 0);
      if (target >= 0) return { kind: 'cats', cardIds: cats[sub].slice(0, 2).map((c) => c.id), targetSeat: target };
    }
  }
  return { kind: 'draw' };
}
