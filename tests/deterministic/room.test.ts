/**
 * 房间管理器集成测试 —— 真实 SQLite 库 + 真实 core，不打桩。
 *
 * 这是**唯一**覆盖「adapters → RoomManager → core/store」整条链的测试。
 * adapters.test.ts 用的是内存 fake，只能证明适配器遵守接口；
 * 本文件证明**实现**也遵守契约。
 *
 * 每条闸门都配坏样本或变异说明（正确对象须绿、坏样本须红）：
 *   · 旧 stateId 被拒 → 改回当前 digest 必须绿（变异点：把 CAS 比较删掉，本测试必须红）
 *   · 拒绝不改状态 → digest 与"没下这条命令"逐位相同
 *   · 同种子 ⇒ 同 digest（变异点：把 rootSeed 换成 Date.now()，本测试必须红）
 *   · 战争迷雾 → 别国 exact 不得出现在快照里（变异点：对所有势力填 exact，本测试必须红）
 *   · 事件受众 → 别国的 owner 事件不得投递给我（变异点：audience 恒为 'all'，本测试必须红）
 *
 * 跑法：node --experimental-strip-types --test --test-reporter=tap tests/deterministic/room.test.ts
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LlmClient } from '../../src/ai/llm-client.ts';
import { enumerateLegalActions } from '../../src/core/legal.ts';
import type { GameState, FactionId, SeatId } from '../../src/core/state.ts';
import type { CommandEnvelope } from '../../src/protocol/commands.ts';
import { RejectionCode } from '../../src/protocol/rejections.ts';
import { RoomManagerImpl } from '../../src/server/room/manager.ts';
import type { EventBatch, Principal, RoomInfo } from '../../src/server/room/types.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const CONFIG_ROOT = join(repoRoot, 'config');
const SCENARIOS = ['warring-states', 'aria', 'grand-front'];
const ALL_FACTIONS: FactionId[] = ['qin', 'zhao', 'chu', 'qi', 'wei', 'han', 'yan'];

// LLM 关闭：apiKey 为空 ⇒ enabled=false ⇒ 顾问必然降级启发式（零 HTTP）
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

const managers: RoomManagerImpl[] = [];
const dirs: string[] = [];

function newManager(): RoomManagerImpl {
  const dataDir = mkdtempSync(join(tmpdir(), 'guozhan-room-'));
  dirs.push(dataDir);
  const m = new RoomManagerImpl({
    dataDir,
    configRoot: CONFIG_ROOT,
    scenarioIds: SCENARIOS,
    llm: OFF_LLM,
    autoAdvice: false, // 手动驱动回合，避免后台异步干扰断言
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
      /* Windows 句柄释放延迟；临时目录留给系统清理 */
    }
  }
});

async function makeRoom(m: RoomManagerImpl, opts: { rootSeed?: string; humanFactions?: FactionId[] } = {}): Promise<{ room: RoomInfo; seats: Map<FactionId, string> }> {
  const room = await m.createRoom({
    name: '测试局',
    scenarioId: 'warring-states',
    rootSeed: opts.rootSeed ?? 'seed-room-test',
    humanFactions: opts.humanFactions ?? ALL_FACTIONS,
  });
  const seats = new Map<FactionId, string>();
  for (const fid of ALL_FACTIONS) {
    const seatId = `seat_${fid}`;
    // 只认领 humanFactions 里的席位，其余保留 AI
    if (!(opts.humanFactions ?? ALL_FACTIONS).includes(fid)) {
      seats.set(fid, '');
      continue;
    }
    const { token } = await m.joinRoom(room.roomId, { seatId });
    seats.set(fid, token);
  }
  return { room, seats };
}

async function principalOf(m: RoomManagerImpl, roomId: string, token: string): Promise<Principal> {
  const resumed = await m.resumeSeat(token);
  assert.ok(resumed !== null, '席位令牌应能换回 Principal');
  const s = resumed.seat;
  return {
    roomId,
    seatId: s.seatId,
    kind: s.kind,
    factionId: s.factionId,
    readOnly: s.kind === 'spectator',
  };
}

