/**
 * 三个安全缺陷的回归闸门（2026-11-09）：
 *   1. 玩家绕过战争迷雾读敌国数据 —— 战报/事件未投影 + audienceIncludes(null) fail-open
 *   2. 踢人/撤销令牌后旧 MCP 会话仍有效 —— 会话身份只在 initialize 冻结
 *   3. 服务重启后其他账号抢占已有玩家席位 —— 令牌表只在进程内存
 *
 * 跑法：node --experimental-strip-types --test tests/deterministic/security-regression.test.ts
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LlmClient } from '../../src/ai/llm-client.ts';
import type { SeatId } from '../../src/core/state.ts';
import type { DomainEvent } from '../../src/protocol/events.ts';
import { createAuth } from '../../src/server/adapters/auth.ts';
import { createHttpHandler } from '../../src/server/adapters/http.ts';
import { attachWebSocket } from '../../src/server/adapters/ws.ts';
import { createMcpAdapter } from '../../src/server/adapters/mcp.ts';
import { RoomManagerImpl } from '../../src/server/room/manager.ts';
import { UserService } from '../../src/server/users/service.ts';
import {
  projectEventForViewer,
  projectTurnReportForViewer,
  type ReportViewer,
} from '../../src/server/room/report-projection.ts';
import { audienceIncludes } from '../../src/server/store/event-audience.ts';
import type { TurnReport } from '../../src/server/room/types.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const CONFIG_ROOT = join(repoRoot, 'config');
const ADMIN = 'security-regression-admin-0123456789';
const OFF_LLM = new LlmClient({
  baseUrl: 'http://127.0.0.1:1', apiKey: '', model: 'none', provider: 'none',
  timeoutMs: 50, maxRetries: 0, backoffBaseMs: 1, backoffMaxMs: 1,
});

const dirs: string[] = [];
const managers: RoomManagerImpl[] = [];
const servers: Server[] = [];
const closers: Array<() => Promise<void>> = [];
const services: UserService[] = [];

function newManager(dataDir?: string): { m: RoomManagerImpl; dataDir: string } {
  const dir = dataDir ?? mkdtempSync(join(tmpdir(), 'guozhan-sec-'));
  if (!dataDir) dirs.push(dir);
  const m = new RoomManagerImpl({
    dataDir: dir, configRoot: CONFIG_ROOT, scenarioIds: ['warring-states'],
    llm: OFF_LLM, autoAdvice: false,
  });
  managers.push(m);
  return { m, dataDir: dir };
}

after(async () => {
  for (const fn of closers) await fn().catch(() => undefined);
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  for (const svc of services) svc.close();
  for (const m of managers) await m.shutdown().catch(() => undefined);
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* Windows 句柄延迟 */ }
  }
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────
// 缺陷 1：战争迷雾
// ─────────────────────────────────────────────────────────────

