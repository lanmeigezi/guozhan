// doudizhu.js — 斗地主 (Chinese "Fight the Landlord") rules engine.
// 3 players, 54-card deck (4 suits x 13 ranks + 2 jokers). One landlord vs two
// farmers; the landlord plays first after bidding. Implements the Game interface
// used by the host: start / applyAction(seat, action) / snapshot / viewFor.

import { GameError } from './game-error.js';
import { shuffle, mulberry32 } from './cards.js';

// ---- ranks & deck ----
const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
const VALUE = {}; RANKS.forEach((r, i) => { VALUE[r] = i + 3; });
VALUE['SJ'] = 16; // small joker
VALUE['BJ'] = 17; // big joker
const SUITS = ['spade', 'heart', 'club', 'diamond'];
const RANK_OF = (v) => (v === 16 ? 'SJ' : v === 17 ? 'BJ' : RANKS[v - 3]);

export function buildDdzDeck() {
  const deck = [];
  let id = 0;
  for (const r of RANKS) {
    for (const s of SUITS) deck.push({ id: `d${id++}`, rank: r, suit: s, value: VALUE[r], joker: false });
  }
  deck.push({ id: `d${id++}`, rank: 'SJ', suit: null, value: VALUE.SJ, joker: true });
  deck.push({ id: `d${id++}`, rank: 'BJ', suit: null, value: VALUE.BJ, joker: true });
  return deck;
}

// ---- hand classification ----
// Returns {type, rank, len} for a valid combination, null if it is not one.
// type: rocket|bomb|single|pair|triple|trio1|trio2|straight|doubleStraight|
//       plane|planeSingle|planePair|four2single|four2pair
export function classifyDdz(hand) {
  const n = hand.length;
  if (n === 0) return null;
  // counts by value
  const counts = {};
  for (const c of hand) counts[c.value] = (counts[c.value] || 0) + 1;
  const vals = Object.keys(counts).map(Number).sort((a, b) => a - b);

  const rocket = () => n === 2 && hand.every((c) => c.joker) && vals.length === 2;
  const bomb = () => n === 4 && vals.length === 1;

  if (rocket()) return { type: 'rocket', rank: 18, len: 2 };
  if (bomb()) return { type: 'bomb', rank: vals[0], len: 4 };

  const single = () => n === 1;
  const pair = () => n === 2 && vals.length === 1;
  const triple = () => n === 3 && vals.length === 1;
  // triple + single / triple + pair
  const trio1 = () => {
    if (n !== 4 || vals.length !== 2) return false;
    return counts[vals[0]] === 3 || counts[vals[1]] === 3;
  };
  const trio2 = () => {
    if (n !== 5 || vals.length !== 2) return false;
    return counts[vals[0]] === 3 || counts[vals[1]] === 3;
  };
  // straight: >=5 singles, consecutive, no jokers/2. rank = highest card.
  const straight = () => {
    if (n < 5 || vals.length !== n) return false;
    if (vals.some((v) => v > VALUE['A'])) return false;
    for (let i = 1; i < vals.length; i++) if (vals[i] !== vals[i - 1] + 1) return false;
    return true;
  };
  // double-straight (连对): >=3 consecutive pairs, no jokers/2. rank = highest pair.
  const doubleStraight = () => {
    if (n < 6 || n % 2 !== 0) return false;
    if (vals.every((v) => counts[v] === 2) && vals.every((v) => v <= VALUE['A'])) {
      for (let i = 1; i < vals.length; i++) if (vals[i] !== vals[i - 1] + 1) return false;
      return true;
    }
    return false;
  };
  // airplane: >=2 consecutive triples (no jokers/2), optionally with wings.
  const plane = () => {
    const triples = vals.filter((v) => counts[v] === 3 && v <= VALUE['A']);
    if (triples.length < 2) return false;
    for (let i = 1; i < triples.length; i++) if (triples[i] !== triples[i - 1] + 1) return false;
    const bodyLen = triples.length * 3;
    if (n === bodyLen) return { type: 'plane', rank: triples[triples.length - 1], len: n };
    const wing = n - bodyLen;
    if (wing === triples.length) return { type: 'planeSingle', rank: triples[triples.length - 1], len: n };
    if (wing === triples.length * 2 && wing % 2 === 0) return { type: 'planePair', rank: triples[triples.length - 1], len: n };
    return false;
  };
  // four + two (四带二): 4 same + 2 singles, or 4 same + 2 pairs.
  const four2 = () => {
    const fours = vals.filter((v) => counts[v] === 4);
    if (fours.length !== 1) return false;
    const rest = n - 4;
    if (rest === 2) return { type: 'four2single', rank: fours[0], len: n };
    if (rest === 4) return { type: 'four2pair', rank: fours[0], len: n };
    return false;
  };

  if (single()) return { type: 'single', rank: vals[0], len: 1 };
  if (pair()) return { type: 'pair', rank: vals[0], len: 2 };
  if (triple()) return { type: 'triple', rank: vals[0], len: 3 };
  if (trio1()) return { type: 'trio1', rank: (counts[vals[0]] === 3 ? vals[0] : vals[1]), len: 4 };
  if (trio2()) return { type: 'trio2', rank: (counts[vals[0]] === 3 ? vals[0] : vals[1]), len: 5 };
  if (straight()) return { type: 'straight', rank: vals[vals.length - 1], len: n };
  if (doubleStraight()) return { type: 'doubleStraight', rank: vals[vals.length - 1], len: n };
  const pl = plane();
  if (pl) return pl;
  const f2 = four2();
  if (f2) return f2;
  return null;
}

