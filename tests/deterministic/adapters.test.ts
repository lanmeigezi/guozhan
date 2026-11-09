/**
 * 适配器层测试 —— HTTP / WS / MCP + 鉴权 + 拒绝码映射 + 三件套语义。
 *
 * ★RoomManager 用内存 fake（实现 room/types.ts 接口契约）：
 *   适配器只依赖接口编程，本测试因此可先于房间线实现独立验收。
 *
 * 每条闸门都配坏样本对照（正确对象须绿、坏样本须红）：
 *   无令牌/错令牌 401 vs 正确令牌 200；坏 Origin 403 vs 白名单 200；
 *   3MB 请求体 413 vs 小请求体 201；信封多余字段 400 vs 合法信封 200；
 *   REJECTION_HTTP_STATUS **全表遍历**逐码断言；同 requestId 重放 replayed:true；
 *   旧 stateId 409 vs 新 stateId 200；WS 坏令牌拒绝升级 vs 好令牌补发；
 *   MCP 多余字段 -32602 vs 合法调用 200；无状态对照（strip 的 unknownKeys!=='strict'）。
 *
 * 跑法：node --experimental-strip-types --test --test-reporter=tap tests/deterministic/adapters.test.ts
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server as HttpServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { WebSocket } from 'ws';

import {
  ALL_REJECTION_CODES,
  REJECTION_HTTP_STATUS,
  RejectionCode,
} from '../../src/protocol/rejections.ts';
import { SnapshotSchema } from '../../src/protocol/snapshot.ts';
import { MapLayoutSchema, type MapLayout } from '../../src/protocol/map-layout.ts';
import { UserService } from '../../src/server/users/service.ts';
import type { DomainEvent } from '../../src/protocol/events.ts';
import type { CommandEnvelope, CommandResult } from '../../src/protocol/commands.ts';
import type {
  EventBatch,
  Principal,
  RoomInfo,
  RoomManager,
  SeatId,
  SeatInfo,
  TurnReport,
  Unsubscribe,
} from '../../src/server/room/types.ts';
import type { ScenarioMeta } from '../../src/server/config-loader.ts';
import type { GameState, WorldConfig } from '../../src/core/state.ts';
import type { AdviceRecord } from '../../src/protocol/advice.ts';
import type { SanitizedLlmDelta } from '../../src/core/apply.ts';
import type { LegalAction } from '../../src/core/legal.ts';
import type { FactionId } from '../../src/core/state.ts';
import { createAuth, generateToken, safeTokenEqual } from '../../src/server/adapters/auth.ts';
import { createHttpHandler, httpStatusForResult, toWireResult } from '../../src/server/adapters/http.ts';
import { attachWebSocket } from '../../src/server/adapters/ws.ts';
import {
  createMcpAdapter,
  MCP_INSTRUCTIONS,
  MCP_TOOLS,
  SESSION_ID_GENERATOR,
} from '../../src/server/adapters/mcp.ts';

// ─────────────────────────────────────────────────────────────
// 内存 fake RoomManager（只认 room/types.ts 接口契约）
// ─────────────────────────────────────────────────────────────

function makeSnapshotFixture(): z.infer<typeof SnapshotSchema> {
  return {
    recipient: 'qin',
    turn: 1,
    phase: 'submitting',
    stateId: 'digest-1',
    regions: [
      { id: 'r_handan', name: '邯郸', owner: 'zhao', ownerName: '赵', visibility: 'partial' },
      { id: 'r_xianyang', name: '咸阳', owner: 'qin', ownerName: '秦', visibility: 'full' },
      { id: 'r_far', name: '远郊', owner: null, ownerName: null, visibility: 'unknown' },
    ],
    factions: [
      {
        id: 'qin', name: '秦', isSelf: true, relation: 'self', regionCount: 3,
        goldTier: 'moderate', foodTier: 'adequate', morale: 70, armyTier: 'field_army', eliminated: false,
      },
      {
        id: 'zhao', name: '赵', isSelf: false, relation: 'war', regionCount: 2,
        goldTier: 'poor', foodTier: 'low', morale: 55, armyTier: 'garrison', eliminated: false,
      },
    ],
    alerts: [{ id: 'BORDER_EXPOSED', priority: 2, message: '边境兵力不足' }],
    legalActions: [
      { id: 'attack:u_qin_1:r_handan', kind: 'attack', label: '以 u_qin_1 进攻邯郸', estimate: { powerRatio: 1.3, expectedTurns: 1 } },
      { id: 'set_tax:qin', kind: 'set_tax', label: '调整税率' },
    ],
    mapText: '咸阳-秦 * 邯郸-赵',
    budget: { tokenUsed: 0, tokenCap: 200000 },
  };
}

const SNAPSHOT_FIXTURE = makeSnapshotFixture();

function makeTurnReport(roomId: string, turn: number): TurnReport {
  return {
    roomId,
    turn,
    stateDigest: 'digest-1',
    orders: [],
    baseline: [],
    llmDelta: null,
    violations: [],
    clamps: [],
    events: [],
    narratives: {},
    rejected: [],
    llmApplied: false,
    resolvedAt: 0,
  };
}

interface SubEntry {
  readonly recipient: SeatId | 'spectator';
  readonly fromOffset: number;
  readonly sink: (batch: EventBatch) => void;
}

class FakeRoomManager implements RoomManager {
  private rooms = new Map<string, { info: RoomInfo; digestSeq: number }>();
  private seatsByRoom = new Map<string, Map<string, SeatInfo>>();
  private tokenIndex = new Map<string, { roomId: string; seatId: string }>();
  private eventsByRoom = new Map<string, Array<{ offset: number; event: DomainEvent }>>();
  private subsByRoom = new Map<string, SubEntry[]>();
  private receipts = new Map<string, { envKey: string; result: CommandResult }>();
  private roomSeq = 0;
  private specSeq = 0;

  /** 测试钩子：下一条命令强制以该拒绝码失败 */
  forceRejection: string | null = null;
  /** 观测点 */
  submitCalls: Array<{ principal: Principal; envelope: CommandEnvelope }> = [];
  snapshotRecipients: Array<SeatId | 'spectator'> = [];
  subscribeRecipients: Array<SeatId | 'spectator'> = [];

  async createRoom(input: { name: string; scenarioId: string; rootSeed?: string }): Promise<RoomInfo> {
    this.roomSeq++;
    const roomId = `room-${this.roomSeq}`;
    const now = 1_700_000_000_000;
    const info: RoomInfo = {
      roomId,
      name: input.name,
      scenarioId: input.scenarioId,
      phase: 'submitting',
      turn: 1,
      maxTurns: 40,
      rootSeed: input.rootSeed ?? 'seed-fixed',
      stateDigest: 'digest-1',
      behaviorFingerprint: 1,
      contentHash: 'hash-1',
      seats: [],
      createdAt: now,
      updatedAt: now,
      winner: null,
      endReason: null,
    };
    this.rooms.set(roomId, { info, digestSeq: 1 });
    this.seatsByRoom.set(roomId, new Map());
    this.eventsByRoom.set(roomId, []);
    this.subsByRoom.set(roomId, []);
    return info;
  }

  async listRooms(): Promise<RoomInfo[]> {
    return [...this.rooms.values()].map((r) => r.info);
  }

  async getRoom(roomId: string): Promise<RoomInfo | null> {
    return this.rooms.get(roomId)?.info ?? null;
  }

  async deleteRoom(roomId: string): Promise<void> {
    this.rooms.delete(roomId);
  }

  async joinRoom(
    roomId: string,
    input: { seatId?: SeatId; asSpectator?: boolean },
  ): Promise<{ seat: SeatInfo; token: string }> {
    const room = this.rooms.get(roomId);
    if (room === undefined) throw Object.assign(new Error(`房间不存在：${roomId}`), { code: 'UNKNOWN_ROOM' });
    this.specSeq++;
    const seatId = input.asSpectator === true ? `spec-${this.specSeq}` : (input.seatId ?? `seat-${this.specSeq}`);
    const seat: SeatInfo = {
      seatId,
      factionId: input.asSpectator === true ? null : seatId,
      kind: input.asSpectator === true ? 'spectator' : 'human',
      autoCommit: false,
      llmDriven: false,
      aiProfile: null,
      tokenUsed: 0,
      tokenCap: 200000,
      connected: true,
      controllerId: `ctrl-${seatId}`,
    };
    const seats = this.seatsByRoom.get(roomId);
    assert.ok(seats !== undefined);
    seats.set(seatId, seat);
    room.info = { ...room.info, seats: [...room.info.seats, seat] };
    const token = `seat-token-${roomId}-${seatId}`;
    this.tokenIndex.set(token, { roomId, seatId });
    return { seat, token };
  }

  async resumeSeat(token: string): Promise<{ room: RoomInfo; seat: SeatInfo } | null> {
    const ref = this.tokenIndex.get(token);
    if (ref === undefined) return null;
    const room = this.rooms.get(ref.roomId);
    const seat = this.seatsByRoom.get(ref.roomId)?.get(ref.seatId);
    if (room === undefined || seat === undefined) return null;
    return { room: room.info, seat };
  }

  async assignSeat(roomId: string, seatId: SeatId, patch: Partial<Pick<SeatInfo, 'autoCommit' | 'llmDriven' | 'kind'>>): Promise<SeatInfo> {
    const seats = this.seatsByRoom.get(roomId);
    const old = seats?.get(seatId);
    assert.ok(old !== undefined);
    const next: SeatInfo = { ...old, ...patch };
    seats?.set(seatId, next);
    return next;
  }

  async revokeSeat(roomId: string, seatId: SeatId): Promise<SeatInfo | null> {
    const seats = this.seatsByRoom.get(roomId);
    const old = seats?.get(seatId);
    if (old === undefined) return null;
    const next: SeatInfo = { ...old, controllerId: null, connected: false };
    seats?.set(seatId, next);
    for (const [token, ref] of this.tokenIndex) {
      if (ref.roomId === roomId && ref.seatId === seatId) this.tokenIndex.delete(token);
    }
    return next;
  }

  async reclaimSeat(roomId: string, seatId: SeatId): Promise<{ seat: SeatInfo; token: string } | null> {
    const seat = this.seatsByRoom.get(roomId)?.get(seatId);
    if (seat === undefined || seat.kind === 'ai') return null;
    const token = `reclaim-${roomId}-${seatId}-${++this.specSeq}`;
    this.tokenIndex.set(token, { roomId, seatId });
    return { seat: { ...seat, connected: true, controllerId: `ctrl-${seatId}` }, token };
  }

  async getMatchMemory(roomId: string, recipient: SeatId | 'spectator'): Promise<any> {
    return {
      format: 'guozhan-match-memory',
      version: 1,
      room: { roomId },
      viewer: { recipient, full: recipient === 'spectator' },
      turns: [],
      events: [],
      messages: [],
    };
  }

  async getSnapshot(roomId: string, recipient: SeatId | 'spectator'): Promise<z.infer<typeof SnapshotSchema>> {
    this.snapshotRecipients.push(recipient);
    const room = this.rooms.get(roomId);
    assert.ok(room !== undefined);
    return { ...SNAPSHOT_FIXTURE, recipient: String(recipient), stateId: room.info.stateDigest };
  }

  async getMapLayout(_roomId: string): Promise<MapLayout> {
    return MapLayoutSchema.parse({
      kind: 'hex',
      canvas: { width: 1000, height: 700 },
      hexSize: 50,
      regions: [
        { id: 'r_handan', x: 200, y: 200 },
        { id: 'r_xianyang', x: 400, y: 200 },
        { id: 'r_far', x: 600, y: 400 },
      ],
      factionColors: { qin: '#1a1a1a', zhao: '#8b0000' },
      capitals: { qin: 'r_xianyang', zhao: 'r_handan' },
      waterRoutes: [],
      ports: [],
    });
  }

  async getTurnReport(roomId: string, turn: number): Promise<TurnReport | null> {
    if (!this.rooms.has(roomId)) return null;
    return turn === 1 ? makeTurnReport(roomId, turn) : null;
  }

  async getState(_roomId: string): Promise<{ state: GameState; world: WorldConfig; scenario: ScenarioMeta } | null> {
    return null; // 适配器不得直接碰规范状态；fake 不提供
  }

  async getPendingAdvice(_roomId: string, _seatId: SeatId): Promise<readonly AdviceRecord[]> {
    return [];
  }

  async getLegalActions(
    _roomId: string,
    _seatId: SeatId,
  ): Promise<{ turn: number; stateId: string; actions: readonly LegalAction[] }> {
    return { turn: 1, stateId: 'digest-1', actions: [] };
  }

  async submitCommands(opts: { principal: Principal; envelope: CommandEnvelope }): Promise<CommandResult> {
    const { principal, envelope } = opts;
    this.submitCalls.push({ principal, envelope });
    const room = this.rooms.get(principal.roomId);
    assert.ok(room !== undefined);
    const envKey = JSON.stringify(envelope);

    // ① 幂等：同 requestId 命中回执
    const receipt = this.receipts.get(envelope.requestId);
    if (receipt !== undefined) {
      if (receipt.envKey === envKey) {
        return { ...receipt.result, replayed: true };
      }
      // 同 id 异参 → 409（用 STALE_REVISION 表达冲突）
      return {
        status: 'failed', completedSteps: 0, replayed: false,
        stateId: room.info.stateDigest, turn: room.info.turn,
        steps: [{ index: 0, ok: false, code: RejectionCode.STALE_REVISION, message: 'requestId 冲突：同 id 不同参数' }],
      };
    }

    // ② 测试钩子：强制拒绝码
    if (this.forceRejection !== null) {
      return {
        status: 'failed', completedSteps: 0, replayed: false,
        stateId: room.info.stateDigest, turn: room.info.turn,
        steps: [{ index: 0, ok: false, code: this.forceRejection, message: `fake 强制拒绝：${this.forceRejection}` }],
      };
    }

    // ③ CAS
    if (envelope.stateId !== room.info.stateDigest) {
      return {
        status: 'failed', completedSteps: 0, replayed: false,
        stateId: room.info.stateDigest, turn: room.info.turn,
        steps: [{ index: 0, ok: false, code: RejectionCode.STALE_REVISION, message: 'stateId 过期' }],
      };
    }

    // ④ 成功：digest 前进，落回执
    room.digestSeq++;
    const newDigest = `digest-${room.digestSeq}`;
    room.info = { ...room.info, stateDigest: newDigest };
    const result: CommandResult = {
      status: 'completed',
      completedSteps: envelope.commands.length,
      replayed: false,
      stateId: newDigest,
      turn: room.info.turn,
      steps: envelope.commands.map((_c, index) => ({ index, ok: true })),
    };
    this.receipts.set(envelope.requestId, { envKey, result });
    return result;
  }

  async adoptAdvice(opts: { principal: Principal; adviceId: string; commandIndices?: readonly number[] }): Promise<CommandResult> {
    return this.submitCommands({
      principal: opts.principal,
      envelope: { stateId: this.rooms.get(opts.principal.roomId)?.info.stateDigest ?? '', requestId: `adopt-${opts.adviceId}`, commands: [{ kind: 'set_tax', rate: 0.2 }] },
    });
  }

  async lockOrders(principal: Principal): Promise<{ locked: boolean; waiting: readonly SeatId[] }> {
    if (principal.readOnly) {
      throw Object.assign(new Error('观战席位只读'), { code: RejectionCode.SEAT_NOT_AUTHORIZED });
    }
    return { locked: true, waiting: ['chu'] };
  }

  async timeoutLock(_roomId: string, _seatId: SeatId): Promise<void> { /* noop */ }

  async resolveTurn(roomId: string, _opts?: { llmDelta?: Readonly<Record<FactionId, SanitizedLlmDelta>> }): Promise<TurnReport> {
    return makeTurnReport(roomId, 1);
  }

  async generateNarratives(_roomId: string, _turn: number): Promise<void> { /* noop */ }

  async requestAdvice(_roomId: string, _seatId: SeatId): Promise<{ adviceId: string } | { skipped: string }> {
    return { adviceId: 'adv-1' };
  }

  /** 测试注入事件（真实实现里由 resolveTurn 产出） */
  emitEvent(roomId: string, event: DomainEvent): number {
    const log = this.eventsByRoom.get(roomId);
    assert.ok(log !== undefined);
    const offset = log.length;
    log.push({ offset, event });
    const room = this.rooms.get(roomId);
    assert.ok(room !== undefined);
    const batch: EventBatch = { roomId, events: [{ offset, event }], stateDigest: room.info.stateDigest, turn: room.info.turn };
    for (const sub of this.subsByRoom.get(roomId) ?? []) sub.sink(batch);
    return offset;
  }

  subscribe(roomId: string, recipient: SeatId | 'spectator', fromOffset: number, sink: (batch: EventBatch) => void): Unsubscribe {
    this.subscribeRecipients.push(recipient);
    const entry: SubEntry = { recipient, fromOffset, sink };
    const subs = this.subsByRoom.get(roomId);
    assert.ok(subs !== undefined);
    subs.push(entry);
    // 断线重连补发：立即投递积压（同步，便于测试）
    const backlog = (this.eventsByRoom.get(roomId) ?? []).filter((e) => e.offset >= fromOffset);
    if (backlog.length > 0) {
      const room = this.rooms.get(roomId);
      assert.ok(room !== undefined);
      sink({ roomId, events: backlog, stateDigest: room.info.stateDigest, turn: room.info.turn });
    }
    return () => {
      const i = subs.indexOf(entry);
      if (i >= 0) subs.splice(i, 1);
    };
  }

  async nextOffset(roomId: string): Promise<number> {
    return (this.eventsByRoom.get(roomId) ?? []).length;
  }

  async shutdown(): Promise<void> { /* noop */ }
}

