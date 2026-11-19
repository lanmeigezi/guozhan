// monopoly-expansion.test.js — 大富翁扩充机制回归（拍卖/交易/铁路/公用/破产清算）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MonopolyGame, MONOPOLY_BOARD, CHANCE_CARDS } from '../src/monopoly.js';
import { mulberry32 } from '../src/cards.js';

function make(count = 3, seed = 9) {
  const g = new MonopolyGame({ playerNames: Array.from({ length: count }, (_, i) => `P${i}`), random: mulberry32(seed) });
  g.start();
  return g;
}

/** 走到无主地并放弃 → 开拍卖；全程弃权 → 流拍。 */
function openAuction(g, tileIndex, from = 0) {
  g.current = from;
  g.players[from].pos = tileIndex;
  g.pending = { kind: 'buy', tile: tileIndex };
  return g.applyAction(from, { kind: 'decline' });
}

test('棋盘追加铁路/公用事业但保留 0-23 旧索引', () => {
  assert.equal(MONOPOLY_BOARD.length, 32);
  assert.equal(MONOPOLY_BOARD[6].kind, 'jail');
  assert.equal(MONOPOLY_BOARD[23].name, '兴庆宫');
  assert.equal(MONOPOLY_BOARD[24].kind, 'railroad');
  assert.equal(MONOPOLY_BOARD[25].kind, 'utility');
  assert.equal(MONOPOLY_BOARD.filter((t) => t.kind === 'railroad').length, 4);
  assert.equal(MONOPOLY_BOARD.filter((t) => t.kind === 'utility').length, 2);
  assert.ok(CHANCE_CARDS.length >= 20, '机会卡应扩充到 ≥20 张');
});

test('放弃购买 → 公开拍卖，无人竞价则流拍且回合归发起者', () => {
  const g = make();
  g.extraRollFor = null;
  const r = openAuction(g, 1, 0);
  assert.ok(r.pending?.kind === 'auction');
  assert.ok(g.auction);
  assert.equal(g.auction.tile, 1);
  let guard = 0;
  while (g.pending?.kind === 'auction' && guard++ < 10) g.applyAction(g.current, { kind: 'pass_auction' });
  assert.equal(g.pending, null);
  assert.equal(g.propAt(1).ownerId, null, '流拍保持无主');
  assert.equal(g.current, 0, '回合回到拍卖发起者');
});

test('拍卖价高者得，成交价从买家现金扣除', () => {
  const g = make();
  g.extraRollFor = null;
  openAuction(g, 1, 0);
  // order = [1,2,0]；P1 出价 40，P2 放弃，P0 放弃
  while (g.current !== 1 && g.pending?.kind === 'auction') g.applyAction(g.current, { kind: 'pass_auction' });
  assert.equal(g.current, 1);
  const cashBefore = g.players[1].cash;
  g.applyAction(1, { kind: 'bid', amount: 40 });
  // 轮到 P2 和 P0 都弃权
  let guard = 0;
  while (g.pending?.kind === 'auction' && guard++ < 10) g.applyAction(g.current, { kind: 'pass_auction' });
  assert.equal(g.propAt(1).ownerId, 1);
  assert.equal(g.players[1].cash, cashBefore - 40);
});

test('交易：接受后地产与现金原子互换', () => {
  const g = make();
  g.extraRollFor = null;
  g.propAt(1).ownerId = 0;
  g.propAt(3).ownerId = 1;
  const a0 = g.players[0].cash, b0 = g.players[1].cash;
  g.current = 0;
  g.applyAction(0, { kind: 'offer_trade', targetSeat: 1, giveTile: 1, giveCash: 50, wantTile: 3, wantCash: 20 });
  assert.ok(g.pending?.kind === 'trade');
  assert.equal(g.current, 1);
  g.applyAction(1, { kind: 'accept_trade' });
  assert.equal(g.propAt(1).ownerId, 1);
  assert.equal(g.propAt(3).ownerId, 0);
  assert.equal(g.players[0].cash, a0 - 50 + 20);
  assert.equal(g.players[1].cash, b0 + 50 - 20);
  assert.equal(g.current, 1, '成交后回合推进给下一位');
});

test('交易：拒绝后资产与现金完全不变', () => {
  const g = make();
  g.extraRollFor = null;
  g.propAt(1).ownerId = 0;
  const snap = JSON.stringify({ p: g.properties, cash: g.players.map((p) => p.cash) });
  g.current = 0;
  g.applyAction(0, { kind: 'offer_trade', targetSeat: 1, giveTile: 1, wantCash: 100 });
  g.applyAction(1, { kind: 'decline_trade' });
  assert.equal(JSON.stringify({ p: g.properties, cash: g.players.map((p) => p.cash) }), snap);
});

test('铁路租金随持有数递增 25/50/100/200', () => {
  const g = make(2);
  const tiles = [24, 26, 28, 30];
  for (const t of tiles) g.propAt(t).ownerId = 0;
  const expected = [25, 50, 100, 200];
  tiles.forEach((t, i) => {
    // 每轮重建：只有前 i+1 条铁路归 P0
    tiles.forEach((x, j) => { g.propAt(x).ownerId = j <= i ? 0 : null; });
    assert.equal(g.rentOf(MONOPOLY_BOARD[t], g.propAt(t)), expected[i]);
  });
});

test('公用事业租金 = 骰点 × (1张4 / 2张10)', () => {
  const g = make(2);
  g.roll = { a: 3, b: 4, total: 7, doubles: false };
  g.propAt(25).ownerId = 0;
  assert.equal(g.rentOf(MONOPOLY_BOARD[25], g.propAt(25)), 28);
  g.propAt(29).ownerId = 0;
  assert.equal(g.rentOf(MONOPOLY_BOARD[25], g.propAt(25)), 70);
});

test('破产清算：踩中债主地产且现金不足时，自己的地产转给债主', () => {
  const g = make(2);
  g.extraRollFor = null;
  g.propAt(1).ownerId = 0;
  g.propAt(3).ownerId = 1;
  g.players[1].cash = 0;
  g.players[1].pos = 1;
  g.current = 1;
  g.resolveTile(1);
  assert.equal(g.players[1].bankrupt, true);
  assert.equal(g.propAt(3).ownerId, 0, '破产者的地产转给债主 P0');
});

test('破产清算：直接 payBank 欠债时地产归债主', () => {
  const g = make(2);
  g.propAt(1).ownerId = 0;
  g.players[1].cash = 5;
  g.payBank(g.players[1], 100, 0);
  assert.equal(g.players[1].bankrupt, true);
  assert.equal(g.propAt(1).ownerId, 0, '地产转给债主');
  assert.equal(g.players[0].cash, 1505, '债主收到剩余现金 5');
});

test('机会卡扩充后牌堆覆盖全部卡且不重复', () => {
  const g = make(2);
  assert.equal(g.chanceDeck.length, CHANCE_CARDS.length);
  assert.deepEqual([...g.chanceDeck].sort((a, b) => a - b), CHANCE_CARDS.map((_, i) => i));
});