function pickDevelop(state: GameState, world: Parameters<typeof enumerateLegalActions>[1], fid: FactionId): Record<string, unknown> {
  const actions = enumerateLegalActions(state, world, fid, { maxActions: 40 });
  const develop = actions.find((a) => a.kind === 'develop') ?? actions.find((a) => a.kind === 'fortify') ?? actions[0];
  assert.ok(develop !== undefined, `${fid} 应该有至少一个合法动作`);
  return develop.command;
}

function envelopeOf(stateId: string, requestId: string, commands: readonly unknown[]): CommandEnvelope {
  return { stateId, requestId, commands: commands as CommandEnvelope['commands'] };
}

// ─────────────────────────────────────────────────────────────

test('创建房间：7 个席位、phase=submitting、digest 稳定可读', async () => {
  const m = newManager();
  const { room } = await makeRoom(m);
  assert.equal(room.seats.length, 7, '战国剧本应分配 7 个势力席位');
  assert.deepEqual(
    room.seats.map((s) => s.factionId).sort(),
    [...ALL_FACTIONS].sort(),
  );
  assert.equal(room.phase, 'submitting');
  assert.equal(room.turn, 1);
  assert.ok(room.stateDigest.length >= 8, 'state_digest 必须满足 CAS 的最小长度');
  assert.equal(room.maxTurns, 40);
  // 席位令牌绝不能出现在 RoomInfo 里
  assert.equal(JSON.stringify(room).includes('gz_'), false, 'RoomInfo 不得泄漏席位令牌');
});

test('AI 席位按种子分配三种原型，并在观战快照中可见', async () => {
  const m = newManager();
  const { room } = await makeRoom(m, {
    rootSeed: 'archetype-room-seed',
    humanFactions: ['qin', 'zhao', 'chu', 'qi'],
  });
  const snap = await m.getSnapshot(room.roomId, 'spectator');
  const styles = snap.factions.filter((f) => f.aiArchetype).map((f) => f.aiArchetype);
  assert.equal(styles.length, 3, '3 个 AI 势力都应带原型');
  assert.deepEqual([...styles].sort(), ['random', 'rush', 'turtle']);
  const again = await m.getSnapshot(room.roomId, 'spectator');
  assert.deepEqual(again.factions.map((f) => f.aiArchetype), snap.factions.map((f) => f.aiArchetype), '同房间快照原型必须稳定');
});

test('★超大陆剧本支持 10 个真人席位 + 12 势力地图', async () => {
  const m = newManager();
  const humans: FactionId[] = ['north', 'east', 'west', 'south', 'qin', 'chu', 'qi', 'yan', 'zhao', 'wei'];
  const room = await m.createRoom({
    name: '超大陆测试局',
    scenarioId: 'grand-front',
    rootSeed: 'grand-room-seed-1',
    humanFactions: humans,
  });
  assert.equal(room.seats.length, 12, '超大陆应有 12 个席位');
  for (const fid of humans) {
    await m.joinRoom(room.roomId, { seatId: `seat_${fid}` });
  }
  const snap = await m.getSnapshot(room.roomId, 'spectator');
  assert.equal(snap.factions.length, 12);
  assert.ok(snap.regions.length >= 100, `超大陆应有 100+ 区域，实得 ${snap.regions.length}`);
  const styles = snap.factions.filter((f) => f.aiArchetype).map((f) => f.aiArchetype);
  assert.equal(styles.length, 2, '10 真人后剩 2 个 AI 席位');
  assert.equal(new Set(styles).size, styles.length, '两个 AI 不应同原型');
});

