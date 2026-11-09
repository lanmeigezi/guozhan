// liarsbar.test.js was handled separately; this file is doudizhu.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DoudizhuGame, aiDoudizhu, buildDdzDeck, classifyDdz as classify, beatsDdz as beats } from '../src/doudizhu.js';
import { mulberry32 } from '../src/cards.js';

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

// ── 回归：AI 跟"顺子/连对/飞机/四带二"必须真出牌，不能把牌组对象塞进 cardIds 把 bot 循环打死 ──
function freshGame() {
  const pool = buildDdzDeck().slice();
  const g = new DoudizhuGame({ playerNames: ['AI', '地主', '农民'], random: mulberry32(7) });
  g.start();
  const take = (spec) => {
    const out = [];
    for (const [rank, count] of spec) {
      let got = 0;
      for (let i = 0; i < pool.length && got < count;) {
        if (String(pool[i].rank) === String(rank)) { out.push(pool[i]); pool.splice(i, 1); got++; } else i++;
      }
      assert.equal(got, count, `牌堆里缺 ${count} 张 ${rank}`);
    }
    return out;
  };
  return { g, take };
}

function tableVsHand(tableSpec, handSpec) {
  const { g, take } = freshGame();
  const table = take(tableSpec);
  const hand = take(handSpec);
  g.players[0].hand = hand;
  g.players[1].hand = take([['3', 1], ['4', 1]]);
  g.players[2].hand = take([['Q', 1]]);
  g.phase = 'playing';
  g.landlord = 1;
  g.current = 0;
  g.lastPlay = { seat: 1, cards: table.map((c) => ({ ...c })), combo: classify(table) };
  assert.ok(g.lastPlay.combo, '桌面牌型必须可识别');
  return { g, hand };
}

const BEAT_CASES = [
  ['straight', [['5', 1], ['6', 1], ['7', 1], ['8', 1], ['9', 1]], [['6', 1], ['7', 1], ['8', 1], ['9', 1], ['10', 1], ['K', 2]]],
  ['doubleStraight', [['5', 2], ['6', 2], ['7', 2]], [['6', 2], ['7', 2], ['8', 2], ['K', 1]]],
  ['plane', [['4', 3], ['5', 3]], [['6', 3], ['7', 3], ['9', 1]]],
  ['planeSingle', [['4', 3], ['5', 3], ['9', 1], ['10', 1]], [['6', 3], ['7', 3], ['K', 1], ['A', 1]]],
  ['planePair', [['4', 3], ['5', 3], ['9', 2], ['10', 2]], [['6', 3], ['7', 3], ['K', 2], ['A', 2]]],
  ['four2single', [['8', 4], ['3', 1], ['4', 1]], [['10', 4], ['5', 1], ['6', 1]]],
  ['four2pair', [['8', 4], ['3', 2], ['4', 2]], [['10', 4], ['5', 2], ['6', 2]]],
];

for (const [type, tableSpec, handSpec] of BEAT_CASES) {
  test(`AI 跟牌可压 ${type}（cardIds 必须是数组且 applyAction 不抛错）`, () => {
    const { g, hand } = tableVsHand(tableSpec, handSpec);
    const mv = aiDoudizhu(g, 0);
    assert.equal(mv.kind, 'play', `${type} 应能压过`);
    assert.ok(Array.isArray(mv.cardIds), 'cardIds 必须是 id 数组');
    const before = hand.length;
    g.applyAction(0, mv);
    assert.equal(g.players[0].hand.length, before - mv.cardIds.length);
    assert.equal(g.lastPlay.combo.type, type);
  });
}

test('AI 打不过时老实 pass，不硬出非法牌', () => {
  const { g } = tableVsHand(
    [['8', 1], ['9', 1], ['10', 1], ['J', 1], ['Q', 1], ['K', 1], ['A', 1]],
    [['3', 1], ['J', 1]],
  );
  const mv = aiDoudizhu(g, 0);
  assert.equal(mv.kind, 'pass');
  g.applyAction(0, mv);
  assert.equal(g.passCount, 1);
});

test('AI 输出全牌型模糊自检：要么 pass 要么是合法牌，绝不抛错', () => {
  const shapes = {
    single: [['7', 1]], pair: [['7', 2]], triple: [['7', 3]],
    trio1: [['7', 3], ['9', 1]], trio2: [['7', 3], ['9', 2]],
    straight: [['5', 1], ['6', 1], ['7', 1], ['8', 1], ['9', 1]],
    doubleStraight: [['5', 2], ['6', 2], ['7', 2]],
    plane: [['5', 3], ['6', 3]],
    planeSingle: [['5', 3], ['6', 3], ['9', 1], ['10', 1]],
    planePair: [['5', 3], ['6', 3], ['9', 2], ['10', 2]],
    four2single: [['8', 4], ['3', 1], ['4', 1]],
    four2pair: [['8', 4], ['3', 2], ['4', 2]],
    bomb: [['8', 4]], rocket: [['SJ', 1], ['BJ', 1]],
  };
  const rng = mulberry32(20261107);
  for (const [type, spec] of Object.entries(shapes)) {
    for (let i = 0; i < 120; i++) {
      const { g, take } = freshGame();
      const table = take(spec);
      assert.equal(classify(table).type, type, `构造 ${type} 失败`);
      const all = buildDdzDeck();
      const handSize = 1 + Math.floor(rng() * 16);
      const shuffled = all.slice().sort(() => rng() - 0.5);
      const hand = shuffled.filter((c) => !table.includes(c)).slice(0, handSize);
      g.players[0].hand = hand;
      g.phase = 'playing';
      g.landlord = 1;
      g.current = 0;
      g.lastPlay = { seat: 1, cards: table.map((c) => ({ ...c })), combo: classify(table) };
      const mv = aiDoudizhu(g, 0);
      if (mv === null || mv.kind === 'pass') continue;
      assert.equal(mv.kind, 'play');
      assert.ok(Array.isArray(mv.cardIds), `${type} 第 ${i} 轮：cardIds 不是数组`);
      g.applyAction(0, mv); // 非法会在这里抛错
    }
  }
});