export function beatsDdz(candidate, prev) {
  if (candidate.type === 'rocket') return prev.type !== 'rocket';
  if (prev.type === 'rocket') return false;
  if (candidate.type === 'bomb') {
    if (prev.type === 'bomb') return candidate.rank > prev.rank;
    return true; // bomb beats any non-bomb
  }
  if (prev.type === 'bomb') return false; // non-bomb can't beat a bomb
  if (candidate.type !== prev.type) return false;
  if (candidate.len !== prev.len) return false;
  return candidate.rank > prev.rank;
}

const DEFAULT_OPTIONS = {
  maxPasses: 2, // a new round is led after this many consecutive passes
  allowBomb: true,
};
const DDF = { PHASE: { LOBBY: 'lobby', BIDDING: 'bidding', PLAYING: 'playing', END: 'roundEnd' } };
const LANDLORD_MIN_SCORE = 1;

export class DoudizhuGame {
  constructor({ playerNames = [], options = {}, random } = {}) {
    this.opts = { ...DEFAULT_OPTIONS, ...options };
    this.random = random || Math.random;
    this.players = playerNames.map((name, i) => ({ id: i, name, hand: [] }));
    this.phase = DDF.PHASE.LOBBY; // lobby -> bidding -> playing -> roundEnd
    this.winner = null; // seat of the winning alliance (landlord wins or a farmer)
    this.landlord = null; // seat
    this.current = 0;
    this.lastPlay = null; // {seat, cards, combo} last winning play on the table
    this.passCount = 0;
    this.bidScores = []; // per-seat bid score
    this.diPai = []; // 3 kept-aside (底牌)
    this.last = null;
  }

  get n() { return this.players.length; }

  addPlayer(name) {
    if (this.phase !== DDF.PHASE.LOBBY) throw new GameError('GAME_STARTED', 'Game already started');
    this.players.push({ id: this.players.length, name, hand: [] });
    return this.players.length - 1;
  }

  // ---- setup ----
  start() {
    if (this.phase !== DDF.PHASE.LOBBY) throw new GameError('GAME_STARTED', 'Game already started');
    if (this.n < 3) throw new GameError('NOT_ENOUGH', '斗地主需要至少 3 名玩家');
    if (this.n !== 3) throw new GameError('NOT_ENOUGH', '斗地主固定 3 人');
    const deck = shuffle(buildDdzDeck(), this.random);
    for (let i = 0; i < 17; i++) for (let p = 0; p < 3; p++) this.players[p].hand.push(deck.pop());
    this.diPai = deck.slice(0, 3);
    this.phase = DDF.PHASE.BIDDING;
    this.current = 0;
    this.bidScores = [null, null, null];
    this.last = { kind: 'start', diPaiHidden: true };
    return this.snapshot();
  }

