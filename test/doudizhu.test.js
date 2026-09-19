// liarsbar.test.js was handled separately; this file is doudizhu.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DoudizhuGame, aiDoudizhu, buildDdzDeck, classifyDdz as classify, beatsDdz as beats } from '../src/games/doudizhu.js';
import { mulberry32 } from '../src/engine/cards.js';

const D = buildDdzDeck();
function byRank(r) { return D.filter((c) => c.rank === r); }
function pick(ranks) {
  // ranks like ['3','3','4'] -> real card objects (distinct ids per copy)
  const used = {};
  const out = [];
  for (const r of ranks) {
    const arr = byRank(r);
    const k = used[r] || 0;
    out.push(arr[k % arr.length]);
    used[r] = k + 1;
  }
  return out;
}

const c = (ranks) => classify(pick(ranks));

test('deck has 54 cards (13*4 + 2 jokers)', () => {
  assert.equal(buildDdzDeck().length, 54);
});

test('classify basic combinations', () => {
  assert.equal(c(['5']).type, 'single');
  assert.equal(c(['5']).rank, 5); // '3'..'2' map to 3..15
  assert.equal(c(['5', '5']).type, 'pair');
  assert.equal(c(['5', '5', '5']).type, 'triple');
  assert.equal(c(['5', '5', '5', '9']).type, 'trio1');
  assert.equal(c(['5', '5', '5', '9', '9']).type, 'trio2');
  assert.equal(c(['3', '4', '5', '6', '7']).type, 'straight');
  assert.equal(c(['3', '3', '4', '4', '5', '5']).type, 'doubleStraight');
  assert.equal(c(['6', '6', '6', '7', '7', '7']).type, 'plane');
  assert.equal(c(['9', '9', '9', '9']).type, 'bomb');
  assert.equal(c(['SJ', 'BJ']).type, 'rocket');
});

test('invalid combinations are rejected', () => {
  assert.equal(classify(pick(['5', '9'])), null); // not a pair
  assert.equal(classify(pick(['3', '4', '5', '6'])), null); // straight too short
});

test('beats: bomb beats single, rocket beats bomb, bigger beats smaller', () => {
  assert.ok(beats(c(['9', '9', '9', '9']), c(['5'])));
  assert.ok(beats(c(['SJ', 'BJ']), c(['9', '9', '9', '9'])));
  assert.ok(beats(c(['K', 'K', 'K', 'K']), c(['9', '9', '9', '9'])));
  assert.ok(!beats(c(['9', '9', '9', '9']), c(['K', 'K', 'K', 'K'])));
  assert.ok(beats(c(['8']), c(['6'])));
  assert.ok(!beats(c(['6']), c(['8'])));
});

test('start deals 17 each, 3 diPai, and ends in bidding', () => {
  const g = new DoudizhuGame({ playerNames: ['A', 'B', 'C'], random: mulberry32(5) });
  const snap = g.start();
  assert.equal(snap.phase, 'bidding');
  assert.equal(snap.counts.join(','), '17,17,17');
  assert.equal(snap.diPaiCount, 3);
  assert.equal(g.n, 3);
});

test('bidding assigns a landlord who gets the 3 diPai and plays first', () => {
  const g = new DoudizhuGame({ playerNames: ['A', 'B', 'C'], random: mulberry32(7) });
  g.start();
  g.applyAction(0, { kind: 'bid', score: 3 });
  g.applyAction(1, { kind: 'bid', score: 0 });
  const snap = g.applyAction(2, { kind: 'bid', score: 0 });
  assert.equal(snap.landlord, 0);
  assert.equal(snap.phase, 'playing');
  assert.equal(snap.current, 0);
  assert.equal(g.players[0].hand.length, 20); // 17 + 3 diPai
});

test('a legal play advances the turn; beating a higher card is rejected', () => {
  const g = new DoudizhuGame({ playerNames: ['A', 'B', 'C'], random: mulberry32(11) });
  g.start();
  g.applyAction(0, { kind: 'bid', score: 1 });
  g.applyAction(1, { kind: 'bid', score: 0 });
  g.applyAction(2, { kind: 'bid', score: 0 });
  const p0 = g.players[0];
  const single = p0.hand[0];
  const r = g.applyAction(0, { kind: 'play', cardIds: [single.id] });
  assert.equal(r.phase, 'playing');
  assert.equal(g.current, 1);
  // wrong turn
  assert.throws(() => g.applyAction(2, { kind: 'play', cardIds: [g.players[2].hand[0].id] }));
});

test('AI sheds a multi-card straight when it leads with one', () => {
  const g = new DoudizhuGame({ playerNames: ['A', 'B', 'C'], random: mulberry32(1) });
  g.start();
  const deck = buildDdzDeck();
  const pick = (r, i) => deck.filter((c) => c.rank === r)[i || 0];
  g.players[0].hand = [pick('3'), pick('4'), pick('5'), pick('6'), pick('7'), pick('9', 0), pick('9', 1), pick('A')];
  g.phase = 'playing'; g.current = 0; g.landlord = 0; g.lastPlay = null;
  const mv = aiDoudizhu(g, 0);
  assert.equal(mv.kind, 'play');
  assert.ok(mv.cardIds.length >= 5, 'played multiple cards, not just a single');
  const combo = classify(mv.cardIds.map((id) => g.players[0].hand.find((c) => c.id === id)));
  assert.equal(combo.type, 'straight');
});
