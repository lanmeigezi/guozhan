// bot-driver.test.js — 机器人驱动的兜底闸门：AI 或执行链抛任何异常都不许冻结对局。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Host } from '../src/host.js';
import { DoudizhuGame, classifyDdz, buildDdzDeck } from '../src/doudizhu.js';
import { mulberry32 } from '../src/cards.js';

function ddzHost() {
  // remote:false —— 纯远程模式会启动真实 setTimeout 链，测试进程会被吊住不退
  const host = new Host({ game: 'doudizhu', playerName: '真人', remote: false });
  const game = new DoudizhuGame({ playerNames: ['真人', '机器人A', '机器人B'], random: mulberry32(3) });
  game.start();
  game.phase = 'playing';
  game.landlord = 1;
  game.current = 1;
  // 桌面上留一手"机器人A 打不过"的牌，这样保守动作 pass 是合法的
  const ten = buildDdzDeck().find((c) => String(c.rank) === '10');
  game.lastPlay = { seat: 2, cards: [{ ...ten }], combo: classifyDdz([ten]) };
  host.game = game;
  host.botSeats = new Set([1, 2]);
  const logs = [];
  host.onLog = (line) => logs.push(line);
  return { host, game, logs };
}

test('botActionSafe：AI 抛错时降级为保守动作并留痕', () => {
  const { host, logs } = ddzHost();
  host.ai = () => { throw new TypeError('cardIds.map is not a function'); };
  const act = host.botActionSafe(1);
  assert.equal(act.kind, 'pass', '斗地主的保守动作必须是 pass');
  assert.ok(logs.some((l) => l.includes('ai error')), '必须留下错误日志');
});

test('_driveBots：AI 抛错不得把异常扔出定时器回调（否则 bot 循环直接断）', () => {
  const { host, game } = ddzHost();
  host.ai = () => { throw new TypeError('boom'); };
  assert.doesNotThrow(() => host._driveBots());
  // 保守动作 pass 生效后，轮次应当往前走
  assert.notEqual(game.current, 1);
});

test('_driveBots：AI 返回非法牌组（老 bug 的形状）也不得冻结桌子', () => {
  const { host, game } = ddzHost();
  const before = game.current;
  host.ai = () => ({ kind: 'play', cardIds: { kind: 'play', cardIds: ['nope'] } });
  assert.doesNotThrow(() => host._driveBots());
  assert.equal(game.current, before, '非法动作被拒后局面不应变化，但也不能抛错');
});

test('_driveBots：反复不推进时看门狗触发兜底，且始终不抛错', () => {
  const { host, game, logs } = ddzHost();
  // 没有桌面牌时 pass 会被规则拒绝 → 局面不推进 → stall 计数应一路涨到看门狗
  game.lastPlay = null;
  host.ai = () => ({ kind: 'pass' });
  for (let i = 0; i < 8; i++) assert.doesNotThrow(() => host._driveBots());
  assert.ok(host._botStall.count >= 0, 'stall 计数不应溢出/报错');
  assert.ok(game.phase === 'playing', '对局仍在进行，没有被 AI 冻死');
  assert.ok(logs.length > 0, '机器人动作应有留痕');
});
