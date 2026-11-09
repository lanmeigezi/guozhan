// monopoly.test.js — 大富翁规则与 AI 闸门。
//
// 本轮机制扩充后的基线：双数再走（三连入狱）、随机机会卡堆、交保/掷双出狱、
// 抵押赎回、同组连片倍租；同时保留"回合推进/AI 必须收敛/越权不能行动"三条老基线。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MonopolyGame,
  aiMonopoly,
  MONOPOLY_BOARD,
  CHANCE_CARDS,
  JAIL_RULES,
  RENT_RULES,
} from '../src/monopoly.js';
import { mulberry32 } from '../src/cards.js';

function start(names = ['甲', '乙'], seed = 1) {
  const g = new MonopolyGame({ playerNames: names, random: mulberry32(seed) });
  g.start();
  return g;
}

/** 固定骰子序列：[a,b]，用完后重复最后一组 */
function setDice(g, ...pairs) {
  let i = 0;
  g.rollTwo = () => {
    const [a, b] = pairs[Math.min(i, pairs.length - 1)];
    i += 1;
    return { a, b, total: a + b, doubles: a === b };
  };
}

test('大富翁：开局现金、掷骰、买地与回合推进', () => {
  const g = start();
  assert.equal(g.phase, 'playing');
  assert.equal(g.players[0].cash, 1500);

  setDice(g, [1, 2]); // 3 格 → 朱雀街（80 金）
  g.applyAction(0, { kind: 'roll' });
  assert.ok(g.roll && g.roll.total === 3, '快照必须保留骰子点数，UI 靠它做动画');
  const tile = MONOPOLY_BOARD[g.players[0].pos];
  assert.equal(tile.kind, 'property');
  assert.equal(g.pending?.kind, 'buy');

  const cash = g.players[0].cash;
  g.applyAction(0, { kind: 'buy' });
  assert.equal(g.players[0].cash, cash - tile.price);
  assert.equal(g.propAt(tile.i)?.ownerId, 0);
  assert.equal(g.current, 1, '买地后应轮到下一位');
  assert.equal(g.roll.total, 3, '轮到下一位时骰子点数仍保留（供 UI 落点动画）');
});

test('大富翁：同一座位非当前回合不能行动', () => {
  const g = start();
  assert.throws(() => g.applyAction(1, { kind: 'roll' }), (e) => e.code === 'NOT_YOUR_TURN');
});

test('大富翁：掷出双数再走一次，第三次双数直接入狱', () => {
  const g = start();
  setDice(g, [2, 2]); // 每次 +4：先税关，再东市（有 pending 就当场放弃）

  const rollAndClear = () => {
    g.applyAction(0, { kind: 'roll' });
    if (g.pending?.kind === 'buy') g.applyAction(0, { kind: 'decline' });
    else if (g.pending?.kind === 'manage') g.applyAction(0, { kind: 'end' });
  };

  rollAndClear();
  assert.equal(g.current, 0, '双数后仍是同一玩家');
  assert.equal(g.last?.extraRoll, true);
  assert.equal(g.players[0].doublesRun, 1);

  rollAndClear();
  assert.equal(g.current, 0, '第二次双数仍继续');
  assert.equal(g.players[0].doublesRun, 2);

  rollAndClear();
  assert.equal(g.current, 1, '第三次双数罚入监狱并让出回合');
  assert.equal(g.players[0].inJail, 1);
  assert.equal(g.players[0].pos, 6, '入狱格 = 6');
  assert.equal(g.players[0].doublesRun, 0, '入狱后连击计数清零');
});

test('大富翁：机会卡是随机卡堆，抽牌不消耗牌堆', () => {
  const a = start(['甲', '乙'], 11);
  const b = start(['甲', '乙'], 12);
  assert.equal(a.chanceDeck.length, CHANCE_CARDS.length);
  const sorted = [...a.chanceDeck].sort((x, y) => x - y);
  assert.deepEqual(sorted, CHANCE_CARDS.map((_, i) => i), '牌堆必须是 0..n-1 的排列');
  assert.notDeepEqual(a.chanceDeck, b.chanceDeck, '不同种子应洗出不同牌序');

  const top = a.chanceDeck[0];
  const card = a.drawChanceCard();
  assert.equal(card.idx, top, '先抽堆顶');
  assert.ok(CHANCE_CARDS[card.idx]);
  assert.equal(a.chanceDeck.length, CHANCE_CARDS.length, '抽出的卡放回堆底，不永久消耗');
  assert.equal(a.chanceDeck[a.chanceDeck.length - 1], top, '抽出的卡压到堆底');
});

