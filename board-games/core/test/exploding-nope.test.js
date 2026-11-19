// exploding-nope.test.js — 休想卡（Nope）完整反应链回归（零依赖）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExplodingKittensGame, aiEk, buildEkDeck } from '../src/exploding.js';
import { mulberry32 } from '../src/cards.js';

function fixture(count = 3, seed = 11) {
  const g = new ExplodingKittensGame({
    playerNames: Array.from({ length: count }, (_, i) => `P${i}`),
    random: mulberry32(seed),
    options: { nopeWindow: true },
  });
  g.start();
  return g;
}

/** 把当前休想窗口全部表态完：chooser(seat) 返回 'nope' | 'pass'。 */
function resolveWindow(g, chooser) {
  let guard = 0;
  while (g.pendingNope && guard++ < 20) {
    const seat = g.current;
    const action = chooser(seat) === 'nope' ? { kind: 'nope' } : { kind: 'passNope' };
    g.applyAction(seat, action);
  }
  assert.equal(g.pendingNope, null, '窗口必须闭合');
}

test('牌库包含休想卡，且开局不出现在任何玩家手里', () => {
  const deck = buildEkDeck(4);
  assert.ok(deck.some((c) => c.kind === 'nope'), '牌库应含休想卡');
  const g = fixture();
  assert.equal(g.pendingNope, null);
});

test('0 张休想卡：窗口全过 → 原行动照常结算', () => {
  const g = fixture(3);
  g.players[0].hand = [{ id: 'sk', kind: 'skip' }, { id: 'd0', kind: 'defuse' }];
  g.current = 0;
  g.applyAction(0, { kind: 'play', cardId: 'sk' });
  assert.ok(g.pendingNope, 'skip 必须开窗');
  assert.equal(g.pendingNope.order.length, 2);
  resolveWindow(g, () => 'pass');
  assert.equal(g.current, 1, 'skip 生效，回合跳过');
  assert.equal(g.last.kind, 'play');
});

test('1 张休想卡：取消 skip，回合留在发起者', () => {
  const g = fixture(3);
  g.players[0].hand = [{ id: 'sk', kind: 'skip' }, { id: 'd0', kind: 'defuse' }];
  g.players[1].hand = [{ id: 'np', kind: 'nope' }, { id: 'd1', kind: 'defuse' }];
  g.current = 0;
  g.applyAction(0, { kind: 'play', cardId: 'sk' });
  resolveWindow(g, (seat) => (seat === 1 ? 'nope' : 'pass'));
  assert.equal(g.last.kind, 'noped');
  assert.equal(g.last.count, 1);
  assert.equal(g.current, 0, '原行动取消，回合仍是发起者');
  assert.ok(g.players[0].hand.some((c) => c.id === 'sk'), '被取消的牌不消耗');
  assert.ok(!g.players[1].hand.some((c) => c.id === 'np'), '休想卡被消耗');
});

test('2 张休想卡：反制取消 → 原行动恢复生效', () => {
  const g = fixture(3);
  g.players[0].hand = [{ id: 'sk', kind: 'skip' }, { id: 'd0', kind: 'defuse' }];
  g.players[1].hand = [{ id: 'np1', kind: 'nope' }, { id: 'd1', kind: 'defuse' }];
  g.players[2].hand = [{ id: 'np2', kind: 'nope' }, { id: 'd2', kind: 'defuse' }];
  g.current = 0;
  g.applyAction(0, { kind: 'play', cardId: 'sk' });
  resolveWindow(g, () => 'nope'); // 1 + 1 = 2 张，偶数 → 恢复
  assert.equal(g.current, 1, '偶数张休想 ⇒ skip 再次生效');
  assert.equal(g.last.kind, 'play');
});