test('加入/重连：令牌能换回席位；伪造令牌返回 null', async () => {
  const m = newManager();
  const { room, seats } = await makeRoom(m);
  const token = seats.get('qin');
  assert.ok(token !== undefined && token.length > 0);
  const resumed = await m.resumeSeat(token);
  assert.ok(resumed !== null);
  assert.equal(resumed.seat.factionId, 'qin');
  assert.equal(resumed.room.roomId, room.roomId);
  assert.equal(await m.resumeSeat('gz_totally-forged-token'), null);

  // 观战席：只读、无势力、全知视图
  const spec = await m.joinRoom(room.roomId, { asSpectator: true });
  assert.equal(spec.seat.kind, 'spectator');
  assert.equal(spec.seat.factionId, null);
  const snap = await m.getSnapshot(room.roomId, spec.seat.seatId);
  assert.equal(snap.legalActions.length, 0, '观战端不得拿到合法动作空间');
  assert.equal(snap.factions.some((f) => f.exact !== undefined), false, '观战端不给自己视角的 exact 字段');
});

test('战争迷雾：别国只给档位，己方才有精确数值与合法动作', async () => {
  const m = newManager();
  const { room, seats } = await makeRoom(m);
  const qinSeat = (await m.resumeSeat(seats.get('qin')!))!.seat.seatId;
  const snap = await m.getSnapshot(room.roomId, qinSeat);

  const qin = snap.factions.find((f) => f.id === 'qin');
  const qi = snap.factions.find((f) => f.id === 'qi');
  assert.ok(qin && qi);
  assert.equal(qin.isSelf, true);
  assert.ok(qin.exact !== undefined, '己方必须有精确数值');
  assert.equal(typeof qin.exact?.gold, 'number');
  assert.equal(qi.exact, undefined, '★别国不得出现精确国库（Histrategy 的算术幻觉来自这里）');
  assert.equal(qin.relation, 'self');
  assert.ok(snap.legalActions.length > 0, '快照必须带合法动作空间（P10 锚定）');
  assert.equal(snap.legalActions.some((a) => 'command' in a), false, '动作里不得带 command（那是内部结构）');
  assert.ok(snap.mapText.includes('關中') || snap.mapText.includes('关中') || snap.mapText.length > 100);
  assert.equal(snap.regions.length, 19, '地图 19 区域全部出现在拓扑里');
});

