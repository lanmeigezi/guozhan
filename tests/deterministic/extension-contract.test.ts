/**
 * 酒馆扩展 ↔ 真实服务端 的**传输契约**测试。
 *
 * 扩展是唯一没法在本机跑起来的部件（要真 SillyTavern）。但它的失败模式不是 DOM，
 * 而是**把线格式猜错**——上一版就错了三处（快照没解包 {snapshot}、WS 路径写成
 * /rooms/:id/events、事件按单条而非批次解析），在酒馆里表现就是"按钮全都没反应"。
 *
 * 所以把传输层抽到 extensions/.../lib/client.js，用真实 RoomManager + 真实 HTTP/WS
 * 适配器跑一遍。它证明：面板发出去的每一个请求，服务端都认。
 *
 * 跑法：node --experimental-strip-types --test tests/deterministic/extension-contract.test.ts
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

import { LlmClient } from '../../src/ai/llm-client.ts';
import { createAuth } from '../../src/server/adapters/auth.ts';
import { createHttpHandler } from '../../src/server/adapters/http.ts';
import { attachWebSocket } from '../../src/server/adapters/ws.ts';
import { createMcpAdapter } from '../../src/server/adapters/mcp.ts';
import { RoomManagerImpl } from '../../src/server/room/manager.ts';
import { loadScenario } from '../../src/server/config-loader.ts';
import { CommandEnvelopeSchema } from '../../src/protocol/commands.ts';
import { MapLayoutSchema } from '../../src/protocol/map-layout.ts';
// @ts-expect-error 扩展是纯 JS，没有类型声明；这里刻意用真实产物而不是复刻一份
import { createGuozhanClient } from '../../extensions/sillytavern-guozhan/lib/client.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const CONFIG_ROOT = join(repoRoot, 'config');
const ADMIN = 'contract-admin-token-0123456789';

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

const dataDir = mkdtempSync(join(tmpdir(), 'guozhan-contract-'));
const manager = new RoomManagerImpl({
  dataDir,
  configRoot: CONFIG_ROOT,
  scenarioIds: ['warring-states', 'aria'],
  llm: OFF_LLM,
  // 默认 true：AI 席位在无 LLM 时走启发式自行动，人类只负责自己那一锁
  autoAdvice: true,
});

const auth = createAuth({ adminToken: ADMIN, origins: [] }, manager);
const mcp = createMcpAdapter({ auth, roomManager: manager });
const server: Server = createServer(
  createHttpHandler({
    auth,
    roomManager: manager,
    listScenarios: () => [loadScenario('warring-states', 'contract-seed', CONFIG_ROOT).meta],
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

async function admin(method: string, path: string, body?: unknown): Promise<any> {
  const resp = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${ADMIN}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`${method} ${path} → HTTP ${resp.status}: ${text.slice(0, 200)}`);
  return text.length > 0 ? JSON.parse(text) : null;
}

test('★酒馆客户端 ↔ 真实服务端：快照/提交/锁定/建议/WS 全链路', async () => {
  // 房间：只有秦是人类，其余 AI（无 LLM ⇒ 启发式自行动）
  const created = await admin('POST', '/api/rooms', {
    name: '契约局',
    scenarioId: 'warring-states',
    rootSeed: 'contract-seed',
    humanFactions: ['qin'],
  });
  const roomId: string = created.room.roomId;
  const joined = await admin('POST', `/api/rooms/${roomId}/join`, { seatId: 'seat_qin' });

  // ★用户只填 origin；/api 由客户端补
  const client = createGuozhanClient({
    baseUrl: BASE,
    token: joined.token,
    roomId,
    seatId: 'seat_qin',
    WebSocketImpl: WebSocket,
  });
  assert.equal(client.apiBase, `${BASE}/api`, '客户端应自动补 /api');

  // ① 快照解包 + CAS 锚点
  const snap = await client.snapshot();
  assert.equal(snap.regions.length, 19);
  assert.ok(snap.legalActions.length > 0, '面板要能拿到合法动作');
  assert.equal(typeof snap.stateId, 'string');
  assert.equal(client.stateId, snap.stateId, '客户端必须把 stateId 存成 CAS 锚点');
  const qin = snap.factions.find((f: { id: string }) => f.id === 'qin');
  assert.ok(qin?.exact, '己方应有精确数值');

  // ①a 静态地图布局：六角坐标与胜负信息分离，连上后拉一次即可
  const layout = await client.layout();
  MapLayoutSchema.parse(layout);
  assert.equal(layout.regions.length, 19, '布局必须覆盖全部 19 区');
  assert.equal(layout.canvas.width > 0 && layout.canvas.height > 0, true);
  assert.match(layout.factionColors['qin'], /^#[0-9a-f]{6}$/);

  // ①b 合法动作（含命令体）：人类 UI 直接提交 action.command，不自己拼规则
  const act = await client.legalActions();
  assert.equal(act.turn, snap.turn);
  assert.equal(act.stateId, snap.stateId, '动作清单必须和快照同一个 stateId');
  assert.ok(act.actions.length > 0, '开局应有合法动作');
  for (const a of act.actions) {
    assert.equal(typeof a.command, 'object', `${a.id} 缺少命令体`);
    assert.equal(a.command.kind, a.kind, '动作声明的 kind 必须与命令体一致（UI 靠它做分类/图标）');
    // 命令体必须能被协议 schema 接受 —— 否则点一下按钮就是一个 400
    assert.equal(CommandEnvelopeSchema.shape.commands.element.safeParse(a.command).success, true);
    // 地图 UI 的"选源格→点目标格"依赖引擎给出的结构化起止区域，不解析 label
    if (a.kind === 'attack' || a.kind === 'move_units') {
      assert.equal(typeof a.sourceRegion, 'string', `${a.id} 缺少 sourceRegion`);
      assert.equal(typeof a.targetRegion, 'string', `${a.id} 缺少 targetRegion`);
      assert.ok(layout.regions.some((r: { id: string }) => r.id === a.sourceRegion));
      assert.ok(layout.regions.some((r: { id: string }) => r.id === a.targetRegion));
    }
  }

  // ② WS 地址必须是 /ws?room=…（不是 /rooms/:id/events）
  assert.match(client.eventsUrl(), /\/ws\?room=/, 'WS 必须走 /ws?room=');
  assert.equal(client.eventsUrl().includes('/rooms/'), false);

  // ③ 先挂事件流，再提交与锁定（避免漏掉结算事件）
  const seen: Array<{ type: string }> = [];
  const stream = client.events({ from: 1, onBatch: (event: { type: string }) => seen.push(event) });
  await sleep(100);

  // ④ 提交命令（幂等键由面板生成）
  const submitted = await client.submit([{ kind: 'set_tax', rate: 0.33 }], `ext-${Date.now()}`);
  assert.equal(submitted.ok, true, `提交应成功：${submitted.text.slice(0, 200)}`);
  assert.equal(submitted.json.status, 'completed');
  assert.equal(submitted.json.replayed, false);

  // ⑤ 锁定（面板此前根本没有这个按钮 ⇒ 回合永远推进不了）
  const locked = await client.lock();
  assert.equal(locked.locked, true);
  assert.ok(Array.isArray(locked.waiting), '要回 waiting 列表，面板才能显示还差谁');

  // ⑥ 等 AI 席位各自锁定并触发结算
  for (let i = 0; i < 60 && !seen.some((e) => e.type === 'turn_resolved'); i++) await sleep(100);
  stream.close();
  assert.ok(
    seen.some((e) => e.type === 'turn_resolved'),
    `WS 必须收到批次里解出来的 turn_resolved（实际收到：${seen.map((e) => e.type).join(',')}）`,
  );

  // ⑦ 战报可读，且人类的命令确实进了结算
  const report = await client.report(1);
  assert.ok(report, '战报必须可读');
  assert.ok(
    report.orders.some((o: { seatId: string }) => o.seatId === 'seat_qin'),
    '人类提交的命令必须出现在战报里',
  );

  // ⑧ 旧 stateId 会被服务端拒绝（面板要能识别并重拉，而不是盲目重发）
  const stale = await client.submit([{ kind: 'set_tax', rate: 0.34 }], `ext-stale-${Date.now()}`);
  assert.equal(stale.status, 409);
  // 线格式里被拒步骤叫 rejections（不是内部 CommandResult 的 steps）
  assert.equal(stale.json.rejections[0].code, 'STALE_REVISION');
});

test('★采纳建议走专用端点：不存在的 adviceId 必须回 404 而不是 200', async () => {
  const created = await admin('POST', '/api/rooms', {
    name: '契约局2',
    scenarioId: 'warring-states',
    rootSeed: 'contract-seed-2',
    humanFactions: ['qin', 'zhao', 'chu', 'qi', 'wei', 'han', 'yan'],
  });
  const roomId: string = created.room.roomId;
  const joined = await admin('POST', `/api/rooms/${roomId}/join`, { seatId: 'seat_qin' });
  const client = createGuozhanClient({
    baseUrl: BASE,
    token: joined.token,
    roomId,
    seatId: 'seat_qin',
    WebSocketImpl: WebSocket,
  });
  await client.snapshot();

  await assert.rejects(() => client.adopt('adv_not_exist'), /HTTP 404/);
});

test('★军师入口：GET 空列表；POST 无 LLM 时明确降级而不是 500', async () => {
  const created = await admin('POST', '/api/rooms', {
    name: '契约局3',
    scenarioId: 'warring-states',
    rootSeed: 'contract-seed-3',
    humanFactions: ['qin', 'zhao', 'chu', 'qi', 'wei', 'han', 'yan'],
  });
  const roomId: string = created.room.roomId;
  const joined = await admin('POST', `/api/rooms/${roomId}/join`, { seatId: 'seat_qin' });
  const client = createGuozhanClient({
    baseUrl: BASE,
    token: joined.token,
    roomId,
    seatId: 'seat_qin',
    WebSocketImpl: WebSocket,
  });
  await client.snapshot();

  const before = await client.pendingAdvice();
  assert.deepEqual(before, [], '尚无建议时必须是空数组（面板据此显示"求军师"）');

  const r = await client.requestAdvice();
  assert.ok('skipped' in r, `无 LLM 时应明确降级而不是抛错：${JSON.stringify(r)}`);
  assert.match(String((r as { skipped: string }).skipped), /heuristic|llm/, '降级原因要说人话');

  const after = await client.pendingAdvice();
  assert.equal(after.length, 0, '启发式降级不产生 AdviceRecord（没有可采纳的军师建议）');

  // 房间不存在 ⇒ 404（而不是静默成功）
  const ghost = createGuozhanClient({
    baseUrl: BASE,
    token: joined.token,
    roomId: 'room-does-not-exist',
    seatId: 'seat_qin',
    WebSocketImpl: WebSocket,
  });
  await assert.rejects(() => ghost.requestAdvice(), /HTTP 40[34]/);
});

test('extension panel ships local visual assets and the hex-map mount', () => {
  const index = readFileSync(join(repoRoot, 'extensions/sillytavern-guozhan/index.js'), 'utf8');
  const css = readFileSync(join(repoRoot, 'extensions/sillytavern-guozhan/panel.css'), 'utf8');
  assert.match(index, /id="guozhan_map_svg"/);
  assert.match(index, /data-gzh-tab="orders"/);
  assert.match(index, /guozhan_action_queue/);
  assert.match(css, /@font-face/);
  assert.match(css, /\.gzh-map-svg/);
  assert.match(css, /\.gzh-action/);
  assert.match(css, /@media \(max-width: 880px\)/);
  assert.match(css, /@media \(max-width: 640px\)/);
  assert.match(css, /@media \(max-width: 420px\)/);
  assert.ok(existsSync(join(repoRoot, 'extensions/sillytavern-guozhan/assets/Cinzel-Variable.ttf')));
  assert.ok(existsSync(join(repoRoot, 'extensions/sillytavern-guozhan/assets/icons/ATTRIBUTION.md')));
  const attribution = readFileSync(join(repoRoot, 'extensions/sillytavern-guozhan/assets/icons/ATTRIBUTION.md'), 'utf8');
  assert.match(attribution, /CC BY 3\.0/);
  assert.match(attribution, /game-icons\.net/);
});

