/**
 * 房间自动循环闸门 —— 「LLM 搭配自动作战人机实现独立国家」这条路的**闭环**测试。
 *
 * 之前只测过"一回合"：AI 席位各锁一次、结算一次。但没人验证过：
 *   · 全 AI 房间会不会**自动一回合接一回合**跑到结局？
 *   · 到了 ended 会不会**真的停住**（最危险的是 kickoff 无限自旋、磁盘被写满）？
 *   · 多个席位同时提交，命令会不会丢？
 *
 * 这三条都是"跑久了才暴露"的问题，用假 LLM/启发式在秒级复现。
 *
 * 变异说明：
 *   · 把 kickoff 里的 `phase === 'ended'` 判断删掉 ⇒ "结束后不再推进"用例会红（而且测试进程会一直转）
 *   · 把 maybeResolve 的 started 闸拿掉 ⇒ 已有用例红
 *   · 让 submitCommands 丢失并发写入 ⇒ 并发用例红
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LlmClient } from '../../src/ai/llm-client.ts';
import { RoomManagerImpl } from '../../src/server/room/manager.ts';
import type { CommandEnvelope } from '../../src/protocol/commands.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const CONFIG_ROOT = join(repoRoot, 'config');

const OFF_LLM = new LlmClient({
  baseUrl: 'http://127.0.0.1:1',
  apiKey: '',
  model: 'none',
  provider: 'none',
  timeoutMs: 50,
  maxRetries: 0,
  backoffBaseMs: 1,
  backoffMaxMs: 1,
});

const dirs: string[] = [];
const managers: RoomManagerImpl[] = [];

function newManager(scenarioIds: readonly string[] = ['warring-states']): RoomManagerImpl {
  const dataDir = mkdtempSync(join(tmpdir(), 'guozhan-loop-'));
  dirs.push(dataDir);
  const m = new RoomManagerImpl({
    dataDir,
    configRoot: CONFIG_ROOT,
    scenarioIds,
    llm: OFF_LLM,
    autoAdvice: true, // ★自动循环的开关
  });
  managers.push(m);
  return m;
}

after(() => {
  for (const m of managers) void m.shutdown();
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* Windows 句柄释放延迟 */
    }
  }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('★全 AI 房间自动跑到结局，并在 ended 后停住', async () => {
  const m = newManager();
  const room = await m.createRoom({
    name: '自动局',
    scenarioId: 'warring-states',
    rootSeed: 'auto-loop-seed',
    humanFactions: [], // 无真人 ⇒ 创建即开局
  });

  let info = await m.getRoom(room.roomId);
  assert.ok(info);
  assert.equal(info!.phase, 'submitting', 'AI-only 房间创建后应立刻进入提交阶段');

  // 给足 40 回合 × 7 席启发式的时间；自迭代会多跑基建/谍报/法令，
  // 并行测试时机器负载高，留 60 秒只验证“最终收敛”，不把它当性能基准。
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    info = await m.getRoom(room.roomId);
    if (info!.phase === 'ended') break;
    await sleep(50);
  }
  assert.equal(info!.phase, 'ended', `60 秒内应跑到结局（当前 turn=${info!.turn}, phase=${info!.phase}）`);
  assert.ok(info!.turn <= info!.maxTurns, `回合数不得超过 maxTurns（${info!.turn}/${info!.maxTurns}）`);
  assert.ok(info!.endReason !== null, '结束时必须给出 endReason');
  assert.ok(
    ['conquest', 'turn_limit', 'resignation', 'draw'].includes(String(info!.endReason)),
    `未知的 endReason：${info!.endReason}`,
  );

  // ★结束后不得再自己推进（自旋会持续写盘）
  const endedTurn = info!.turn;
  const endedDigest = info!.stateDigest;
  await sleep(400);
  const after = await m.getRoom(room.roomId);
  assert.equal(after!.turn, endedTurn, 'ended 之后回合不得再变化');
  assert.equal(after!.stateDigest, endedDigest, 'ended 之后状态不得再变化');
  assert.equal(after!.phase, 'ended');

  // 首回合战报应完整（证明是真的按回合结算，而不是一次性跳到结局）
  const first = await m.getTurnReport(room.roomId, 1);
  assert.ok(first);
  assert.ok(first!.baseline.length > 0, '第 1 回合必须有逐字段基线');
  // 至少打完了 maxTurns 里的大部分回合（战争/征服可能提前结束，turns 必须 > 1）
  assert.ok(endedTurn > 1, `自动循环应至少结算过一回合（endedTurn=${endedTurn}）`);
});

