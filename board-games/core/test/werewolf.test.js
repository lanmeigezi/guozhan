// werewolf.test.js — 狼人杀完整流程、私密视图与 AI 闸门。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WerewolfGame, aiWerewolf } from '../src/werewolf.js';
import { mulberry32 } from '../src/cards.js';

function start(names = ['甲', '乙', '丙', '丁', '戊', '己'], seed = 3) {
  const g = new WerewolfGame({ playerNames: names, random: mulberry32(seed) });
  g.start();
  return g;
}

test('狼人杀：6 人身份分布、私有视图与狼队友', () => {
  const g = start();
  assert.equal(g.phase, 'playing');
  const roles = g.players.map((p) => p.role);
  assert.equal(roles.filter((r) => r === 'wolf').length, 2);
  assert.equal(roles.filter((r) => r === 'seer').length, 1);
  assert.equal(roles.filter((r) => r === 'witch').length, 1);
  const wolfSeat = g.players.find((p) => p.role === 'wolf').id;
  const villagerSeat = g.players.find((p) => p.role === 'villager').id;
  const wolfView = g.viewFor(wolfSeat);
  const villagerView = g.viewFor(villagerSeat);
  assert.equal(wolfView.role, 'wolf');
  assert.ok(wolfView.teammates.length === 1);
  assert.equal(villagerView.role, 'villager');
  assert.equal(villagerView.teammates.length, 0);
  // 存活玩家的公开视图不暴露身份
  assert.ok(wolfView.players.every((p) => p.id === wolfSeat || p.role === null));
  assert.equal(villagerView.players.find((p) => p.id === wolfSeat).role, null);
});

test('狼人杀：预言家查验结果只给预言家', () => {
  const g = start();
  const seer = g.players.find((p) => p.role === 'seer');
  // 推进到预言家行动（狼人先过）
  let guard = 0;
  while (g.stage === 'night' && g.current !== seer.id && guard++ < 10) {
    const seat = g.current;
    g.applyAction(seat, { kind: 'pass' });
  }
  assert.equal(g.current, seer.id);
  const target = g.players.find((p) => p.id !== seer.id && p.alive);
  g.applyAction(seer.id, { kind: 'inspect', targetSeat: target.id });
  assert.equal(g.viewFor(seer.id).seerKnowledge[target.id], target.role);
  const other = g.players.find((p) => p.id !== seer.id && p.id !== target.id);
  assert.deepEqual(g.viewFor(other.id).seerKnowledge, {});
});

test('狼人杀：AI 能完成一整局并产生胜方', () => {
  const g = start(undefined, 9);
  let guard = 0;
  while (g.phase === 'playing' && guard++ < 2000) {
    const seat = g.current;
    const act = aiWerewolf(g, seat);
    if (!act) { g.applyAction(seat, { kind: 'pass' }); continue; }
    g.applyAction(seat, act);
  }
  assert.equal(g.phase, 'roundEnd', `未结束：stage=${g.stage}, guard=${guard}`);
  assert.ok(['wolves', 'village'].includes(g.winnerTeam));
});