// ─────────────────────────────────────────────────────────────
// 测试服务器装配（真实 http/ws/mcp 适配器 + fake manager）
// ─────────────────────────────────────────────────────────────

const ADMIN_TOKEN = 'admin-token-0123456789-abcdefghijkl'; // ≥24 字符
const ALLOWED_ORIGIN = 'http://localhost:8000';
const SCENARIO_META_STUB = {
  id: 'warring-states',
  name: '戰國七雄',
  description: '',
  maxTurns: 40,
  moduleOrder: ['economy', 'movement', 'combat'],
  behaviorFingerprint: 1,
  seats: { humanCapable: ['qin', 'zhao'], majorAi: ['qin'], minorAi: ['zhao'], spectatorSlots: 2 },
  timeout: { human: 300, ai: 120 },
  milestones: [],
  llm: { model: 'deepseek-chat', advisorMaxTokens: 2048, narrativeMaxTokens: 1024, intentMaxTokens: 512, temperature: 0.7, language: 'zh' },
  budget: { perSeatTokenCap: 200000, perTurnCallCap: 8, onExceed: 'degrade' },
} as ScenarioMeta;

const fake = new FakeRoomManager();
const usersDir = mkdtempSync(join(tmpdir(), 'guozhan-users-'));
const userService = new UserService({ dataDir: usersDir });
const auth = createAuth({ adminToken: ADMIN_TOKEN, origins: [ALLOWED_ORIGIN] }, fake);
const mcpAdapter = createMcpAdapter({ auth, roomManager: fake });
const httpHandler = createHttpHandler({
  auth,
  roomManager: fake,
  userService,
  listScenarios: () => [SCENARIO_META_STUB],
  mcp: mcpAdapter,
});
const server: HttpServer = createServer(httpHandler);
const wsAttached = attachWebSocket(server, { auth, roomManager: fake });

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const addr = server.address();
assert.ok(addr !== null && typeof addr === 'object');
const BASE = `http://127.0.0.1:${addr.port}`;
const WS_BASE = `ws://127.0.0.1:${addr.port}`;