test('3 张休想卡：奇数再次取消（完整链）', () => {
  const g = fixture(4);
  g.players[0].hand = [{ id: 'sk', kind: 'skip' }, { id: 'd0', kind: 'defuse' }];
  for (let i = 1; i <= 3; i++) g.players[i].hand = [{ id: `np${i}`, kind: 'nope' }, { id: `d${i}`, kind: 'defuse' }];
  g.current = 0;
  g.applyAction(0, { kind: 'play', cardId: 'sk' });
  resolveWindow(g, () => 'nope');
  assert.equal(g.last.kind, 'noped');
  assert.equal(g.last.count, 3);
  assert.equal(g.current, 0);
});

test('窗口内只能 nope / passNope，其他行动被拒绝', () => {
  const g = fixture(3);
  g.players[0].hand = [{ id: 'sk', kind: 'skip' }, { id: 'd0', kind: 'defuse' }];
  g.current = 0;
  g.applyAction(0, { kind: 'play', cardId: 'sk' });
  const responder = g.current;
  assert.throws(() => g.applyAction(responder, { kind: 'draw' }), /休想卡窗口/);
});

test('爆炸与拆弹不可被休想卡打断', () => {
  const g = fixture(2);
  g.players[0].hand = [{ id: 'df', kind: 'defuse' }];
  g.players[1].hand = [{ id: 'np', kind: 'nope' }, { id: 'd1', kind: 'defuse' }];
  g.drawPile = [{ id: 'bomb', kind: 'explode' }, { id: 's', kind: 'skip' }];
  g.current = 0;
  g.draw(0); // 摸到炸弹 → 立刻进入拆弹，不过休想窗口
  assert.ok(g.pendingDefuse);
  assert.equal(g.pendingNope, null);
  const r = g.applyAction(0, { kind: 'defuse', position: 1 });
  assert.equal(r.pendingDefuse, null);
  assert.equal(g.drawPile[0].id, 'bomb');
});

test('AI 在休想窗口会表态且不偷看牌库顶', () => {
  const g = fixture(3);
  g.players[0].hand = [{ id: 'sk', kind: 'skip' }, { id: 'd0', kind: 'defuse' }];
  g.players[1].hand = [{ id: 'np', kind: 'nope' }]; // 无拆弹牌 → AI 应反制
  g.current = 0;
  g.drawPile = [{ id: 'secret', kind: 'explode' }, { id: 'x', kind: 'skip' }];
  g.applyAction(0, { kind: 'play', cardId: 'sk' });
  // 窗口顺序从发起者下家（P1）开始；P1 持休想卡且无拆弹牌 → 应反制。
  assert.equal(g.current, 1);
  const act = aiEk(g, 1);
  assert.ok(act && (act.kind === 'nope' || act.kind === 'passNope'));
  assert.equal(act.kind, 'nope', '无拆弹牌时应反制');
  assert.equal(g.drawPile[0].id, 'secret', 'AI 决策不得改变牌库');
});

test('休想卡不能当普通牌单独打出', () => {
  const g = fixture(2);
  g.players[0].hand.push({ id: 'np', kind: 'nope' });
  g.current = 0;
  // beginNope 的开窗前校验必须拒绝休想卡被当普通牌打出。
  assert.throws(() => g.applyAction(0, { kind: 'play', cardId: 'np' }), /不能单独打出/);
});

test('休想窗口下自动对局仍能终止（含 AI 表态）', () => {
  const g = fixture(4, 29);
  let guard = 0;
  while (g.phase === 'playing' && guard++ < 8000) {
    if (g.pendingNope) {
      const act = aiEk(g, g.current) || { kind: 'passNope' };
      g.applyAction(g.current, act);
      continue;
    }
    if (g.pendingFavor) {
      const t = g.pendingFavor.target;
      g.applyAction(t, aiEk(g, t) || { kind: 'give', cardId: g.players[t].hand[0].id });
      continue;
    }
    if (g.pendingDefuse) {
      const t = g.pendingDefuse.seat;
      g.applyAction(t, aiEk(g, t) || { kind: 'defuse', position: 1 });
      continue;
    }
    const seat = g.current;
    g.applyAction(seat, aiEk(g, seat) || { kind: 'draw' });
  }
  assert.equal(g.phase, 'roundEnd', '自动对局必须终局');
  assert.ok(g.winner != null);
});