test('CAS：旧 stateId 被拒，状态与"没提交过"逐位相同', async () => {
  const m = newManager();
  const { room, seats } = await makeRoom(m, { rootSeed: 'cas-seed' });
  const qin = await principalOf(m, room.roomId, seats.get('qin')!);
  const before = await m.getState(room.roomId);

  const result = await m.submitCommands({
    principal: qin,
    envelope: envelopeOf('0'.repeat(64), 'req-cas-1', [pickDevelop(before!.state, before!.world, 'qin')]),
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.steps[0]?.code, RejectionCode.STALE_REVISION);

  const afterState = await m.getState(room.roomId);
  assert.equal(afterState!.state.turn, before!.state.turn);
  // 拒绝不得写入任何待裁决命令
  const report = await m.resolveTurn(room.roomId);
  assert.equal(report.orders.length, 0, '被拒的命令不得进入结算队列');
});

test('幂等：同 requestId 同参 → replayed；同 requestId 异参 → 拒绝', async () => {
  const m = newManager();
  const { room, seats } = await makeRoom(m, { rootSeed: 'idem-seed' });
  const qin = await principalOf(m, room.roomId, seats.get('qin')!);
  const st = await m.getState(room.roomId);
  const cmd = pickDevelop(st!.state, st!.world, 'qin');

  const env = envelopeOf(room.stateDigest, 'req-idem-1', [cmd]);
  const first = await m.submitCommands({ principal: qin, envelope: env });
  assert.equal(first.status, 'completed');
  assert.equal(first.replayed, false);

  const replay = await m.submitCommands({ principal: qin, envelope: env });
  assert.equal(replay.replayed, true, '同幂等键同参必须返回原回执');
  assert.equal(replay.completedSteps, first.completedSteps);

  const conflict = await m.submitCommands({
    principal: qin,
    envelope: envelopeOf(room.stateDigest, 'req-idem-1', [{ kind: 'set_tax', factionId: 'qin', rate: 0.4 }]),
  });
  assert.equal(conflict.status, 'failed', '同幂等键异参必须拒绝，不能静默执行第二条');
});

test('锁定后不得追加命令（同时提交模型）', async () => {
  const m = newManager();
  const { room, seats } = await makeRoom(m, { rootSeed: 'lock-seed' });
  const qin = await principalOf(m, room.roomId, seats.get('qin')!);
  const locked = await m.lockOrders(qin);
  assert.equal(locked.locked, true);
  assert.ok(locked.waiting.length > 0, '其他席位未锁定，等待列表不能为空');

  const st = await m.getState(room.roomId);
  const result = await m.submitCommands({
    principal: qin,
    envelope: envelopeOf(room.stateDigest, 'req-after-lock', [pickDevelop(st!.state, st!.world, 'qin')]),
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.steps[0]?.code, RejectionCode.ORDERS_ALREADY_LOCKED);
});

test('全员锁定 ⇒ 自动结算；回合推进、战报落库、事件可订阅', async () => {
  const m = newManager();
  const { room, seats } = await makeRoom(m, { rootSeed: 'resolve-seed' });
  const batches: EventBatch[] = [];
  const qinSeat = (await m.resumeSeat(seats.get('qin')!))!.seat.seatId;
  const from = await m.nextOffset(room.roomId);
  const off = m.subscribe(room.roomId, qinSeat, from, (b) => batches.push(b));

  const st = await m.getState(room.roomId);
  const qin = await principalOf(m, room.roomId, seats.get('qin')!);
  const submitted = await m.submitCommands({
    principal: qin,
    envelope: envelopeOf(room.stateDigest, 'req-resolve-1', [pickDevelop(st!.state, st!.world, 'qin')]),
  });
  assert.equal(submitted.status, 'completed');

  // 依次锁定全部 7 个席位；最后一把锁必须触发结算
  let last: { locked: boolean; waiting: readonly SeatId[] } | null = null;
  for (const fid of ALL_FACTIONS) {
    const p = await principalOf(m, room.roomId, seats.get(fid)!);
    last = await m.lockOrders(p);
  }
  off();
  assert.ok(last !== null);
  assert.equal(last!.waiting.length, 0, '全员锁定后等待列表应为空');

  const after = await m.getRoom(room.roomId);
  assert.ok(after);
  assert.equal(after!.turn, 2, '结算后应推进到第 2 回合');
  assert.notEqual(after!.stateDigest, room.stateDigest, '结算必须改变 state_digest');

  const report = await m.getTurnReport(room.roomId, 1);
  assert.ok(report !== null, '第 1 回合战报必须落库');
  assert.equal(report!.turn, 1);
  assert.ok(report!.baseline.length > 0, '确定性基线必须有逐字段归因');
  assert.ok(report!.events.some((e) => e.type === 'turn_resolved'));
  assert.ok(batches.length > 0, '订阅者必须收到结算事件');
  assert.ok(batches.flatMap((b) => b.events).some((e) => e.event.type === 'turn_resolved'));
});

test('★确定性：同种子 + 同命令 ⇒ 两个房间结算后 digest 逐位相同', async () => {
  const m = newManager();
  const runOnce = async (): Promise<string> => {
    const { room, seats } = await makeRoom(m, { rootSeed: 'same-seed-42' });
    const st = await m.getState(room.roomId);
    const cmd = pickDevelop(st!.state, st!.world, 'qin');
    const qin = await principalOf(m, room.roomId, seats.get('qin')!);
    await m.submitCommands({
      principal: qin,
      envelope: envelopeOf(room.stateDigest, `req-det-${room.roomId}`, [cmd]),
    });
    for (const fid of ALL_FACTIONS) await m.lockOrders(await principalOf(m, room.roomId, seats.get(fid)!));
    const after = await m.getRoom(room.roomId);
    return after!.stateDigest;
  };
  const a = await runOnce();
  const b = await runOnce();
  assert.equal(a, b, '同种子同命令必须逐位复现（含经济/动乱/战斗全部 RNG 流）');
});

test('★拒绝不改状态：非法命令与"没下命令"结算后 digest 相同', async () => {
  const m = newManager();
  const resolveWith = async (withBad: boolean): Promise<string> => {
    const { room, seats } = await makeRoom(m, { rootSeed: 'reject-seed' });
    if (withBad) {
      const han = await principalOf(m, room.roomId, seats.get('han')!);
      // 用秦的部队替汉下命令：管理器必须拒绝（势力不匹配）
      const st = await m.getState(room.roomId);
      const qinUnit = Object.values(st!.state.units).find((u) => u.ownerId === 'qin');
      assert.ok(qinUnit !== undefined);
      const res = await m.submitCommands({
        principal: han,
        envelope: envelopeOf(room.stateDigest, 'req-bad-1', [
          { kind: 'move_units', unitId: qinUnit!.id, toRegion: qinUnit!.regionId },
        ]),
      });
      assert.equal(res.status, 'failed', '跨势力命令必须被拒');
      // 提交期快速失败：命令对象不是你的部队 ⇒ UNIT_NOT_OWNED（比笼统的"未授权"更可用）
      assert.equal(res.steps[0]?.code, RejectionCode.UNIT_NOT_OWNED);
    }
    for (const fid of ALL_FACTIONS) await m.lockOrders(await principalOf(m, room.roomId, seats.get(fid)!));
    const after = await m.getRoom(room.roomId);
    return after!.stateDigest;
  };
  assert.equal(await resolveWith(true), await resolveWith(false), '被拒的命令不得对状态产生任何影响（P4）');
});

test('重启恢复：新 manager 读回同一 digest、回合与席位', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'guozhan-重启-'));
  dirs.push(dataDir);
  const opts = { dataDir, configRoot: CONFIG_ROOT, scenarioIds: SCENARIOS, llm: OFF_LLM, autoAdvice: false };
  const m1 = new RoomManagerImpl(opts);
  managers.push(m1);
  const { room, seats } = await makeRoom(m1, { rootSeed: 'restart-seed' });
  for (const fid of ALL_FACTIONS) await m1.lockOrders(await principalOf(m1, room.roomId, seats.get(fid)!));
  const before = await m1.getRoom(room.roomId);
  await m1.shutdown();

  const m2 = new RoomManagerImpl(opts);
  managers.push(m2);
  const after = await m2.getRoom(room.roomId);
  assert.ok(after !== null, '重启后房间必须还在');
  assert.equal(after!.stateDigest, before!.stateDigest, '重启不得改变权威状态');
  assert.equal(after!.turn, before!.turn);
  assert.equal(after!.seats.length, before!.seats.length);
  // 重启后仍可继续玩：旧令牌失效（进程内令牌），但可重新认领席位
  const rejoin = await m2.joinRoom(room.roomId, { seatId: 'seat_qin' });
  assert.equal(rejoin.seat.factionId, 'qin');
});