const room1 = await fake.createRoom({ name: '测试房一', scenarioId: 'warring-states' });
const joinQin = await fake.joinRoom(room1.roomId, { seatId: 'qin' });
const joinSpec = await fake.joinRoom(room1.roomId, { asSpectator: true });
const room2 = await fake.createRoom({ name: '测试房二', scenarioId: 'warring-states' });
const joinChu = await fake.joinRoom(room2.roomId, { seatId: 'chu' });

after(async () => {
  userService.close();
  try { rmSync(usersDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* Windows 句柄延迟 */ }
  await wsAttached.close();
  await mcpAdapter.closeAll();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ── HTTP 小工具 ──

interface ReqOpts {
  method?: string;
  token?: string | null;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
}

async function req(path: string, opts: ReqOpts = {}): Promise<{ status: number; json: () => unknown; text: string; headers: Headers }> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token !== null && opts.token !== undefined) headers.Authorization = `Bearer ${opts.token}`;
  let payload: string | undefined;
  if (opts.rawBody !== undefined) {
    payload = opts.rawBody;
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
  } else if (opts.body !== undefined) {
    payload = JSON.stringify(opts.body);
    headers['Content-Type'] = 'application/json';
  }
  const resp = await fetch(`${BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    ...(payload !== undefined ? { body: payload } : {}),
  });
  const text = await resp.text();
  return {
    status: resp.status,
    text,
    headers: resp.headers,
    json: () => JSON.parse(text) as unknown,
  };
}

function envelope(stateId: string, requestId: string, commands: unknown[] = [{ kind: 'set_tax', rate: 0.2 }]): Record<string, unknown> {
  return { stateId, requestId, commands };
}

async function currentDigest(): Promise<string> {
  const r = await req(`/api/rooms/${room1.roomId}`, { token: ADMIN_TOKEN });
  return ((r.json() as { room: { stateDigest: string } }).room).stateDigest;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(cond: () => boolean, timeoutMs = 3000, what = '条件'): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${what}`);
    await sleep(20);
  }
}

// ─────────────────────────────────────────────────────────────
// A. 鉴权 / Origin / CORS / 请求体上限
// ─────────────────────────────────────────────────────────────

test('A1 /health 无鉴权 200；坏样本：受保护端点无令牌 401', async () => {
  const health = await req('/health');
  assert.equal(health.status, 200);
  assert.equal((health.json() as { status: string }).status, 'ok');

  const noToken = await req('/api/rooms');
  assert.equal(noToken.status, 401);
  assert.equal((noToken.json() as { error: { code: string } }).error.code, 'UNAUTHORIZED');

  const badToken = await req('/api/rooms', { token: 'wrong-token-0123456789-abcdefghijk' });
  assert.equal(badToken.status, 401);

  const goodToken = await req('/api/rooms', { token: ADMIN_TOKEN });
  assert.equal(goodToken.status, 200); // 好样本对照
});