  // ---- actions ----
  applyAction(seat, action) {
    const act = action || {};
    switch (act.kind) {
      case 'start': return this.start();
      case 'bid': return this.bid(seat, act.score);
      case 'play': return this.play(seat, act.cardIds);
      case 'pass': return this.pass(seat);
      default: throw new GameError('UNKNOWN_ACT', '未知操作');
    }
  }

  bid(seat, score) {
    this.assertPhase(DDF.PHASE.BIDDING);
    if (seat !== this.current) throw new GameError('NOT_YOUR_TURN', '还没轮到你叫地主');
    if (score < 0 || score > 3) throw new GameError('ILLEGAL_BID', '叫分需为 0-3');
    if (this.bidScores[seat] !== null) throw new GameError('ILLEGAL_BID', '你已经叫过分了');
    this.bidScores[seat] = score;
    this.last = { kind: 'bid', seat, score };
    this.current = (seat + 1) % 3;
    if (this.bidScores.every((s) => s !== null)) {
      const best = this.bidScores.indexOf(Math.max(...this.bidScores));
      if (this.bidScores[best] >= LANDLORD_MIN_SCORE) this.finishBid(best);
      else { this.phase = DDF.PHASE.END; this.winner = null; this.last = { kind: 'flow' }; }
    }
    return this.snapshot();
  }

  finishBid(seat) {
    this.landlord = seat;
    // give the landlord the 3 diPai
    this.players[seat].hand.push(...this.diPai);
    this.diPai = [];
    this.phase = DDF.PHASE.PLAYING;
    this.current = seat;
    this.lastPlay = null;
    this.passCount = 0;
    this.last = { kind: 'landlord', seat };
  }

  play(seat, cardIds) {
    this.assertPhase(DDF.PHASE.PLAYING);
    if (seat !== this.current) throw new GameError('NOT_YOUR_TURN', '还没轮到你出牌');
    const hand = this.players[seat].hand;
    const cards = cardIds.map((id) => hand.find((c) => c.id === id));
    if (cards.some((c) => !c)) throw new GameError('NO_CARD', '你手里没有这张牌');
    const combo = classifyDdz(cards);
    if (!combo) throw new GameError('ILLEGAL', '无效的牌型');
    // remove played cards
    for (const id of cardIds) hand.splice(hand.findIndex((c) => c.id === id), 1);
    // if table has a play, it must be beaten; else it's a new lead
    if (this.lastPlay && !beatsDdz(combo, this.lastPlay.combo)) {
      // rollback (illegal): restore cards
      hand.push(...cards);
      throw new GameError('ILLEGAL', '打不过上家的牌');
    }
    this.lastPlay = { seat, cards: cards.map((c) => ({ ...c })), combo };
    this.passCount = 0;
    this.last = { kind: 'play', seat, cards: cards.map((c) => c.id), combo: combo.type };

    if (hand.length === 0) {
      this.phase = DDF.PHASE.END;
      this.winner = seat;
      return this.snapshot();
    }
    this.current = (seat + 1) % 3;
    return this.snapshot();
  }

  pass(seat) {
    this.assertPhase(DDF.PHASE.PLAYING);
    if (seat !== this.current) throw new GameError('NOT_YOUR_TURN', '还没轮到你');
    if (!this.lastPlay || this.lastPlay.seat === seat) throw new GameError('ILLEGAL', '本轮首出不能过牌');
    this.last = { kind: 'pass', seat };
    this.passCount += 1;
    if (this.passCount >= this.opts.maxPasses) {
      // everyone passed; the last player leads fresh
      this.current = this.lastPlay.seat;
      this.lastPlay = null;
      this.passCount = 0;
      return this.snapshot();
    }
    this.current = (seat + 1) % 3;
    return this.snapshot();
  }

  assertPhase(p) {
    if (this.phase !== p) throw new GameError('NOT_PLAYING', '当前阶段不可操作');
  }