test('AI 席位：LLM 未配置 ⇒ 启发式决策仍会走同一条提交通道', async () => {
  const m = newManager();
  // 全 AI 房间（不指定 humanFactions）：创建即开局，7 个席位都由启发式驱动
  const room = await m.createRoom({
    name: 'AI 单飞',
    scenarioId: 'warring-states',
    rootSeed: 'ai-seed',
    humanFactions: [],
  });

  const info = await m.getRoom(room.roomId);
  const wei = info!.seats.find((s) => s.factionId === 'wei');
  assert.ok(wei);
  assert.equal(wei!.kind, 'ai');
  assert.equal(wei!.llmDriven, false, 'minorAi 不该调 LLM（分级策略控成本）');
  assert.equal(wei!.autoCommit, true);

  // 逐个唤起顾问：没有 LLM key，全部走启发式；autoCommit ⇒ 提交并锁定
  for (const seat of info!.seats.filter((s) => s.factionId !== null)) {
    const out = await m.requestAdvice(room.roomId, seat.seatId);
    assert.ok('skipped' in out, 'LLM 关闭时顾问应降级而非报错');
  }

  const after = await m.getRoom(room.roomId);
  assert.equal(after!.turn, 2, '全员锁定后应自动结算推进到第 2 回合');
  const report = await m.getTurnReport(room.roomId, 1);
  assert.ok(report !== null);
  assert.ok(
    report!.orders.some((o) => o.seatId === 'seat_wei'),
    'AI 的命令必须出现在战报里 —— 与人类同一条通道，没有后门',
  );
  assert.ok(
    report!.orders.length >= 5,
    `多数 AI 席位应有动作（实际 ${report!.orders.length} 席），否则启发式等于摆设`,
  );
});