test('A2 Origin 白名单：坏 Origin 403；好 Origin 200 + CORS 头；预检含 Allow-Private-Network', async () => {
  const evil = await req('/api/rooms', { token: ADMIN_TOKEN, headers: { Origin: 'http://evil.example' } });
  assert.equal(evil.status, 403);
  assert.equal((evil.json() as { error: { code: string } }).error.code, 'ORIGIN_NOT_ALLOWED');

  const good = await req('/api/rooms', { token: ADMIN_TOKEN, headers: { Origin: ALLOWED_ORIGIN } });
  assert.equal(good.status, 200);
  assert.equal(good.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);

  const preflight = await req('/api/rooms', {
    method: 'OPTIONS',
    token: null,
    headers: { Origin: ALLOWED_ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Private-Network': 'true' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true');

  const evilPreflight = await req('/api/rooms', { method: 'OPTIONS', token: null, headers: { Origin: 'http://evil.example' } });
  assert.equal(evilPreflight.status, 403); // 坏样本：预检阶段就拒绝
});

test('A3 请求体上限：3MB → 413；坏 JSON → 400 MALFORMED_PAYLOAD；小请求体对照 201', async () => {
  const huge = 'x'.repeat(3 * 1024 * 1024);
  const big = await req('/api/rooms', { method: 'POST', token: ADMIN_TOKEN, rawBody: huge });
  assert.equal(big.status, 413);

  const malformed = await req('/api/rooms', { method: 'POST', token: ADMIN_TOKEN, rawBody: 'not-json{' });
  assert.equal(malformed.status, 400);
  assert.equal((malformed.json() as { error: { code: string } }).error.code, RejectionCode.MALFORMED_PAYLOAD);

  const good = await req('/api/rooms', {
    method: 'POST',
    token: ADMIN_TOKEN,
    body: { name: '新房', scenarioId: 'warring-states' },
  });
  assert.equal(good.status, 201); // 好样本对照
  assert.ok(typeof (good.json() as { room: { roomId: string } }).room.roomId === 'string');

  const extraField = await req('/api/rooms', {
    method: 'POST',
    token: ADMIN_TOKEN,
    body: { name: '新房', scenarioId: 'warring-states', evil: 1 },
  });
  assert.equal(extraField.status, 400); // 坏样本：.strict() 拒多余字段
});

test('A4 令牌比较是常量时间封装：safeTokenEqual 正反例', () => {
  assert.equal(safeTokenEqual(ADMIN_TOKEN, ADMIN_TOKEN), true);
  assert.equal(safeTokenEqual(ADMIN_TOKEN + 'x', ADMIN_TOKEN), false);
  assert.equal(safeTokenEqual('', ADMIN_TOKEN), false);
  assert.ok(generateToken().length >= 24);
  // 短管理令牌拒绝启动（fail-closed）
  assert.throws(() => createAuth({ adminToken: 'short' }, fake), /拒绝启动/);
});

test('A5 账号注册/登录/用户中心/登出：坏样本重复用户名与错密码', async () => {
  const reg = await req('/api/auth/register', {
    method: 'POST',
    body: { username: 'host_user', password: 'password123', displayName: '房主' },
  });
  assert.equal(reg.status, 201);
  const registered = reg.json() as { user: { id: string; displayName: string }; token: string };
  assert.equal(registered.user.displayName, '房主');
  assert.match(registered.token, /^usr_/);

  const dup = await req('/api/auth/register', {
    method: 'POST',
    body: { username: 'HOST_USER', password: 'password123' },
  });
  assert.equal(dup.status, 409);
  assert.equal((dup.json() as { error: { code: string } }).error.code, 'USERNAME_TAKEN');

  const badPw = await req('/api/auth/login', {
    method: 'POST',
    body: { username: 'host_user', password: 'wrong-password' },
  });
  assert.equal(badPw.status, 401);
  assert.equal((badPw.json() as { error: { code: string } }).error.code, 'INVALID_CREDENTIALS');

  const me = await req('/api/me', { token: registered.token });
  assert.equal(me.status, 200);
  assert.equal((me.json() as { user: { username: string } }).user.username, 'host_user');

  const login = await req('/api/auth/login', {
    method: 'POST',
    body: { username: 'host_user', password: 'password123' },
  });
  assert.equal(login.status, 200);
  const token = (login.json() as { token: string }).token;
  const out = await req('/api/auth/logout', { method: 'POST', token });
  assert.equal(out.status, 200);
  const after = await req('/api/me', { token });
  assert.equal(after.status, 401);
});

test('A6 账号大厅：房主建房/房主管理/踢人封禁/解封/离开', async () => {
  const host = await req('/api/auth/register', {
    method: 'POST',
    body: { username: 'account_host', password: 'password123', displayName: '主持' },
  }).then((r) => r.json() as { user: { id: string }; token: string });
  const guest = await req('/api/auth/register', {
    method: 'POST',
    body: { username: 'account_guest', password: 'password123', displayName: '来宾' },
  }).then((r) => r.json() as { user: { id: string }; token: string });

  const created = await req('/api/rooms', {
    method: 'POST',
    token: host.token,
    body: { name: '账号测试房', scenarioId: 'warring-states', rootSeed: 'account-seed' },
  });
  assert.equal(created.status, 201);
  const roomId = (created.json() as { room: { roomId: string } }).room.roomId;

  const lobby = await req('/api/rooms', { token: guest.token });
  assert.equal(lobby.status, 200);
  const listed = (lobby.json() as { rooms: Array<{ roomId: string; host: { username: string } | null }> }).rooms;
  assert.equal(listed.find((r) => r.roomId === roomId)?.host?.username, 'account_host');

  const joined = await req(`/api/rooms/${roomId}/join`, {
    method: 'POST', token: guest.token, body: { seatId: 'zhao' },
  });
  assert.equal(joined.status, 200);
  const guestSeatToken = (joined.json() as { token: string }).token;
  const guestMe = await req('/api/me', { token: guest.token });
  assert.equal((guestMe.json() as { rooms: unknown[] }).rooms.length, 1);

  const deniedKick = await req(`/api/rooms/${roomId}/kick`, {
    method: 'POST', token: guest.token, body: { userId: host.user.id, ban: true },
  });
  assert.equal(deniedKick.status, 403);
  assert.equal((deniedKick.json() as { error: { code: string } }).error.code, 'HOST_REQUIRED');

  const kicked = await req(`/api/rooms/${roomId}/kick`, {
    method: 'POST', token: host.token, body: { userId: guest.user.id, ban: true, reason: '测试封禁' },
  });
  assert.equal(kicked.status, 200);
  assert.equal((kicked.json() as { banned: boolean }).banned, true);

  const revoked = await req(`/api/rooms/${roomId}/snapshot`, { token: guestSeatToken });
  assert.equal(revoked.status, 401, '被踢后旧席位令牌必须失效');

  const bannedJoin = await req(`/api/rooms/${roomId}/join`, {
    method: 'POST', token: guest.token, body: { asSpectator: true },
  });
  assert.equal(bannedJoin.status, 403);
  assert.equal((bannedJoin.json() as { error: { code: string } }).error.code, 'ROOM_BANNED');

  const unban = await req(`/api/rooms/${roomId}/unban`, {
    method: 'POST', token: host.token, body: { userId: guest.user.id },
  });
  assert.equal(unban.status, 200);
  const rejoin = await req(`/api/rooms/${roomId}/join`, {
    method: 'POST', token: guest.token, body: { asSpectator: true },
  });
  assert.equal(rejoin.status, 200);
  assert.equal((rejoin.json() as { seat: { kind: string } }).seat.kind, 'spectator');

  const leave = await req(`/api/rooms/${roomId}/leave`, { method: 'POST', token: guest.token });
  assert.equal(leave.status, 200);
  const afterLeave = await req('/api/me', { token: guest.token });
  assert.equal((afterLeave.json() as { rooms: unknown[] }).rooms.length, 0);

  const deleted = await req(`/api/rooms/${roomId}`, { method: 'DELETE', token: host.token });
  assert.equal(deleted.status, 200);
});

// ─────────────────────────────────────────────────────────────
// B. 席位令牌 → Principal（actor 身份只从令牌来）
// ─────────────────────────────────────────────────────────────

test('B1 快照按接收者投影：席位→seatId，观战→spectator（显式分支），管理→spectator；跨房令牌 403', async () => {
  fake.snapshotRecipients.length = 0;

  const asSeat = await req(`/api/rooms/${room1.roomId}/snapshot`, { token: joinQin.token });
  assert.equal(asSeat.status, 200);
  // fake 的快照必须能过 SnapshotSchema（夹具自证）
  SnapshotSchema.parse((asSeat.json() as { snapshot: unknown }).snapshot);

  const asSpec = await req(`/api/rooms/${room1.roomId}/snapshot`, { token: joinSpec.token });
  assert.equal(asSpec.status, 200);

  const asAdmin = await req(`/api/rooms/${room1.roomId}/snapshot`, { token: ADMIN_TOKEN });
  assert.equal(asAdmin.status, 200);

  assert.deepEqual(fake.snapshotRecipients, ['qin', 'spectator', 'spectator']);

  const crossRoom = await req(`/api/rooms/${room1.roomId}/snapshot`, { token: joinChu.token });
  assert.equal(crossRoom.status, 403); // 坏样本：别的房间的席位令牌
  assert.equal((crossRoom.json() as { error: { code: string } }).error.code, RejectionCode.SEAT_NOT_AUTHORIZED);
});

test('B1b 地图布局：席位/观战可读且过 MapLayoutSchema；坏样本：无令牌 401、跨房令牌 403、非 GET 405', async () => {
  for (const token of [joinQin.token, joinSpec.token, ADMIN_TOKEN]) {
    const r = await req(`/api/rooms/${room1.roomId}/layout`, { token });
    assert.equal(r.status, 200);
    const layout = MapLayoutSchema.parse((r.json() as { layout: unknown }).layout);
    assert.equal(layout.regions.length, 3, '布局区域数必须与 fake 夹具一致（夹具自证）');
    assert.ok(layout.factionColors['qin']?.match(/^#[0-9a-f]{6}$/));
    assert.equal(layout.capitals['qin'], 'r_xianyang');
  }

  const noToken = await req(`/api/rooms/${room1.roomId}/layout`, { token: null });
  assert.equal(noToken.status, 401);

  const crossRoom = await req(`/api/rooms/${room1.roomId}/layout`, { token: joinChu.token });
  assert.equal(crossRoom.status, 403);
  assert.equal((crossRoom.json() as { error: { code: string } }).error.code, RejectionCode.SEAT_NOT_AUTHORIZED);

  const wrongMethod = await req(`/api/rooms/${room1.roomId}/layout`, { method: 'POST', token: joinQin.token });
  assert.equal(wrongMethod.status, 405);
});

test('B2 actor 不可从载荷注入：信封带 seatId/actor 字段 → 400；合法信封的 principal 来自令牌', async () => {
  const digest = await currentDigest();
  const injected = await req(`/api/rooms/${room1.roomId}/commands`, {
    method: 'POST',
    token: joinQin.token,
    body: { ...envelope(digest, 'req-inject-1'), actor: 'zhao', seatId: 'zhao' },
  });
  assert.equal(injected.status, 400);
  assert.equal((injected.json() as { error: { code: string } }).error.code, RejectionCode.MALFORMED_PAYLOAD);

  fake.submitCalls.length = 0;
  const good = await req(`/api/rooms/${room1.roomId}/commands`, {
    method: 'POST',
    token: joinQin.token,
    body: envelope(digest, 'req-actor-1'),
  });
  assert.equal(good.status, 200);
  assert.equal(fake.submitCalls.length, 1);
  assert.equal(fake.submitCalls[0]?.principal.seatId, 'qin'); // ★身份只从令牌推导
  assert.equal(fake.submitCalls[0]?.principal.factionId, 'qin');
});

// ─────────────────────────────────────────────────────────────
// C. 写操作三件套：strict / 幂等 / CAS / 拒绝码全表
// ─────────────────────────────────────────────────────────────

test('C1 合法信封 → 200 completed，wire 形状含三件套字段', async () => {
  const digest = await currentDigest();
  const r = await req(`/api/rooms/${room1.roomId}/commands`, {
    method: 'POST',
    token: joinQin.token,
    body: envelope(digest, 'req-c1'),
  });
  assert.equal(r.status, 200);
  const body = r.json() as { status: string; completedSteps: number; rejections: unknown[]; replayed: boolean; stateId: string; turn: number };
  assert.equal(body.status, 'completed');
  assert.equal(body.completedSteps, 1);
  assert.equal(body.replayed, false);
  assert.deepEqual(body.rejections, []);
  assert.notEqual(body.stateId, digest); // digest 前进
  assert.equal(body.turn, 1);
});

test('C2 信封 .strict()：多余字段/超 8 步/空命令 → 400 MALFORMED_PAYLOAD（坏样本三连）', async () => {
  const digest = await currentDigest();
  const extra = await req(`/api/rooms/${room1.roomId}/commands`, {
    method: 'POST',
    token: joinQin.token,
    body: { ...envelope(digest, 'req-c2a'), why: '多余字段' },
  });
  assert.equal(extra.status, 400);
  assert.equal((extra.json() as { error: { code: string } }).error.code, RejectionCode.MALFORMED_PAYLOAD);

  const tooMany = await req(`/api/rooms/${room1.roomId}/commands`, {
    method: 'POST',
    token: joinQin.token,
    body: envelope(digest, 'req-c2b', Array.from({ length: 9 }, () => ({ kind: 'set_tax', rate: 0.2 }))),
  });
  assert.equal(tooMany.status, 400);

  const emptyCmds = await req(`/api/rooms/${room1.roomId}/commands`, {
    method: 'POST',
    token: joinQin.token,
    body: envelope(digest, 'req-c2c', []),
  });
  assert.equal(emptyCmds.status, 400);
});

test('C3 幂等：同 requestId 同参重放 → replayed:true；同 id 异参 → 409', async () => {
  const digest = await currentDigest();
  const env1 = envelope(digest, 'req-idem-1');
  const first = await req(`/api/rooms/${room1.roomId}/commands`, { method: 'POST', token: joinQin.token, body: env1 });
  assert.equal(first.status, 200);
  assert.equal((first.json() as { replayed: boolean }).replayed, false);

  const second = await req(`/api/rooms/${room1.roomId}/commands`, { method: 'POST', token: joinQin.token, body: env1 });
  assert.equal(second.status, 200);
  const secondBody = second.json() as { replayed: boolean; stateId: string };
  assert.equal(secondBody.replayed, true); // ★第二次是重放不是重执行
  assert.equal(secondBody.stateId, (first.json() as { stateId: string }).stateId);

  const conflict = await req(`/api/rooms/${room1.roomId}/commands`, {
    method: 'POST',
    token: joinQin.token,
    body: envelope(digest, 'req-idem-1', [{ kind: 'set_tax', rate: 0.5 }]),
  });
  assert.equal(conflict.status, 409); // 坏样本：同 id 异参
});

test('C4 CAS：旧 stateId → 409 STALE_REVISION；新 stateId 对照 → 200', async () => {
  const stale = await req(`/api/rooms/${room1.roomId}/commands`, {
    method: 'POST',
    token: joinQin.token,
    body: envelope('digest-1', 'req-cas-stale'), // 开局 digest，早已过期
  });
  assert.equal(stale.status, 409);
  const staleBody = stale.json() as { rejections: Array<{ code: string }> };
  assert.equal(staleBody.rejections[0]?.code, RejectionCode.STALE_REVISION);

  const fresh = await currentDigest();
  const good = await req(`/api/rooms/${room1.roomId}/commands`, {
    method: 'POST',
    token: joinQin.token,
    body: envelope(fresh, 'req-cas-fresh'),
  });
  assert.equal(good.status, 200); // 好样本对照
});

test('C5 拒绝码→HTTP 状态：REJECTION_HTTP_STATUS 全表遍历逐条一致', async () => {
  // 表本身的完整性：键集合 == ALL_REJECTION_CODES（双向）
  const tableKeys = Object.keys(REJECTION_HTTP_STATUS).sort();
  assert.deepEqual(tableKeys, [...ALL_REJECTION_CODES].sort());

  const digest = await currentDigest();
  for (const code of ALL_REJECTION_CODES) {
    fake.forceRejection = code;
    const r = await req(`/api/rooms/${room1.roomId}/commands`, {
      method: 'POST',
      token: joinQin.token,
      body: envelope(digest, `req-table-${code}`),
    });
    assert.equal(r.status, REJECTION_HTTP_STATUS[code], `拒绝码 ${code} 应映射为 ${REJECTION_HTTP_STATUS[code]}`);
    const body = r.json() as { status: string; rejections: Array<{ code: string }> };
    assert.equal(body.status, 'failed');
    assert.equal(body.rejections[0]?.code, code);
  }
  fake.forceRejection = null;
  const control = await req(`/api/rooms/${room1.roomId}/commands`, {
    method: 'POST',
    token: joinQin.token,
    body: envelope(digest, 'req-table-control'),
  });
  assert.equal(control.status, 200); // 对照：不设强制拒绝时同一请求是绿的
});

test('C6 观战席位写操作 → 403 SEAT_NOT_AUTHORIZED（commands/lock/adopt 三端点）', async () => {
  const digest = await currentDigest();
  const cmd = await req(`/api/rooms/${room1.roomId}/commands`, {
    method: 'POST',
    token: joinSpec.token,
    body: envelope(digest, 'req-spec-write'),
  });
  assert.equal(cmd.status, 403);
  assert.equal((cmd.json() as { error: { code: string } }).error.code, RejectionCode.SEAT_NOT_AUTHORIZED);

  const lock = await req(`/api/rooms/${room1.roomId}/lock`, { method: 'POST', token: joinSpec.token, body: {} });
  assert.equal(lock.status, 403);

  const adopt = await req(`/api/rooms/${room1.roomId}/advice/adv-1/adopt`, { method: 'POST', token: joinSpec.token, body: {} });
  assert.equal(adopt.status, 403);

  // 好样本对照：人类席位 lock 成功
  const goodLock = await req(`/api/rooms/${room1.roomId}/lock`, { method: 'POST', token: joinQin.token, body: {} });
  assert.equal(goodLock.status, 200);
  assert.equal((goodLock.json() as { locked: boolean }).locked, true);
});

test('C7 采纳建议：adopt 走同一条提交通道；坏样本：commandIndices 带负数 → 400', async () => {
  const r = await req(`/api/rooms/${room1.roomId}/advice/adv-1/adopt`, {
    method: 'POST',
    token: joinQin.token,
    body: { commandIndices: [0, 1] },
  });
  assert.equal(r.status, 200);
  assert.equal((r.json() as { status: string }).status, 'completed');

  const bad = await req(`/api/rooms/${room1.roomId}/advice/adv-1/adopt`, {
    method: 'POST',
    token: joinQin.token,
    body: { commandIndices: [-1] },
  });
  assert.equal(bad.status, 400);
});

test('C8 回合战报：turns/1 → 200；turns/999 → 404；turns/abc → 400', async () => {
  const ok = await req(`/api/rooms/${room1.roomId}/turns/1`, { token: joinQin.token });
  assert.equal(ok.status, 200);
  assert.equal((ok.json() as { report: { turn: number } }).report.turn, 1);

  const missing = await req(`/api/rooms/${room1.roomId}/turns/999`, { token: joinQin.token });
  assert.equal(missing.status, 404);

  const bad = await req(`/api/rooms/${room1.roomId}/turns/abc`, { token: joinQin.token });
  assert.equal(bad.status, 400);
});

test('C9 完整对局记忆：本席位/观战 200；跨房间令牌 403；无令牌 401', async () => {
  const seat = await req(`/api/rooms/${room1.roomId}/memory`, { token: joinQin.token });
  assert.equal(seat.status, 200);
  assert.equal((seat.json() as { memory: { format: string } }).memory.format, 'guozhan-match-memory');

  const spec = await req(`/api/rooms/${room1.roomId}/memory`, { token: joinSpec.token });
  assert.equal(spec.status, 200);

  const cross = await req(`/api/rooms/${room1.roomId}/memory`, { token: joinChu.token });
  assert.equal(cross.status, 403);

  const noToken = await req(`/api/rooms/${room1.roomId}/memory`);
  assert.equal(noToken.status, 401);
});

test('C10 httpStatusForResult/toWireResult 单元：failed 查表、partial→200、replayed→200', () => {
  const failed: CommandResult = {
    status: 'failed', completedSteps: 0, replayed: false, stateId: 'digest-x1', turn: 1,
    steps: [{ index: 0, ok: false, code: RejectionCode.TOKEN_BUDGET_EXCEEDED, message: '预算耗尽' }],
  };
  assert.equal(httpStatusForResult(failed), 429); // 与表一致
  const partial: CommandResult = { ...failed, status: 'partial', completedSteps: 1, replayed: false };
  assert.equal(httpStatusForResult(partial), 200); // partial 已提交步骤不回滚，必须给回执
  const replayed: CommandResult = { ...failed, replayed: true };
  assert.equal(httpStatusForResult(replayed), 200);
  const wire = toWireResult(failed);
  assert.deepEqual(wire.rejections, [{ index: 0, code: RejectionCode.TOKEN_BUDGET_EXCEEDED, message: '预算耗尽' }]);
});

// ─────────────────────────────────────────────────────────────
// D. HTTP 事件补发（断线重连）
// ─────────────────────────────────────────────────────────────

test('D1 GET /events?from=N 补发缺失事件；坏样本：from=abc → 400；跨房令牌 → 403', async () => {
  const turnStarted: DomainEvent = { type: 'turn_started', turn: 1, deadline: { qin: 999 } };
  fake.emitEvent(room1.roomId, turnStarted);
  fake.emitEvent(room1.roomId, turnStarted);
  fake.emitEvent(room1.roomId, turnStarted);

  const all = await req(`/api/rooms/${room1.roomId}/events?from=0`, { token: joinQin.token });
  assert.equal(all.status, 200);
  const allBody = all.json() as { events: Array<{ offset: number }>; nextOffset: number };
  assert.deepEqual(allBody.events.map((e) => e.offset), [0, 1, 2]);
  assert.equal(allBody.nextOffset, 3);

  const catchup = await req(`/api/rooms/${room1.roomId}/events?from=2`, { token: joinQin.token });
  const catchupBody = catchup.json() as { events: Array<{ offset: number }> };
  assert.deepEqual(catchupBody.events.map((e) => e.offset), [2]); // 只补缺失的

  const bad = await req(`/api/rooms/${room1.roomId}/events?from=abc`, { token: joinQin.token });
  assert.equal(bad.status, 400);

  const cross = await req(`/api/rooms/${room1.roomId}/events?from=0`, { token: joinChu.token });
  assert.equal(cross.status, 403);
});

// ─────────────────────────────────────────────────────────────
// E. WebSocket
// ─────────────────────────────────────────────────────────────

interface WsHarness {
  readonly ws: WebSocket;
  readonly messages: Array<Record<string, unknown>>;
  close(): void;
}

function connectWs(query: string): Promise<WsHarness> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/ws?${query}`);
    const messages: Array<Record<string, unknown>> = [];
    ws.on('message', (data: Buffer | string) => {
      messages.push(JSON.parse(typeof data === 'string' ? data : data.toString('utf8')) as Record<string, unknown>);
    });
    ws.on('open', () => resolve({ ws, messages, close: () => ws.terminate() }));
    ws.on('unexpected-response', (_r, res) => {
      reject(Object.assign(new Error(`upgrade 被拒：HTTP ${res.statusCode ?? '?'}`), { statusCode: res.statusCode }));
    });
    ws.on('error', (err) => reject(err));
  });
}

test('E1 WS 订阅收到 welcome + 积压补发 + 实时事件', async () => {
  const harness = await connectWs(`room=${room1.roomId}&token=${joinQin.token}&from=0`);
  try {
    await until(() => harness.messages.some((m) => m.type === 'welcome'), 2000, 'welcome');
    const welcome = harness.messages.find((m) => m.type === 'welcome');
    assert.equal(welcome?.seatId, 'qin');
    assert.equal(welcome?.recipient, 'qin');

    // D1 已发 3 条积压（offset 0..2），from=0 应全部补发
    await until(() => harness.messages.some((m) => m.type === 'events'), 2000, '积压批次');
    const backlog = harness.messages.filter((m) => m.type === 'events');
    const offsets = backlog.flatMap((m) => (m.events as Array<{ offset: number }>).map((e) => e.offset));
    assert.ok(offsets.includes(0) && offsets.includes(1) && offsets.includes(2));

    // 实时事件
    const turnStarted: DomainEvent = { type: 'turn_started', turn: 2, deadline: {} };
    const offset = fake.emitEvent(room1.roomId, turnStarted);
    await until(() => harness.messages.some((m) => m.type === 'events' && (m.events as Array<{ offset: number }>).some((e) => e.offset === offset)), 2000, '实时事件');
  } finally {
    harness.close();
  }
});

test('E2 WS 断线重连 from=offset 只补缺失事件', async () => {
  const before = await fake.nextOffset(room1.roomId);
  const turnStarted: DomainEvent = { type: 'turn_started', turn: 3, deadline: {} };
  fake.emitEvent(room1.roomId, turnStarted);
  fake.emitEvent(room1.roomId, turnStarted);

  // 从 before 开始重连：只应收到之后两条，不含更早的积压
  const harness = await connectWs(`room=${room1.roomId}&token=${joinQin.token}&from=${before}`);
  try {
    await until(() => harness.messages.some((m) => m.type === 'events'), 2000, '补发批次');
    const offsets = harness.messages
      .filter((m) => m.type === 'events')
      .flatMap((m) => (m.events as Array<{ offset: number }>).map((e) => e.offset));
    assert.deepEqual(offsets, [before, before + 1]);
    assert.ok(!offsets.includes(before - 1)); // 坏样本对照：更早的 offset 不得重复下发
  } finally {
    harness.close();
  }
});

test('E3 WS 鉴权坏样本：假令牌拒绝升级 401；跨房令牌 403；缺 token 401；from 非法 400', async () => {
  await assert.rejects(
    () => connectWs(`room=${room1.roomId}&token=bogus-token&from=0`),
    (err: { statusCode?: number }) => err.statusCode === 401,
  );
  await assert.rejects(
    () => connectWs(`room=${room1.roomId}&token=${joinChu.token}&from=0`),
    (err: { statusCode?: number }) => err.statusCode === 403,
  );
  await assert.rejects(
    () => connectWs(`room=${room1.roomId}&from=0`),
    (err: { statusCode?: number }) => err.statusCode === 401,
  );
  await assert.rejects(
    () => connectWs(`room=${room1.roomId}&token=${joinQin.token}&from=abc`),
    (err: { statusCode?: number }) => err.statusCode === 400,
  );
  // 好样本对照在 E1/E2 已证：同一 URL 形状带对令牌就能连上
});

test('E4 WS 观战席位 recipient 是 spectator（显式分支）+ 应用层 ping/pong', async () => {
  fake.subscribeRecipients.length = 0;
  const harness = await connectWs(`room=${room1.roomId}&token=${joinSpec.token}&from=0`);
  try {
    await until(() => harness.messages.some((m) => m.type === 'welcome'), 2000, 'welcome');
    assert.equal(fake.subscribeRecipients[0], 'spectator');
    harness.ws.send(JSON.stringify({ type: 'ping' }));
    await until(() => harness.messages.some((m) => m.type === 'pong'), 2000, 'pong');
  } finally {
    harness.close();
  }
});

// ─────────────────────────────────────────────────────────────
// F. MCP 适配器
// ─────────────────────────────────────────────────────────────

const EXPECTED_TOOLS = [
  'get_situation', 'list_legal_actions', 'query_region', 'query_faction', 'estimate_march',
  'validate_orders', 'submit_orders', 'lock_orders', 'request_advice', 'get_turn_report', 'spectate',
].sort();

test('F1 工具清单：恰好 ≤12 个且名单一致；每个都有 zod .strict() schema（好坏样本成对）', () => {
  assert.ok(MCP_TOOLS.length <= 12, `工具数 ${MCP_TOOLS.length} 超过 12`);
  assert.deepEqual(MCP_TOOLS.map((t) => t.name).sort(), EXPECTED_TOOLS);

  // 对照坏样本：默认 z.object 是 strip，不是 strict —— 证明 unknownKeys 断言有区分力
  const loose = z.object({ a: z.string().optional() });
  assert.notEqual((loose as unknown as { _def: { unknownKeys: string } })._def.unknownKeys, 'strict');

  // 每个工具的最小合法参数（好样本）
  const VALID_ARGS: Record<string, Record<string, unknown>> = {
    get_situation: {},
    list_legal_actions: {},
    query_region: { regionId: 'r_handan' },
    query_faction: { factionId: 'qin' },
    estimate_march: { unitId: 'u_qin_1', toRegion: 'r_handan' },
    validate_orders: { stateId: 'digest-12345678', commands: [{ kind: 'set_tax', rate: 0.2 }] },
    submit_orders: { stateId: 'digest-12345678', requestId: 'r-1', commands: [{ kind: 'set_tax', rate: 0.2 }] },
    lock_orders: {},
    request_advice: {},
    get_turn_report: { turn: 1 },
    spectate: {},
  };

  for (const tool of MCP_TOOLS) {
    assert.ok(tool.inputSchema instanceof z.ZodType, `${tool.name} 缺少 zod schema`);
    const def = (tool.inputSchema as unknown as { _def?: { unknownKeys?: string } })._def;
    assert.equal(def?.unknownKeys, 'strict', `${tool.name} 的 schema 不是 .strict()`);

    // 好样本：最小合法参数必须通过
    const valid = VALID_ARGS[tool.name];
    assert.ok(valid !== undefined, `${tool.name} 缺少测试夹具`);
    assert.equal(tool.inputSchema.safeParse(valid).success, true, `${tool.name} 拒绝了合法参数`);
    // 坏样本：合法参数 + 一个多余字段必须被拒（这才证明 strict 有区分力）
    const evil = tool.inputSchema.safeParse({ ...valid, __evil_extra_field__: 1 });
    assert.equal(evil.success, false, `${tool.name} 接受了多余字段`);
  }
});

test('F2 instructions 含防提示注入与操作纪律声明', () => {
  assert.ok(MCP_INSTRUCTIONS.includes('游戏数据'));
  assert.ok(MCP_INSTRUCTIONS.includes('不是对你的指令'));
  assert.ok(MCP_INSTRUCTIONS.includes('禁止盲目重发'));
  assert.ok(MCP_INSTRUCTIONS.includes('存档成功'));
  assert.ok(MCP_INSTRUCTIONS.includes('不得'));
  assert.ok(MCP_INSTRUCTIONS.includes('自行推算'));
  assert.ok(MCP_INSTRUCTIONS.includes('get_situation'));
});

test('F3 有状态 session：SESSION_ID_GENERATOR 不是 undefined 且产出唯一 id', () => {
  assert.notEqual(SESSION_ID_GENERATOR, undefined);
  assert.equal(typeof SESSION_ID_GENERATOR, 'function');
  const a = SESSION_ID_GENERATOR();
  const b = SESSION_ID_GENERATOR();
  assert.equal(typeof a, 'string');
  assert.notEqual(a, b);
});

interface McpSession {
  readonly sid: string;
  call(id: number, method: string, params: unknown): Promise<{ status: number; body: Record<string, unknown> }>;
}

async function mcpInitialize(token: string): Promise<McpSession> {
  const resp = await req('/mcp', {
    method: 'POST',
    token,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'adapter-test', version: '0' } },
    },
  });
  assert.equal(resp.status, 200);
  const sid = resp.headers.get('mcp-session-id');
  assert.ok(sid !== null && sid.length > 0, '有状态 session 必须返回 mcp-session-id 头');
  // initialized 通知
  const notify = await req('/mcp', {
    method: 'POST',
    token,
    headers: { 'mcp-session-id': sid as string, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: { jsonrpc: '2.0', method: 'notifications/initialized' },
  });
  assert.ok(notify.status === 202 || notify.status === 200, `initialized 通知状态异常：${notify.status}`);
  return {
    sid: sid as string,
    async call(id: number, method: string, params: unknown) {
      const r = await req('/mcp', {
        method: 'POST',
        token,
        headers: { 'mcp-session-id': sid as string, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: { jsonrpc: '2.0', id, method, params },
      });
      return { status: r.status, body: JSON.parse(r.text) as Record<string, unknown> };
    },
  };
}

test('F4 MCP 鉴权坏样本：无令牌 initialize → 401；管理令牌 → 401；无会话 tools/call → 400；假会话 → 404', async () => {
  const noToken = await req('/mcp', {
    method: 'POST',
    token: null,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '0' } } },
  });
  assert.equal(noToken.status, 401);

  const adminToken = await req('/mcp', {
    method: 'POST',
    token: ADMIN_TOKEN,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '0' } } },
  });
  assert.equal(adminToken.status, 401); // 管理令牌不是席位，不能开 MCP 会话

  const noSession = await req('/mcp', {
    method: 'POST',
    token: joinQin.token,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_situation', arguments: {} } },
  });
  assert.equal(noSession.status, 400);

  const fakeSession = await req('/mcp', {
    method: 'POST',
    token: joinQin.token,
    headers: { 'mcp-session-id': 'bogus-session-id', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_situation', arguments: {} } },
  });
  assert.equal(fakeSession.status, 404);
});

test('F5 MCP 会话 e2e：initialize 下发 instructions；tools/list 恰好 11 个；get_situation 返回快照', async () => {
  const session = await mcpInitialize(joinQin.token);
  assert.ok(mcpAdapter.sessionCount() >= 1); // ★会话被服务端持有 = 有状态

  const initResp = await session.call(10, 'ping', {});
  assert.equal(initResp.status, 200);

  const list = await session.call(11, 'tools/list', {});
  const tools = (list.body.result as { tools: Array<{ name: string; inputSchema: unknown }> }).tools;
  assert.ok(tools.length <= 12);
  assert.deepEqual(tools.map((t) => t.name).sort(), EXPECTED_TOOLS);
  for (const t of tools) {
    assert.equal(typeof t.inputSchema, 'object', `${t.name} 在 wire 上缺少 inputSchema`);
    assert.notEqual(t.inputSchema, null);
  }

  const sit = await session.call(12, 'tools/call', { name: 'get_situation', arguments: {} });
  const content = (sit.body.result as { content: Array<{ text: string }> }).content;
  const snapshot = JSON.parse(content[0]?.text ?? 'null') as { stateId: string; legalActions: unknown[] };
  SnapshotSchema.parse(snapshot); // 工具吐出的快照必须过协议 schema
  assert.ok(snapshot.stateId.length >= 8);
  assert.ok(snapshot.legalActions.length >= 1);

  // ★AI 代理国家必须能通过 MCP 锁定回合，否则房间永远等待
  const lock = await session.call(13, 'tools/call', { name: 'lock_orders', arguments: {} });
  const lockPayload = JSON.parse(((lock.body.result as { content: Array<{ text: string }> }).content[0]?.text) ?? 'null');
  assert.equal(lockPayload.locked, true);
});

test('F6 MCP tools/call 坏样本：arguments 带多余字段 → JSON-RPC -32602 MALFORMED_PAYLOAD', async () => {
  const session = await mcpInitialize(joinQin.token);
  const bad = await session.call(20, 'tools/call', {
    name: 'submit_orders',
    arguments: { stateId: 'digest-12345', requestId: 'r1', commands: [{ kind: 'set_tax', rate: 0.2 }], evil: true },
  });
  const err = bad.body.error as { code: number; message: string };
  assert.equal(err.code, -32602);
  assert.ok(err.message.includes(RejectionCode.MALFORMED_PAYLOAD));

  // 对照好样本：同工具去掉多余字段能走到引擎（CAS 失败也算走到，说明形状过关）
  const digest = await currentDigest();
  const good = await session.call(21, 'tools/call', {
    name: 'submit_orders',
    arguments: envelope(digest, 'req-mcp-good'),
  });
  assert.equal(good.body.error, undefined);
  const payload = JSON.parse((good.body.result as { content: Array<{ text: string }> }).content[0]?.text ?? '{}') as { status: string };
  assert.equal(payload.status, 'completed');
});

test('F7 MCP estimate_march 只消费引擎 estimate：命中返回 powerRatio；未命中如实 found:false', async () => {
  const session = await mcpInitialize(joinQin.token);
  const hit = await session.call(30, 'tools/call', { name: 'estimate_march', arguments: { unitId: 'u_qin_1', toRegion: 'r_handan' } });
  const hitPayload = JSON.parse((hit.body.result as { content: Array<{ text: string }> }).content[0]?.text ?? '{}') as {
    found: boolean; matches: Array<{ legalActionId: string; estimate: { powerRatio: number } | null }>;
  };
  assert.equal(hitPayload.found, true);
  assert.equal(hitPayload.matches[0]?.legalActionId, 'attack:u_qin_1:r_handan');
  assert.equal(hitPayload.matches[0]?.estimate?.powerRatio, 1.3); // ★引擎预算值原样透传

  const miss = await session.call(31, 'tools/call', { name: 'estimate_march', arguments: { unitId: 'u_ghost', toRegion: 'r_nowhere' } });
  const missPayload = JSON.parse((miss.body.result as { content: Array<{ text: string }> }).content[0]?.text ?? '{}') as { found: boolean };
  assert.equal(missPayload.found, false); // 坏样本对照：清单外动作不得编造数值
});

test('F8 MCP validate_orders：新鲜 stateId + 锚定命令 → ok；旧 stateId / 未锚定 → 带原因失败', async () => {
  const session = await mcpInitialize(joinQin.token);
  const digest = await currentDigest();

  const good = await session.call(40, 'tools/call', {
    name: 'validate_orders',
    arguments: { stateId: digest, commands: [{ kind: 'attack', unitId: 'u_qin_1', targetRegion: 'r_handan' }] },
  });
  const goodPayload = JSON.parse((good.body.result as { content: Array<{ text: string }> }).content[0]?.text ?? '{}') as { ok: boolean; stateIdFresh: boolean };
  assert.equal(goodPayload.ok, true);
  assert.equal(goodPayload.stateIdFresh, true);

  const stale = await session.call(41, 'tools/call', {
    name: 'validate_orders',
    arguments: { stateId: 'digest-1', commands: [{ kind: 'attack', unitId: 'u_qin_1', targetRegion: 'r_handan' }] },
  });
  const stalePayload = JSON.parse((stale.body.result as { content: Array<{ text: string }> }).content[0]?.text ?? '{}') as { ok: boolean; stateIdFresh: boolean };
  assert.equal(stalePayload.ok, false);
  assert.equal(stalePayload.stateIdFresh, false); // 坏样本：旧 stateId 必须被点名

  const unanchored = await session.call(42, 'tools/call', {
    name: 'validate_orders',
    arguments: { stateId: digest, commands: [{ kind: 'attack', unitId: 'u_ghost', targetRegion: 'r_nowhere' }] },
  });
  const unanchoredPayload = JSON.parse((unanchored.body.result as { content: Array<{ text: string }> }).content[0]?.text ?? '{}') as {
    ok: boolean; results: Array<{ problems: string[] }>;
  };
  assert.equal(unanchoredPayload.ok, false);
  assert.ok((unanchoredPayload.results[0]?.problems ?? []).some((p) => p.includes('未锚定')));
});

test('F9 MCP spectate 是观战端显式分支：玩家会话调用被拒，观战会话拿全知视图', async () => {
  const playerSession = await mcpInitialize(joinQin.token);
  const denied = await playerSession.call(50, 'tools/call', { name: 'spectate', arguments: {} });
  const deniedResult = denied.body.result as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(deniedResult.isError, true);
  assert.ok((deniedResult.content[0]?.text ?? '').includes(RejectionCode.SEAT_NOT_AUTHORIZED));

  const specSession = await mcpInitialize(joinSpec.token);
  const allowed = await specSession.call(51, 'tools/call', { name: 'spectate', arguments: {} });
  const specSnapshot = JSON.parse((allowed.body.result as { content: Array<{ text: string }> }).content[0]?.text ?? 'null') as { recipient: string };
  assert.equal(specSnapshot.recipient, 'spectator');

  // 观战会话的写工具一律拒绝
  const specWrite = await specSession.call(52, 'tools/call', {
    name: 'submit_orders',
    arguments: envelope('digest-12345', 'req-spec-mcp'),
  });
  const specWriteResult = specWrite.body.result as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(specWriteResult.isError, true);
  assert.ok((specWriteResult.content[0]?.text ?? '').includes(RejectionCode.SEAT_NOT_AUTHORIZED));
});

test('F10 MCP 有状态推送：GET SSE 流上收到与 WS 同源的事件 notification', async () => {
  const session = await mcpInitialize(joinQin.token);
  // 打开 server→client 推送流（只有有状态 session 才可能）
  const resp = await fetch(`${BASE}/mcp`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${joinQin.token}`,
      'mcp-session-id': session.sid,
      Accept: 'text/event-stream',
    },
  });
  assert.equal(resp.status, 200);
  assert.ok(resp.body !== null);
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let accumulated = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        accumulated += decoder.decode(value, { stream: true });
      }
    } catch { /* 流被关闭 */ }
  })();

  await sleep(150); // 等 SSE 建立
  const turnStarted: DomainEvent = { type: 'turn_started', turn: 7, deadline: {} };
  fake.emitEvent(room1.roomId, turnStarted);

  await until(() => accumulated.includes('domain_event') && accumulated.includes('notifications/message'), 3000, 'MCP 事件推送');
  await reader.cancel().catch(() => undefined);
  await pump;
});

// ─────────────────────────────────────────────────────────────
// G. healthcheck 探针（真实子进程，退出码即闸门）
// ─────────────────────────────────────────────────────────────

test('G1 healthcheck.ts：对的端口退出码 0；坏样本：错的端口退出码非 0', async () => {
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
  // ★必须用异步 execFile：spawnSync 会阻塞测试进程事件循环，被测 HTTP 服务无法应答
  const run = (port: string): Promise<number> =>
    new Promise((resolve) => {
      execFile(
        process.execPath,
        ['--experimental-strip-types', 'src/healthcheck.ts'],
        { cwd: repoRoot, env: { ...process.env, PORT: port } },
        (err) => resolve(err === null ? 0 : ((err as { code?: number }).code ?? 1)),
      );
    });

  assert.equal(await run(String(addr.port)), 0, 'healthcheck 好样本应退出 0');
  assert.notEqual(await run('1'), 0); // 坏样本：连不上必须非 0
});