  // ---- views ----
  snapshot() {
    const my = {
      phase: this.phase,
      landlord: this.landlord,
      current: this.current,
      winner: this.winner,
      playerCount: this.players.length,
      players: this.players.map((p) => ({ id: p.id, name: p.name, handCount: p.hand.length })),
      counts: this.players.map((p) => p.hand.length),
      // Public table: the cards actually played (visible to everyone in 斗地主),
      // plus who played them and the combo type.
      lastPlay: this.lastPlay
        ? { seat: this.lastPlay.seat, combo: this.lastPlay.combo.type, cards: this.lastPlay.cards.map((c) => ({ ...c })) }
        : null,
      last: this.last,
      diPaiCount: this.diPai.length,
      bidScores: this.bidScores.slice(),
      passCount: this.passCount,
    };
    return my;
  }

  viewFor(seat) {
    const snap = this.snapshot();
    snap.you = seat;
    snap.hand = this.players[seat].hand.map((c) => ({ ...c }));
    // do not reveal other players' hands
    return snap;
  }
}

// ---- AI (plays multi-card combos: straights, 连对, 飞机, 三带, bombs) ----
function groupsOf(hand) {
  const m = {};
  for (const c of hand) (m[c.value] = m[c.value] || []).push(c);
  return Object.keys(m).map(Number).sort((a, b) => a - b).map((v) => ({ value: v, cards: m[v] }));
}
function countOf(hand, v) { let n = 0; for (const c of hand) if (c.value === v) n++; return n; }
function idsFromVals(hand, vals, per) {
  const ids = [];
  for (const v of vals) {
    const grp = hand.filter((c) => c.value === v);
    for (let i = 0; i < per && i < grp.length; i++) ids.push(grp[i].id);
  }
  return ids;
}
function playVals(hand, vals, per) {
  return { kind: 'play', cardIds: idsFromVals(hand, vals, per) };
}
// Lowest consecutive run (value <= A) of length >= minLen where each value has >= need copies.
function cardRun(hand, need, minLen) {
  const set = new Set();
  for (const c of hand) if (c.value <= VALUE['A'] && !c.joker && countOf(hand, c.value) >= need) set.add(c.value);
  const vals = [...set].sort((a, b) => a - b);
  let best = null, run = [];
  for (let i = 0; i < vals.length; i++) {
    if (run.length && vals[i] !== run[run.length - 1] + 1) run = [];
    run.push(vals[i]);
    if (run.length >= minLen && (!best || run.length > best.length || (run.length === best.length && run[0] < best[0]))) best = run.slice();
  }
  return best;
}
function nextCards(hand, need, rank, count) {
  const g = groupsOf(hand);
  for (const grp of g) if (grp.value > rank && grp.cards.length >= need) return grp.cards.slice(0, count).map((c) => c.id);
  return null;
}
function trioBeat(hand, target, kick) {
  const g = groupsOf(hand);
  for (const tri of g) {
    if (tri.value > target.rank && tri.cards.length >= 3) {
      if (kick === 1) {
        const k = g.find((x) => x.value !== tri.value);
        if (k) return tri.cards.slice(0, 3).map((c) => c.id).concat([k.cards[0].id]);
      } else {
        const k = g.find((x) => x.value !== tri.value && x.cards.length >= 2);
        if (k) return tri.cards.slice(0, 3).concat(k.cards.slice(0, 2)).map((c) => c.id);
      }
    }
  }
  return null;
}
function runBeat(hand, need, runLen, topRank) {
  runLen = Math.floor(runLen);
  if (runLen < 1) return null;
  const vals = [...new Set(hand.filter((c) => c.value <= VALUE['A'] && !c.joker).map((c) => c.value))]
    .sort((a, b) => a - b).filter((v) => countOf(hand, v) >= need);
  for (let i = 0; i + runLen <= vals.length; i++) {
    const run = vals.slice(i, i + runLen);
    let consec = true;
    for (let j = 1; j < run.length; j++) if (run[j] !== run[j - 1] + 1) { consec = false; break; }
    if (consec && run[run.length - 1] > topRank) return idsFromVals(hand, run, need);
  }
  return null;
}
// 飞机带翅膀：连续三条 + 翅膀（wingPer=1 带单张，=2 带对子）。凑不出合法翅膀就返回 null（宁可 pass）。
function planeBeat(hand, runLen, topRank, wingPer) {
  runLen = Math.floor(runLen);
  if (runLen < 2) return null;
  const tripleVals = [...new Set(hand.filter((c) => c.value <= VALUE['A'] && !c.joker).map((c) => c.value))]
    .sort((a, b) => a - b).filter((v) => countOf(hand, v) >= 3);
  for (let i = 0; i + runLen <= tripleVals.length; i++) {
    const run = tripleVals.slice(i, i + runLen);
    let consec = true;
    for (let j = 1; j < run.length; j++) if (run[j] !== run[j - 1] + 1) { consec = false; break; }
    if (!consec || run[run.length - 1] <= topRank) continue;
    const body = idsFromVals(hand, run, 3);
    if (!wingPer) return body;
    const need = runLen * wingPer;
    const used = new Set(run);
    const pool = groupsOf(hand).filter((g) => !used.has(g.value)).sort((a, b) => a.value - b.value);
    const wings = [];
    if (wingPer === 2) {
      for (const grp of pool) {
        if (grp.cards.length < 2) continue;
        wings.push(grp.cards[0].id, grp.cards[1].id);
        if (wings.length >= need) break;
      }
    } else {
      for (const grp of pool) {
        wings.push(grp.cards[0].id);
        if (wings.length >= need) break;
      }
    }
    if (wings.length === need) return body.concat(wings);
  }
  return null;
}
// 四带二：更大的四条 + 两张单 / 两对。
function fourTwoBeat(hand, topRank, pairMode) {
  const g = groupsOf(hand).sort((a, b) => a.value - b.value);
  for (const quad of g) {
    if (quad.cards.length !== 4 || quad.value <= topRank) continue;
    const others = g.filter((x) => x.value !== quad.value);
    const wings = [];
    if (pairMode) {
      for (const grp of others) {
        if (grp.cards.length < 2) continue;
        wings.push(grp.cards[0].id, grp.cards[1].id);
        if (wings.length === 4) break;
      }
      if (wings.length === 4) return quad.cards.map((c) => c.id).concat(wings);
    } else {
      for (const grp of others) {
        wings.push(grp.cards[0].id);
        if (wings.length === 2) break;
      }
      if (wings.length === 2) return quad.cards.map((c) => c.id).concat(wings);
    }
  }
  return null;
}
function findBeat(hand, target) {
  const t = target.type;
  if (t === 'rocket') return null;
  if (t === 'single') return nextCards(hand, 1, target.rank, 1);
  if (t === 'pair') return nextCards(hand, 2, target.rank, 2);
  if (t === 'triple') return nextCards(hand, 3, target.rank, 3);
  if (t === 'bomb') return nextCards(hand, 4, target.rank, 4);
  if (t === 'trio1') return trioBeat(hand, target, 1);
  if (t === 'trio2') return trioBeat(hand, target, 2);
  if (t === 'straight') return runBeat(hand, 1, target.len, target.rank);
  if (t === 'doubleStraight') return runBeat(hand, 2, target.len / 2, target.rank);
  if (t === 'plane') return runBeat(hand, 3, target.len / 3, target.rank);
  if (t === 'planeSingle') return planeBeat(hand, target.len / 4, target.rank, 1);
  if (t === 'planePair') return planeBeat(hand, target.len / 5, target.rank, 2);
  if (t === 'four2single') return fourTwoBeat(hand, target.rank, false);
  if (t === 'four2pair') return fourTwoBeat(hand, target.rank, true);
  return null;
}
// When leading, shed the best/longest combination (straight > 连对 > 飞机 > 三带…).
function leadMove(hand) {
  let run = cardRun(hand, 1, 5);
  if (run) return playVals(hand, run, 1);       // straight
  run = cardRun(hand, 2, 3);
  if (run) return playVals(hand, run, 2);       // 连对
  run = cardRun(hand, 3, 2);
  if (run) return playVals(hand, run, 3);       // 飞机
  const g = groupsOf(hand);
  const tri = g.find((x) => x.cards.length >= 3);
  if (tri) {
    const one = g.find((x) => x.value !== tri.value);
    if (one) return { kind: 'play', cardIds: tri.cards.slice(0, 3).map((c) => c.id).concat([one.cards[0].id]) };
    const pair = g.find((x) => x.value !== tri.value && x.cards.length >= 2);
    if (pair) return { kind: 'play', cardIds: tri.cards.slice(0, 3).concat(pair.cards.slice(0, 2)).map((c) => c.id) };
    return { kind: 'play', cardIds: tri.cards.slice(0, 3).map((c) => c.id) };
  }
  const pair = g.find((x) => x.cards.length >= 2);
  if (pair) return { kind: 'play', cardIds: pair.cards.slice(0, 2).map((c) => c.id) };
  if (g.length) return { kind: 'play', cardIds: [g[0].cards[0].id] };
  return null;
}

