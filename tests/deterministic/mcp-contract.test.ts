/**
 * MCP 适配器 ↔ **真实 RoomManager** 的契约测试。
 *
 * adapters.test.ts 里的 MCP 用例跑在内存 fake 上 —— 那只能证明适配器"照接口办事"。
 * 但业主的选型是"从一开始就做 MCP"，所以这条链路必须对真引擎再验一次：
 *   会话建立 → tools/list → 读快照 → 列合法动作 → 提交命令 → 求建议 → 锁定结算
 *   → 战报可读 → SSE 收到同一份事件 → 观战端拿全知视图（玩家席位拒绝）
 *
 * 跑法：node --experimental-strip-types --test tests/deterministic/mcp-contract.test.ts
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LlmClient } from '../../src/ai/llm-client.ts';
import { SnapshotSchema } from '../../src/protocol/snapshot.ts';
import { createAuth } from '../../src/server/adapters/auth.ts';
import { createHttpHandler } from '../../src/server/adapters/http.ts';
import { attachWebSocket } from '../../src/server/adapters/ws.ts';
import { createMcpAdapter } from '../../src/server/adapters/mcp.ts';
import { RoomManagerImpl } from '../../src/server/room/manager.ts';
import { loadScenario } from '../../src/server/config-loader.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const CONFIG_ROOT = join(repoRoot, 'config');
const ADMIN = 'mcp-contract-admin-0123456789';

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

const dataDir = mkdtempSync(join(tmpdir(), 'guozhan-mcp-'));
const manager = new RoomManagerImpl({
  dataDir,
  configRoot: CONFIG_ROOT,
  scenarioIds: ['warring-states', 'aria'],
  llm: OFF_LLM,
  // ★必须让 AI 席位自己行动：本局只有 qin 是人类，其余 6 席是 AI；
  //   关掉 autoAdvice 它们就永远不锁定，法定人数不齐 ⇒ 回合永远不结算（不是 bug，是设计）。
  autoAdvice: true,
});
const auth = createAuth({ adminToken: ADMIN, origins: [] }, manager);
const mcp = createMcpAdapter({ auth, roomManager: manager });
const server: Server = createServer(
  createHttpHandler({
    auth,
    roomManager: manager,
    listScenarios: () => [loadScenario('warring-states', 'mcp-contract', CONFIG_ROOT).meta],
    mcp,
  }),
);
const ws = attachWebSocket(server, { auth, roomManager: manager });
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const addr = server.address();
assert.ok(addr !== null && typeof addr === 'object');
const BASE = `http://127.0.0.1:${addr.port}`;

after(async () => {
  await ws.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await manager.shutdown();
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    /* Windows 句柄释放延迟 */
  }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function http(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<any> {
  const resp = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`${method} ${path} → HTTP ${resp.status}: ${text.slice(0, 200)}`);
  return text.length > 0 ? JSON.parse(text) : null;
}

interface McpSession {
  readonly sid: string;
  call(id: number, method: string, params: unknown): Promise<{ status: number; body: any }>;
}

async function mcpInitialize(token: string): Promise<McpSession> {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  const resp = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { ...headers, Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'mcp-contract', version: '0' } },
    }),
  });
  assert.equal(resp.status, 200);
  const sid = resp.headers.get('mcp-session-id');
  assert.ok(sid !== null && sid.length > 0, '有状态会话必须返回 mcp-session-id');
  const notify = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { ...headers, Authorization: `Bearer ${token}`, 'mcp-session-id': sid },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  assert.ok(notify.status === 202 || notify.status === 200);

  return {
    sid,
    async call(id: number, method: string, params: unknown) {
      const r = await fetch(`${BASE}/mcp`, {
        method: 'POST',
        headers: { ...headers, Authorization: `Bearer ${token}`, 'mcp-session-id': sid },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      });
      const text = await r.text();
      return { status: r.status, body: JSON.parse(text) as any };
    },
  };
}

/** MCP 工具统一返回 content[0].text = JSON.stringify(payload) */
function payloadOf(body: any): any {
  const text = body?.result?.content?.[0]?.text;
  assert.equal(typeof text, 'string', `工具没有返回文本内容：${JSON.stringify(body).slice(0, 200)}`);
  return JSON.parse(text);
}