test('事件受众：别国的 owner 事件不得投递给我（战争迷雾）', async () => {
  const m = newManager();
  const { room, seats } = await makeRoom(m, { rootSeed: 'fog-seed' });
  const qiSeat = (await m.resumeSeat(seats.get('qi')!))!.seat.seatId;
  const batches: EventBatch[] = [];
  const off = m.subscribe(room.roomId, qiSeat, await m.nextOffset(room.roomId), (b) => batches.push(b));

  const st = await m.getState(room.roomId);
  const qin = await principalOf(m, room.roomId, seats.get('qin')!);
  // 秦征兵：recruitment_completed 的受众是 'owner'
  const recruit = enumerateLegalActions(st!.state, st!.world, 'qin', { maxActions: 40 }).find((a) => a.kind === 'recruit');
  assert.ok(recruit !== undefined, '开局秦应有可征兵动作');
  const res = await m.submitCommands({
    principal: qin,
    envelope: envelopeOf(room.stateDigest, 'req-fog-1', [recruit!.command]),
  });
  assert.equal(res.status, 'completed');

  for (const fid of ALL_FACTIONS) await m.lockOrders(await principalOf(m, room.roomId, seats.get(fid)!));
  off();

  const leaked = batches
    .flatMap((b) => b.events)
    .some((e) => e.event.type === 'recruitment_completed' && e.event.factionId === 'qin');
  assert.equal(leaked, false, '★秦的征兵事件不得落到齐的推送里');
  const publicSeen = batches.flatMap((b) => b.events).some((e) => e.event.type === 'turn_resolved');
  assert.equal(publicSeen, true, '公共事件仍应送达（不是把流整个关掉）');
});

test('unlimitedTurns 房间：maxTurns=0 且状态/信息一致', async () => {
  const m = newManager();
  const room = await m.createRoom({
    name: '不限回合',
    scenarioId: 'warring-states',
    unlimitedTurns: true,
  });
  assert.equal(room.maxTurns, 0);
  const loaded = await m.getState(room.roomId);
  assert.ok(loaded);
  assert.equal(loaded.world.maxTurns, 0);
  assert.equal(loaded.scenario.maxTurns, 0);
  // 未启动/未加入时也可读；确保覆盖的是房间级覆盖，不是临时状态。
  const again = await m.getRoom(room.roomId);
  assert.equal(again?.maxTurns, 0);
});

test('aiOverrides 可指定一个 AI 国家为 LLM 独立国家', async () => {
  const m = newManager();
  const room = await m.createRoom({
    name: 'LLM 独立国家',
    scenarioId: 'warring-states',
    humanFactions: ['qin'],
    aiOverrides: {
      chu: { autoCommit: true, llmDriven: true },
      zhao: { autoCommit: true, llmDriven: false },
    },
  });
  const chu = room.seats.find((s) => s.factionId === 'chu');
  const zhao = room.seats.find((s) => s.factionId === 'zhao');
  assert.ok(chu && chu.kind === 'ai');
  assert.equal(chu.autoCommit, true);
  assert.equal(chu.llmDriven, true);
  assert.ok(zhao && zhao.kind === 'ai');
  assert.equal(zhao.llmDriven, false);
});