// AI 自查：牌必须都在手上、不重复、能被 classifyDdz 认出、且真的压得住上家。
// 返回 null 表示这个候选不可用（AI 宁可 pass，也绝不发出会让 applyAction 抛错的牌）。
function legalCardIds(game, seat, cardIds) {
  if (!Array.isArray(cardIds) || cardIds.length === 0) return null;
  if (new Set(cardIds).size !== cardIds.length) return null;
  const byId = new Map(game.players[seat].hand.map((c) => [c.id, c]));
  const cards = cardIds.map((id) => byId.get(id));
  if (cards.some((c) => !c)) return null;
  const combo = classifyDdz(cards);
  if (!combo) return null;
  const target = game.lastPlay ? game.lastPlay.combo : null;
  if (target && !beatsDdz(combo, target)) return null;
  return cardIds;
}

export function aiDoudizhu(game, seat) {
  const hand = game.players[seat].hand;
  if (game.phase === DDF.PHASE.BIDDING) {
    const strong = hand.filter((c) => c.value >= VALUE['A']).length +
      Math.floor(hand.filter((c) => hand.filter((x) => x.value === c.value).length === 4).length / 4);
    const score = Math.min(3, strong >= 5 ? 3 : strong >= 3 ? 2 : 1);
    return { kind: 'bid', score };
  }
  if (game.phase !== DDF.PHASE.PLAYING) return null;
  if (game.current !== seat) return null;
  if (game.lastPlay && game.lastPlay.seat === seat) return { kind: 'pass' };

  const target = game.lastPlay ? game.lastPlay.combo : null;
  if (!target) {
    const lead = leadMove(hand);
    const ids = legalCardIds(game, seat, lead && lead.cardIds);
    return ids ? { kind: 'play', cardIds: ids } : { kind: 'play', cardIds: [hand[0].id] };
  }

  // Farmers cooperate: never beat our own farmer teammate's play (only the landlord's).
  if (game.lastPlay.seat !== game.landlord && seat !== game.landlord) return { kind: 'pass' };

  const beat = legalCardIds(game, seat, findBeat(hand, target));
  if (beat) return { kind: 'play', cardIds: beat };
  // last resort: bomb (higher than a bomb target, else any bomb) or rocket
  const g = groupsOf(hand);
  const bomb = g.find((x) => x.value > (target.type === 'bomb' ? target.rank : -1) && x.cards.length === 4);
  if (bomb) {
    const ids = legalCardIds(game, seat, bomb.cards.map((c) => c.id));
    if (ids) return { kind: 'play', cardIds: ids };
  }
  const sj = hand.find((c) => c.rank === 'SJ'), bj = hand.find((c) => c.rank === 'BJ');
  if (target.type !== 'rocket' && sj && bj) {
    const ids = legalCardIds(game, seat, [sj.id, bj.id]);
    if (ids) return { kind: 'play', cardIds: ids };
  }
  return { kind: 'pass' };
}

function groupCounts(hand) {
  const counts = {};
  for (const c of hand) counts[c.value] = (counts[c.value] || 0) + 1;
  return counts;
}

export const RANKS_DDZ = RANKS;