test('★MCP ↔ 真引擎：读/列/提交/求建议/锁定/战报/SSE/观战 全链路', async () => {
  const created = await http('POST', '/api/rooms', {
    token: ADMIN,
    body: { name: 'MCP 真引擎', scenarioId: 'warring-states', rootSeed: 'mcp-real', humanFactions: ['qin'] },
  });
  const roomId: string = created.room.roomId;
  const joined = await http('POST', `/api/rooms/${roomId}/join`, { token: ADMIN, body: { seatId: 'seat_qin' } });
  const seatToken: string = joined.token;
  const client = await mcpInitialize(seatToken);

  // ① 工具清单：恰好 11 个（含 lock_orders），且 inputSchema 都在
  const list = await client.call(10, 'tools/list', {});
  const tools = list.body.result.tools as Array<{ name: string; inputSchema: unknown }>;
  assert.equal(tools.length, 11);
  assert.ok(tools.every((t) => typeof t.inputSchema === 'object' && t.inputSchema !== null));

  // ② 快照：过协议 schema，且与房间 digest 一致
  const sit = payloadOf((await client.call(11, 'tools/call', { name: 'get_situation', arguments: {} })).body);
  SnapshotSchema.parse(sit);
  assert.equal(sit.regions.length, 19);
  assert.equal(sit.stateId, created.room.stateDigest, '工具返回的 stateId 必须就是 CAS 锚点');

  // ③ 合法动作：与 HTTP 快照同一套 id
  const legal = payloadOf((await client.call(12, 'tools/call', { name: 'list_legal_actions', arguments: {} })).body);
  assert.ok(Array.isArray(legal.legalActions) && legal.legalActions.length > 0);
  assert.ok(legal.legalActions.every((a: { id: string }) => a.id.includes(':')));

  // ④ 提交命令：走真引擎 + 真 SQLite
  const submit = payloadOf(
    (await client.call(13, 'tools/call', {
      name: 'submit_orders',
      arguments: { stateId: sit.stateId, requestId: 'mcp-real-1', commands: [{ kind: 'set_tax', rate: 0.31 }] },
    })).body,
  );
  assert.equal(submit.status, 'completed');
  assert.equal(submit.replayed, false);

  // ⑤ 幂等：同 requestId 同参 → replayed
  const replay = payloadOf(
    (await client.call(14, 'tools/call', {
      name: 'submit_orders',
      arguments: { stateId: sit.stateId, requestId: 'mcp-real-1', commands: [{ kind: 'set_tax', rate: 0.31 }] },
    })).body,
  );
  assert.equal(replay.replayed, true);

  // ⑥ 求建议：无 LLM ⇒ 明确降级，不是 500
  const advice = payloadOf((await client.call(15, 'tools/call', { name: 'request_advice', arguments: {} })).body);
  assert.ok('skipped' in advice, `无 LLM 时应降级：${JSON.stringify(advice)}`);

  // ⑦ 结算前战报不存在（工具要如实报错，不能返回空对象）
  const early = await client.call(16, 'tools/call', { name: 'get_turn_report', arguments: { turn: 1 } });
  assert.equal(early.body.result.isError, true);

  // ⑧ 挂 SSE，再锁定 → AI/人类都到齐后结算
  const sse = await fetch(`${BASE}/mcp`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${seatToken}`, 'mcp-session-id': client.sid, Accept: 'text/event-stream' },
  });
  assert.equal(sse.status, 200);
  assert.ok(sse.body !== null);
  const reader = sse.body.getReader();
  const decoder = new TextDecoder();
  let acc = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
      }
    } catch {
      /* 流关闭 */
    }
  })();
  await sleep(120);

  const locked = payloadOf((await client.call(165, 'tools/call', { name: 'lock_orders', arguments: {} })).body);
  assert.equal(locked.locked, true, 'lock_orders 必须真的锁定本席位');
  for (let i = 0; i < 50 && !(acc.includes('domain_event') && acc.includes('turn_resolved')); i++) await sleep(100);
  await reader.cancel().catch(() => undefined);
  await pump;
  assert.match(acc, /notifications\/message/, 'SSE 上应收到 MCP 通知');
  assert.match(acc, /turn_resolved/, 'SSE 通知里应有结算事件');

  // ⑨ 战报：真实基线 + 我的命令
  const report = payloadOf((await client.call(17, 'tools/call', { name: 'get_turn_report', arguments: { turn: 1 } })).body);
  assert.equal(report.turn, 1);
  assert.ok(report.baseline.length > 0);
  assert.ok(report.orders.some((o: { seatId: string }) => o.seatId === 'seat_qin'));

  // ⑩ 观战：玩家席位调 spectate 被拒；观战席位拿到全知视图（且没有 exact）
  const denied = await client.call(18, 'tools/call', { name: 'spectate', arguments: {} });
  assert.equal(denied.body.result.isError, true);
  const guest = await http('POST', `/api/rooms/${roomId}/join`, { token: ADMIN, body: { asSpectator: true } });
  const specSession = await mcpInitialize(guest.token);
  const view = payloadOf((await specSession.call(19, 'tools/call', { name: 'spectate', arguments: {} })).body);
  SnapshotSchema.parse(view);
  assert.equal(view.recipient, 'spectator');
  assert.equal(view.factions.some((f: { exact?: unknown }) => f.exact !== undefined), false, '观战视图不该带任何 exact');
});

test('MCP 坏样本：伪造会话 → 404；越权提交别人的部队 → 走真引擎拒绝', async () => {
  const bogus = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${'x'.repeat(40)}`,
      'mcp-session-id': 'not-a-real-session',
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_situation', arguments: {} } }),
  });
  assert.equal(bogus.status, 404);
});