test('★第二模式（六角棋盘 + 水路）全 AI 自动局也能收敛，不被水路死锁', async () => {
  const m = newManager(['iron-front']);
  const room = await m.createRoom({
    name: '铁河自动局',
    scenarioId: 'iron-front',
    rootSeed: 'iron-auto-loop-seed',
    humanFactions: [],
  });
  let info = await m.getRoom(room.roomId);
  assert.ok(info);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    info = await m.getRoom(room.roomId);
    if (info!.phase === 'ended') break;
    await sleep(50);
  }
  assert.equal(info!.phase, 'ended', `60 秒内应跑到结局（当前 turn=${info!.turn}, phase=${info!.phase}）`);
  assert.ok(info!.turn > 1, '至少应结算过一回合');
  const report = await m.getTurnReport(room.roomId, 1);
  assert.ok(report && report.baseline.length > 0, '第 1 回合应有逐字段基线');
});

test('★随机地图全 AI 自动局也能收敛（种子地图不造成死锁）', async () => {
  const m = newManager(['random-front']);
  const room = await m.createRoom({
    name: '随机自动局',
    scenarioId: 'random-front',
    rootSeed: 'random-auto-seed',
    humanFactions: [],
  });
  let info = await m.getRoom(room.roomId);
  assert.ok(info);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    info = await m.getRoom(room.roomId);
    if (info!.phase === 'ended') break;
    await sleep(50);
  }
  assert.equal(info!.phase, 'ended', `随机地图 30 秒内应跑完（当前 turn=${info!.turn}, phase=${info!.phase}）`);
  assert.ok(info!.turn > 1, '至少应结算过一回合');
  const layout = await m.getMapLayout(room.roomId);
  assert.equal(layout.kind, 'hexboard');
  assert.ok((layout.waterCells?.length ?? 0) > 0, '随机地图应有水域');
});

test('并发提交：两个席位同时下命令，谁都不丢', async () => {
  const m = newManager();
  // 两个真人席位 + 其余 AI：把 autoAdvice 关掉，避免 AI 抢在断言前结算
  const room = await m.createRoom({
    name: '并发局',
    scenarioId: 'warring-states',
    rootSeed: 'concurrent-seed',
    humanFactions: ['qin', 'zhao'],
  });
  const qin = await m.joinRoom(room.roomId, { seatId: 'seat_qin' });
  const zhao = await m.joinRoom(room.roomId, { seatId: 'seat_zhao' });
  const digest = (await m.getRoom(room.roomId))!.stateDigest;

  const env = (requestId: string, rate: number): CommandEnvelope => ({
    stateId: digest,
    requestId,
    commands: [{ kind: 'set_tax', rate }],
  });

  const [a, b] = await Promise.all([
    m.submitCommands({
      principal: { roomId: room.roomId, seatId: 'seat_qin', kind: 'human', factionId: 'qin', readOnly: false },
      envelope: env('conc-qin', 0.31),
    }),
    m.submitCommands({
      principal: { roomId: room.roomId, seatId: 'seat_zhao', kind: 'human', factionId: 'zhao', readOnly: false },
      envelope: env('conc-zhao', 0.44),
    }),
  ]);
  assert.equal(a.status, 'completed');
  assert.equal(b.status, 'completed');

  const report = await m.resolveTurn(room.roomId);
  const seats = report.orders.map((o) => o.seatId).sort();
  assert.ok(seats.includes('seat_qin'), '秦的命令必须入队');
  assert.ok(seats.includes('seat_zhao'), '赵的命令必须入队');
  assert.equal(report.orders.length, 2, `只应有两个席位的命令（实际：${seats.join(',')}）`);

  // 两个税率都应生效：各自的税率写进了各势力状态
  const state = await m.getState(room.roomId);
  assert.equal(state!.state.factions['qin']!.taxRate, 0.31);
  assert.equal(state!.state.factions['zhao']!.taxRate, 0.44);
});