function sampleReport(): TurnReport {
  return {
    roomId: 'room-x', turn: 1, stateDigest: 'digest-1',
    orders: [
      { seatId: 'seat_qin', commands: [{ kind: 'develop', regionId: 'r_xianyang' }] },
      { seatId: 'seat_zhao', commands: [{ kind: 'attack', unitId: 'u_zhao_1', targetRegion: 'r_xianyang' }] },
    ],
    baseline: [
      { scope: 'faction:qin', field: 'gold', oldValue: 100, newValue: 130, delta: 30, reason: '税收', source: 'deterministic' },
      { scope: 'faction:zhao', field: 'gold', oldValue: 900, newValue: 940, delta: 40, reason: '税收', source: 'deterministic' },
    ],
    llmDelta: { moraleAdjustments: [{ factionId: 'zhao', delta: 5, reason: '敌军士气' }] },
    violations: [{ path: 'commands[1]', rule: 'anchor', severity: 'warn', action: 'dropped', detail: '赵军调动' }],
    clamps: [
      { scope: 'faction:qin', field: 'food', beforeClamp: 10, afterClamp: 5, limit: 'foodMin:5' },
      { scope: 'faction:zhao', field: 'food', beforeClamp: 999, afterClamp: 800, limit: 'foodMax:800' },
    ],
    events: [
      { type: 'turn_resolved', turn: 1, deltas: [
        { scope: 'faction:qin', field: 'gold', oldValue: 100, newValue: 130, delta: 30, reason: '税收', source: 'deterministic' },
        { scope: 'faction:zhao', field: 'gold', oldValue: 900, newValue: 940, delta: 40, reason: '税收', source: 'deterministic' },
      ], clamps: [], llmApplied: false, stateId: 'digest-2' },
      { type: 'turn_recap', turn: 1, factions: [
        { id: 'qin', name: '秦', regionsBefore: 3, regionsAfter: 3, regionsDelta: 0, goldDelta: 30, foodDelta: 0, moraleDelta: 0, troopsBefore: 5000, troopsAfter: 5000, eliminated: false },
        { id: 'zhao', name: '赵', regionsBefore: 3, regionsAfter: 3, regionsDelta: 0, goldDelta: 40, foodDelta: 0, moraleDelta: 0, troopsBefore: 9000, troopsAfter: 9900, eliminated: false },
      ] },
    ] as unknown as DomainEvent[],
    narratives: { seat_qin: '秦募新卒', seat_zhao: '赵秘密集结' },
    rejected: [{ seatId: 'seat_qin', index: 0, code: 'X', message: '我方' }, { seatId: 'seat_zhao', index: 0, code: 'Y', message: '敌方' }],
    llmApplied: false, resolvedAt: 1,
  };
}

const QIN_VIEWER: ReportViewer = { full: false, factionId: 'qin', seatId: 'seat_qin' };
const FULL_VIEWER: ReportViewer = { full: true, factionId: null, seatId: null };

test('缺陷1-A 战报投影：玩家拿不到敌国精确数值/命令/叙事，观战仍是全知', () => {
  const report = sampleReport();
  const keys = new Set(report.events.map((e) => JSON.stringify(e)));
  const mine = projectTurnReportForViewer(report, QIN_VIEWER, keys, JSON.stringify);

  assert.deepEqual(mine.baseline.map((d) => d.scope), ['faction:qin'], '敌国 baseline 必须被裁掉');
  assert.deepEqual(mine.clamps.map((c) => c.scope), ['faction:qin']);
  assert.deepEqual(mine.orders.map((o) => o.seatId), ['seat_qin'], '敌军命令不得外发');
  assert.deepEqual(Object.keys(mine.narratives), ['seat_qin'], '敌方叙事不得外发');
  assert.deepEqual(mine.rejected.map((r) => r.seatId), ['seat_qin']);
  assert.deepEqual(mine.violations, [], '闸门违规清单含他席命令细节');
  assert.equal(mine.llmDelta, null, 'LLM delta 含他国精确士气调整');
  assert.equal(mine.events.length, 2, '公开事件本身仍应收到（但载荷要裁剪）');

  const resolved = mine.events.find((e) => e.type === 'turn_resolved') as unknown as { deltas: Array<{ scope: string }> };
  assert.deepEqual(resolved.deltas.map((d) => d.scope), ['faction:qin'], 'turn_resolved 不得夹带敌国精确增量');
  const recap = mine.events.find((e) => e.type === 'turn_recap') as unknown as { factions: Array<{ id: string }> };
  assert.deepEqual(recap.factions.map((f) => f.id), ['qin'], 'turn_recap 不得夹带敌国金/粮/兵');

  assert.equal(projectTurnReportForViewer(report, FULL_VIEWER, keys, JSON.stringify), report, '全知分支原样返回');
});

test('缺陷1-B 身份不明 fail-closed：不给任何明细、不给任何事件', () => {
  const report = sampleReport();
  const keys = new Set(report.events.map((e) => JSON.stringify(e)));
  const skeleton = projectTurnReportForViewer(report, { full: false, factionId: null, seatId: null }, keys, JSON.stringify);
  assert.equal(skeleton.baseline.length, 0);
  assert.equal(skeleton.orders.length, 0);
  assert.equal(skeleton.events.length, 0);
  assert.equal(projectEventForViewer(report.events[0]!, { full: false, factionId: null, seatId: null }), null);
});