test('大富翁：交保出狱与狱中掷双出狱', () => {
  const g = start();
  g.sendToJail(g.players[0], '测试');
  const cash = g.players[0].cash;
  g.applyAction(0, { kind: 'pay_bail' });
  assert.equal(g.players[0].inJail, 0);
  assert.equal(g.players[0].cash, cash - JAIL_RULES.bail);

  const h = start();
  h.sendToJail(h.players[0], '测试');
  setDice(h, [4, 4]); // 双数：免费出狱并前进 8 格
  h.applyAction(0, { kind: 'roll' });
  assert.equal(h.players[0].inJail, 0);
  assert.equal((6 + 8) % MONOPOLY_BOARD.length, h.players[0].pos);
});

test('大富翁：抵押得半价、抵押地不收租、赎回带手续费', () => {
  const g = start();
  const tile = MONOPOLY_BOARD[1]; // 长安街 60 金
  const prop = g.propAt(1);
  prop.ownerId = 0;
  const cash = g.players[0].cash;
  g.applyAction(0, { kind: 'mortgage', tile: 1 });
  assert.equal(prop.mortgaged, true);
  assert.equal(g.players[0].cash, cash + Math.floor(tile.price / 2));
  assert.equal(g.rentOf(tile, prop), 0, '抵押中不收租');

  // 对手踩到抵押地：不付租金
  g.endTurn(0);
  assert.equal(g.current, 1);
  g.players[1].pos = 23;
  const before = g.players[1].cash;
  setDice(g, [1, 1]); // 23 → 1（经过起点另有 200 薪俸，这里只校验租金没扣）
  g.applyAction(1, { kind: 'roll' });
  assert.ok(g.players[1].cash >= before, '抵押地不应扣租金');
  assert.equal(g.players[0].cash, cash + Math.floor(tile.price / 2), '地主没收到租金');

  // 赎回：地价一半 + 10%
  g.current = 0;
  const pay = g.redeemCost(tile);
  const cash2 = g.players[0].cash;
  g.applyAction(0, { kind: 'redeem', tile: 1 });
  assert.equal(prop.mortgaged, false);
  assert.equal(g.players[0].cash, cash2 - pay);
  assert.equal(pay, Math.ceil(Math.floor(tile.price / 2) * (1 + RENT_RULES.redeemFeeRate)));
});

test('大富翁：同组连片时该组租金翻倍（含建筑）', () => {
  const g = start();
  const [a, b] = [MONOPOLY_BOARD[1], MONOPOLY_BOARD[3]]; // A 组两块
  g.propAt(1).ownerId = 0;
  assert.equal(g.hasGroupMonopoly(0, 'A'), false, '只持一块不算连片');
  g.propAt(3).ownerId = 0;
  assert.equal(g.hasGroupMonopoly(0, 'A'), true);
  assert.equal(g.rentOf(b, g.propAt(3)), b.rent * RENT_RULES.groupMultiplier);
  g.propAt(3).houses = 1;
  assert.equal(g.rentOf(b, g.propAt(3)), b.rent * RENT_RULES.houseMultipliers[1] * RENT_RULES.groupMultiplier);
  g.propAt(1).mortgaged = true;
  assert.equal(g.hasGroupMonopoly(0, 'A'), false, '组内有一块抵押就不算连片');
  assert.equal(g.rentOf(b, g.propAt(3)), b.rent * RENT_RULES.houseMultipliers[1], '连片失效后只剩建筑加成');
  assert.equal(g.rentOf(a, g.propAt(1)), 0, '抵押的那块本身不收租');
});

test('大富翁：AI 能自动推进到结束', () => {
  const g = start(['甲', '乙', '丙'], 7);
  let guard = 0;
  while (g.phase === 'playing' && guard++ < 500) {
    const seat = g.current;
    const act = aiMonopoly(g, seat);
    if (!act) break;
    g.applyAction(seat, act);
  }
  assert.equal(g.phase, 'roundEnd', `未结束，turn=${g.turnCount}`);
  assert.ok(g.winner != null || g.endReason === 'turn_limit');
});
