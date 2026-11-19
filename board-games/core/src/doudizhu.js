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
    this.played = []; // public play history: {seat, values:[...], combo} — 记牌用
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
    // Public memory: every played card is visible in 斗地主. The strengthened AI
    // uses this to count remaining high cards; it never reveals hidden hands.
    this.played.push(...cards.map((c) => ({ seat, value: c.value, rank: c.rank })));
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

// Legacy rule AI: kept as an exported baseline for A/B benchmarks and as the
// last-resort fallback. It plays the first legal combo found, without search.
export function aiDoudizhuLegacy(game, seat) {
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

// ─────────────────────────────────────────────────────────────────────
// 强化 AI：手牌分解搜索 + 记牌 + 残局，零依赖、确定性、不发非法牌。
// 设计要点：
//   1. 所有候选组合都经过 legalCardIds() 复核（同一道闸门，绝不发非法牌）；
//   2. 估值启发式全整数、无随机、无时间依赖 ⇒ 同输入必出同决策；
//   3. 手牌分解用「最少手数」递归 + 记忆化 + 节点预算，预算耗尽回落上界估值；
//   4. 记牌只读 game.played（斗地主出牌本就公开），不看任何隐藏手牌。
// ─────────────────────────────────────────────────────────────────────

// value index: 0..12 = 3..A? 实际 v = index+3 (3..17)；数组长度 15
const VIDX = (v) => v - 3;
const VMAX_I = 14; // value 17 = BJ

function countsOf(hand) {
  const cs = new Array(15).fill(0);
  for (const c of hand) cs[VIDX(c.value)]++;
  return cs;
}
function keyOf(cs) { return cs.join(','); }
function sumOf(cs) { let n = 0; for (const x of cs) n += x; return n; }

/** 枚举一个 count 向量能拆出的牌型（只列代表，用于估值，不用于出牌）。 */
function shapesOf(cs) {
  const out = [];
  // 单 / 对 / 三 / 三带 / 炸弹
  for (let v = 0; v <= VMAX_I; v++) {
    if (cs[v] >= 1) out.push([[v, 1]]);
    if (cs[v] >= 2) out.push([[v, 2]]);
    if (cs[v] >= 3) {
      out.push([[v, 3]]);
      for (let k = 0; k <= VMAX_I; k++) if (k !== v && cs[k] >= 1) { out.push([[v, 3], [k, 1]]); break; }
      for (let k = 0; k <= VMAX_I; k++) if (k !== v && cs[k] >= 2) { out.push([[v, 3], [k, 2]]); break; }
    }
    if (cs[v] === 4) out.push([[v, 4]]);
  }
  // 王炸
  if (cs[13] >= 1 && cs[14] >= 1) out.push([[13, 1], [14, 1]]);
  // 顺子 / 连对 / 飞机（含翅膀，只取最小翅膀代表）
  const runs = (need, minLen, maxV) => {
    for (let v = 0; v <= maxV; v++) {
      if (cs[v] < need) continue;
      let end = v;
      while (end + 1 <= maxV && cs[end + 1] >= need) end++;
      for (let len = minLen; len <= end - v + 1; len++) {
        for (let s = v; s + len - 1 <= end; s++) {
          const body = [];
          for (let i = s; i < s + len; i++) body.push([i, need]);
          out.push(body.map((x) => x.slice()));
          // 翅膀只属于飞机（need=3）：len 个三张配 len 张单 / len 对。
          if (need !== 3) continue;
          const singles = [], pairs = [];
          for (let k = 0; k <= VMAX_I; k++) {
            if (body.some((b) => b[0] === k)) continue;
            if (cs[k] >= 1 && singles.length < len) singles.push([k, 1]);
            if (cs[k] >= 2 && pairs.length < len) pairs.push([k, 2]);
          }
          if (singles.length === len) out.push(body.concat(singles));
          if (pairs.length === len) out.push(body.concat(pairs));
        }
      }
    }
  };
  runs(1, 5, 11); // 顺子到 A（v=14 → idx 11）
  runs(2, 3, 11); // 连对
  runs(3, 2, 11); // 飞机
  // 四带二
  for (let v = 0; v <= VMAX_I; v++) {
    if (cs[v] !== 4) continue;
    const singles = [], pairs = [];
    for (let k = 0; k <= VMAX_I; k++) {
      if (k === v) continue;
      if (cs[k] >= 1 && singles.length < 2) singles.push([k, 1]);
      if (cs[k] >= 2 && pairs.length < 2) pairs.push([k, 2]);
    }
    if (singles.length === 2) out.push([[v, 4]].concat(singles));
    if (pairs.length === 2) out.push([[v, 4]].concat(pairs));
  }
  return out;
}

/** 把牌型代表的 value/count 规格映射成具体手牌 id（取最小 id，稳定）。 */
function idsOfShape(hand, shape) {
  const ids = [];
  for (const [vi, need] of shape) {
    const value = vi + 3;
    let got = 0;
    for (const c of hand) {
      if (c.value !== value || got >= need) continue;
      if (ids.includes(c.id)) continue;
      ids.push(c.id); got++;
    }
    if (got < need) return null;
  }
  return ids;
}

function subtract(cs, shape) {
  const out = cs.slice();
  for (const [v, k] of shape) {
    out[v] -= k;
    if (out[v] < 0) return null;
  }
  return out;
}

/** 最少手数估值：递归拆牌 + 记忆化；节点预算保证最坏情况也有确定上界。 */
function minTurns(cs, memo, budget) {
  const total = sumOf(cs);
  if (total === 0) return 0;
  const key = keyOf(cs);
  if (memo.has(key)) return memo.get(key);
  if (budget.n-- <= 0) return total; // 上界：每张一张一张出
  let best = total;
  for (const shape of shapesOf(cs)) {
    const rest = subtract(cs, shape);
    if (!rest || sumOf(rest) === total) continue;
    const t = 1 + minTurns(rest, memo, budget);
    if (t < best) best = t;
    if (best <= 1) break;
  }
  memo.set(key, best);
  return best;
}

function decompose(hand, budgetN = 20000) {
  const cs = countsOf(hand);
  return { cs, turns: minTurns(cs, new Map(), { n: budgetN }) };
}

/** 已出牌的公开统计：v → 已出现张数（含自己打出的）。 */
function playedCounts(game) {
  const m = new Array(15).fill(0);
  for (const p of game.played || []) {
    const i = VIDX(p.value);
    if (i >= 0 && i <= VMAX_I) m[i]++;
  }
  return m;
}

/** 外部还剩几张比我大的牌（4 张上限 - 已出 - 我手里）。 */
function higherOutside(game, seat, value) {
  const mine = countsOf(game.players[seat].hand);
  const seen = playedCounts(game);
  let n = 0;
  for (let v = value + 1; v <= 17; v++) {
    const i = VIDX(v);
    const total = v >= 16 ? 1 : 4;
    n += Math.max(0, total - seen[i] - mine[i]);
  }
  return n;
}

/** 枚举当前手牌全部合法候选（首出/跟牌统一在此生成，再过 legalCardIds）。 */
function allCandidates(game, seat) {
  const hand = game.players[seat].hand;
  const seen = new Set();
  const out = [];
  for (const shape of shapesOf(countsOf(hand))) {
    const ids = idsOfShape(hand, shape);
    if (!ids || !ids.length) continue;
    const key = ids.slice().sort().join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    const clean = legalCardIds(game, seat, ids);
    if (!clean) continue;
    const combo = classifyDdz(ids.map((id) => hand.find((c) => c.id === id)));
    out.push({ ids: clean, combo });
  }
  return out;
}

/** 跟牌候选：同型更大 + 炸弹/王炸；首出候选：全部。 */
function followCandidates(game, seat, target) {
  return allCandidates(game, seat).filter((x) =>
    !target || beatsDdz(x.combo, target) || x.combo.type === 'bomb' || x.combo.type === 'rocket');
}

/** 打完这手后的剩余手数越少越好；同手数优先多出牌、少浪费大牌/炸弹。 */
function scorePlay(hand, ids, combo, restTurns) {
  const used = new Set(ids);
  const rest = hand.filter((c) => !used.has(c.id));
  const top = combo.rank;
  const waste = used.size && rest.length
    ? rest.filter((c) => c.value > top + 2).length * 0.02
    : 0;
  const bombCost = (combo.type === 'bomb' || combo.type === 'rocket') && rest.length > 4 ? 0.6 : 0;
  // 同手数时优先多出牌：ids 越多扣分越少（不是越多扣分越多）。
  return restTurns - ids.length * 0.01 + waste + bombCost;
}

/** 叫分估值：大牌 + 炸弹 + 手数，整数、可复算。 */
function bidPower(hand) {
  const { turns } = decompose(hand, 8000);
  const cs = countsOf(hand);
  let power = 0;
  for (let v = 10; v <= VMAX_I; v++) power += cs[v]; // J/Q/K/A/2/小王/大王
  for (let v = 0; v <= VMAX_I; v++) if (cs[v] === 4) power += 2;
  if (cs[13] && cs[14]) power += 2;
  return power + Math.max(0, 9 - turns);
}

/**
 * 强化斗地主 AI（导出名保持 aiDoudizhu，Host/LLM 回落都走这里）。
 * 与 aiDoudizhuLegacy 的区别：搜索最少手数、记牌判大、残局优先一手走完。
 */
export function aiDoudizhu(game, seat) {
  const hand = game.players[seat].hand;
  if (game.phase === DDF.PHASE.BIDDING) {
    if (game.current !== seat || game.bidScores[seat] !== null) return null;
    const p = bidPower(hand);
    const maxBid = Math.min(...game.bidScores.filter((s) => s !== null), 3);
    let score = p >= 14 ? 3 : p >= 11 ? 2 : p >= 8 ? 1 : 0;
    // 已有高分叫牌时不必跟到顶，但自己极强仍抢
    if (score <= maxBid && p < 14) score = Math.max(0, score - 1);
    return { kind: 'bid', score };
  }
  if (game.phase !== DDF.PHASE.PLAYING || game.current !== seat) return null;
  if (game.lastPlay && game.lastPlay.seat === seat) return { kind: 'pass' };

  const target = game.lastPlay ? game.lastPlay.combo : null;
  const opponents = game.players
    .map((p, i) => ({ i, n: p.hand.length }))
    .filter((x) => x.i !== seat && (game.landlord === null || game.landlord === x.i || game.landlord === seat));
  const minOpp = opponents.length ? Math.min(...opponents.map((x) => x.n)) : 99;
  const meLandlord = game.landlord === seat;

  // 农民配合：队友（另一农民）压住地主时，除非能一手走完，否则不抢。
  if (!meLandlord && target && game.lastPlay.seat !== game.landlord) {
    const finish = allCandidates(game, seat).find((x) => x.ids.length === hand.length);
    if (finish) return { kind: 'play', cardIds: finish.ids };
    return { kind: 'pass' };
  }

  // 一手走完永远最优（残局）。
  const all = allCandidates(game, seat);
  const finisher = all.find((x) => x.ids.length === hand.length && (!target || beatsDdz(x.combo, target)));
  if (finisher) return { kind: 'play', cardIds: finisher.ids };

  const cands = target ? all.filter((x) => beatsDdz(x.combo, target)) : all;
  if (!cands.length) return { kind: 'pass' };

  const memo = new Map();
  const budget = { n: 20000 };
  let best = null;
  let bestScore = Infinity;
  for (const cand of cands) {
    const used = new Set(cand.ids);
    const rest = hand.filter((c) => !used.has(c.id));
    const turns = rest.length ? minTurns(countsOf(rest), memo, budget) : 0;
    let sc = scorePlay(hand, cand.ids, cand.combo, turns);
    // 对手只剩 1-2 张：必须卡住，绝不轻易 pass；优先用能压住且不留后患的牌。
    if (minOpp <= 2 && target) sc -= 0.4;
    // 记牌：首出单张若外面已无更大牌，等于稳拿一轮（对手少牌时尤其关键）。
    if (!target && cand.combo.type === 'single' && higherOutside(game, seat, cand.combo.rank) === 0) {
      sc -= minOpp <= 3 ? 0.5 : 0.15;
    }
    // 炸弹/王炸：对手还多时留作后手，除非能一手清空或对手要赢了。
    if ((cand.combo.type === 'bomb' || cand.combo.type === 'rocket') &&
        !finisher && minOpp > 3 && rest.length > 4) sc += 1.2;
    // 稳定 tie-break：分数相同按牌 id 字典序，保证确定性。
    if (sc < bestScore - 1e-9 || (Math.abs(sc - bestScore) <= 1e-9 &&
        best && cand.ids.join(',') < best.ids.join(','))) {
      best = cand; bestScore = sc;
    }
  }
  if (!best) return { kind: 'pass' };

  // 跟牌时若唯一能压的是炸弹且局势未紧，则过牌保留（但仍受对手少牌约束）。
  if (target && (best.combo.type === 'bomb' || best.combo.type === 'rocket') &&
      minOpp > 3 && hand.length > 6) {
    const plain = cands.find((x) => x.combo.type !== 'bomb' && x.combo.type !== 'rocket');
    if (!plain) return { kind: 'pass' };
    best = plain;
  }
  const finalIds = legalCardIds(game, seat, best.ids);
  return finalIds ? { kind: 'play', cardIds: finalIds } : { kind: 'pass' };
}

export const RANKS_DDZ = RANKS;