test('缺陷1-C audienceIncludes(null) 不再放行 owner 事件', () => {
  assert.equal(audienceIncludes(['zhao'], null), false, '未知接收者不得拿到别国 owner 事件');
  assert.equal(audienceIncludes('all', null), true, '公开广播仍可投递');
  assert.equal(audienceIncludes(['zhao'], 'spectator'), true, '显式观战仍全知');
  assert.equal(audienceIncludes(['zhao'], 'zhao'), true);
  assert.equal(audienceIncludes(['zhao'], 'qin'), false);
});

test('缺陷1-D 端到端：HTTP /turns/1 与 MCP get_turn_report 都不泄露敌国基线', async () => {
  const { m } = newManager();
  const room = await m.createRoom({ name: '迷雾回归', scenarioId: 'warring-states', rootSeed: 'fog-seed', humanFactions: ['qin', 'zhao'] });
  const qin = await m.joinRoom(room.roomId, { seatId: 'seat_qin' });
  const zhao = await m.joinRoom(room.roomId, { seatId: 'seat_zhao' });
  await m.resolveTurn(room.roomId);

  const auth = createAuth({ adminToken: ADMIN, origins: [] }, m);
  const mcp = createMcpAdapter({ auth, roomManager: m });
  const svc = new UserService({ dataDir: dirs[dirs.length - 1]! });
  services.push(svc);
  const server = createServer(createHttpHandler({ auth, roomManager: m, userService: svc, mcp, listScenarios: () => [] }));
  const ws = attachWebSocket(server, { auth, roomManager: m });
  servers.push(server);
  closers.push(async () => { await ws.close(); await mcp.closeAll(); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const viaHttp = await fetch(`${base}/api/rooms/${room.roomId}/turns/1`, {
    headers: { Authorization: `Bearer ${qin.token}` },
  });
  assert.equal(viaHttp.status, 200);
  const httpReport = (await viaHttp.json() as { report: TurnReport }).report;
  assert.ok(httpReport.baseline.every((d) => !d.scope.startsWith('faction:zhao')), 'HTTP 战报不得含赵国精确基线');
  assert.ok(httpReport.orders.every((o) => o.seatId === 'seat_qin'), 'HTTP 战报不得含赵国命令');

  const init = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${zhao.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'sec-test', version: '0' } } }),
  });
  const sid = init.headers.get('mcp-session-id');
  assert.ok(sid);
  const call = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${zhao.token}`, 'mcp-session-id': sid },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_turn_report', arguments: { turn: 1 } } }),
  });
  const payload = JSON.parse((await call.text()).replace(/^event:.*\n/s, '').replace(/^data: /m, '')) as { result: { content: Array<{ text: string }> } };
  const mcpReport = JSON.parse(payload.result.content[0]!.text) as TurnReport;
  assert.ok(mcpReport.baseline.every((d) => !d.scope.startsWith('faction:qin')), 'MCP 战报不得含秦国精确基线');
  assert.ok(mcpReport.orders.every((o) => o.seatId === 'seat_zhao'), 'MCP 战报不得含秦国命令');
});

// ─────────────────────────────────────────────────────────────
// 缺陷 2：撤销令牌后 MCP 会话失效
// ─────────────────────────────────────────────────────────────

test('缺陷2 踢人/重签令牌 ⇒ 旧 MCP 会话立即关闭且不能再读写', async () => {
  const { m } = newManager();
  const room = await m.createRoom({ name: '会话撤销', scenarioId: 'warring-states', rootSeed: 'revoke-seed', humanFactions: ['qin'] });
  const qin = await m.joinRoom(room.roomId, { seatId: 'seat_qin' });
  const auth = createAuth({ adminToken: ADMIN, origins: [] }, m);
  const mcp = createMcpAdapter({ auth, roomManager: m });
  const server = createServer(createHttpHandler({ auth, roomManager: m, mcp, listScenarios: () => [] }));
  const ws = attachWebSocket(server, { auth, roomManager: m });
  servers.push(server);
  closers.push(async () => { await ws.close(); await mcp.closeAll(); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${qin.token}` };
  const init = await fetch(`${base}/mcp`, {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'sec-test', version: '0' } } }),
  });
  const sid = init.headers.get('mcp-session-id');
  assert.ok(sid);
  assert.equal(mcp.sessionCount(), 1);

  const callTool = async (id: number): Promise<{ status: number; text: string }> => {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST', headers: { ...headers, 'mcp-session-id': sid },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'get_situation', arguments: {} } }),
    });
    return { status: r.status, text: await r.text() };
  };
  const before = await callTool(2);
  assert.equal(before.status, 200, '撤销前会话应能正常读快照');
  assert.ok(!before.text.includes('SESSION_REVOKED'));

  // 踢人（不切 AI，保持 human 以便同时验 reclaimSeat 路径）
  await m.revokeSeat(room.roomId, 'seat_qin');
  await sleep(30);
  assert.equal(mcp.sessionCount(), 0, '撤销后会话必须被主动关闭（含 SSE 流）');
  const afterRevoke = await callTool(3);
  assert.notEqual(afterRevoke.status, 200, '旧会话不得再读数据');

  // 重签令牌同样要让旧会话失效
  const fresh = await m.joinRoom(room.roomId, { seatId: 'seat_qin' });
  const init2 = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { ...headers, Authorization: `Bearer ${fresh.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'sec-test', version: '0' } } }),
  });
  assert.ok(init2.headers.get('mcp-session-id'));
  assert.equal(mcp.sessionCount(), 1);
  const rotated = await m.reclaimSeat(room.roomId, 'seat_qin');
  assert.ok(rotated);
  await sleep(30);
  assert.equal(mcp.sessionCount(), 0, '重签令牌后旧 MCP 会话也必须关闭');
});

// ─────────────────────────────────────────────────────────────
// 缺陷 3：重启后席位抢占
// ─────────────────────────────────────────────────────────────

test('缺陷3-A 重启后席位仍归原主：令牌可复现，其他账号抢不走', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'guozhan-sec-restart-'));
  dirs.push(dir);
  const { m: m1 } = newManager(dir);
  const room = await m1.createRoom({ name: '重启抢占', scenarioId: 'warring-states', rootSeed: 'hijack-seed', humanFactions: ['qin', 'zhao'] });
  const qin = await m1.joinRoom(room.roomId, { seatId: 'seat_qin' });
  await m1.joinRoom(room.roomId, { seatId: 'seat_zhao' });
  await m1.shutdown();

  const { m: m2 } = newManager(dir);
  const resumed = await m2.resumeSeat(qin.token);
  assert.equal(resumed?.seat.factionId, 'qin', '原席位令牌跨重启必须仍有效（controller 已落库）');
  await assert.rejects(
    () => m2.joinRoom(room.roomId, { seatId: 'seat_qin' }),
    /已被占用/,
    '其他账号不得在重启后抢占已有玩家席位',
  );
  await assert.rejects(
    () => m2.joinRoom(room.roomId, { seatId: 'seat_zhao' }),
    /已被占用/,
  );
});

test('缺陷3-B 账号层：一个席位只能属于一个账号，setMember 不得静默顶替', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guozhan-sec-user-'));
  dirs.push(dir);
  const svc = new UserService({ dataDir: dir });
  services.push(svc);
  const a = svc.register({ username: 'owner_a', password: 'password123' });
  const b = svc.register({ username: 'attacker_b', password: 'password123' });

  svc.setMember('room-x', a.user.id, 'seat_qin');
  assert.equal(svc.getMemberBySeat('room-x', 'seat_qin')?.userId, a.user.id);
  assert.throws(
    () => svc.setMember('room-x', b.user.id, 'seat_qin'),
    (err: unknown) => (err as { code?: string }).code === 'SEAT_OCCUPIED',
    '第二个账号不得把同一席位写进自己的成员关系',
  );
  assert.equal(svc.getMemberBySeat('room-x', 'seat_qin')?.userId, a.user.id, '归属未被改写');
  // 原主自己重签仍允许
  svc.setMember('room-x', a.user.id, 'seat_zhao');
  assert.equal(svc.getMemberBySeat('room-x', 'seat_zhao')?.userId, a.user.id);
  assert.equal(svc.getMemberBySeat('room-x', 'seat_qin'), null);
});
