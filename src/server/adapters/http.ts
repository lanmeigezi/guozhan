/**
 * HTTP 适配器 —— 裸 node:http 路由（刻意零框架）。
 *
 * 为什么不用 express/fastify/hono：
 *   ① 路由总量 <20 条，少一层框架 = 更快冷启动 + 更小内存 + 更小攻击面；
 *   ② MCP SDK 的 StreamableHTTPServerTransport.handleRequest 要原生 req/res；
 *   ③ 1-2 核轻量服务器的刻意选择（架构文档 §2）。
 *
 * P4 薄适配器铁律：本文件只做「解析 → zod 校验传输形状 → 调 RoomManager →
 * 把拒绝码翻成 HTTP 状态」，**绝不裁决规则**。
 * actor 身份只从令牌推导（auth.resolvePrincipal），载荷里声称的身份一律不信。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { CommandEnvelopeSchema } from '../../protocol/commands.ts';
import type { CommandEnvelope } from '../../protocol/commands.ts';
import type { CommandResult } from '../../protocol/commands.ts';
import { REJECTION_HTTP_STATUS, RejectionCode } from '../../protocol/rejections.ts';
import type { ScenarioMeta } from '../config-loader.ts';
import type { Principal, RoomInfo, RoomManager, SeatId } from '../room/types.ts';
import type { PublicUser, UserService } from '../users/service.ts';
import { UserServiceError } from '../users/service.ts';
import {
  bearerFrom,
  MalformedBodyError,
  PayloadTooLargeError,
  type Auth,
} from './auth.ts';
// 仅类型导入：http.ts 运行时不拖 MCP SDK（main.ts 才装配它）
import type { McpHttpHandler } from './mcp.ts';

// ─────────────────────────────────────────────────────────────
// 传输层错误与响应工具
// ─────────────────────────────────────────────────────────────

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(payload.byteLength),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

export function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  extraHeaders?: Record<string, string>,
): void {
  sendJson(res, status, { error: { code, message } }, extraHeaders);
}

/** 拒绝码 → HTTP 状态。★唯一真源是 REJECTION_HTTP_STATUS 表，这里不自造映射 */
export function httpStatusForRejection(code: string): number | null {
  const table = REJECTION_HTTP_STATUS as Readonly<Record<string, number>>;
  const status = table[code];
  return typeof status === 'number' ? status : null;
}

/** CommandResult → 三件套 wire 形状（P8） */
export interface CommandResultWire {
  readonly status: CommandResult['status'];
  readonly completedSteps: number;
  readonly rejections: ReadonlyArray<{
    index: number;
    code: string;
    message: string;
    detail?: unknown;
  }>;
  readonly replayed: boolean;
  readonly stateId: string;
  readonly turn: number;
}

export function toWireResult(result: CommandResult): CommandResultWire {
  return {
    status: result.status,
    completedSteps: result.completedSteps,
    rejections: result.steps
      .filter((s) => !s.ok)
      .map((s) => ({
        index: s.index,
        code: s.code ?? 'INTERNAL',
        message: s.message ?? '',
        ...(s.detail !== undefined ? { detail: s.detail } : {}),
      })),
    replayed: result.replayed,
    stateId: result.stateId,
    turn: result.turn,
  };
}

/**
 * 提交结果 → HTTP 状态。
 *   failed（第 0 步就败）→ 按首个拒绝码查 REJECTION_HTTP_STATUS 表；查不到用 422
 *   completed / partial → 200（partial 的已提交步骤**不回滚**，必须让客户端拿到回执）
 *   replayed → 200（幂等命中，返回原回执）
 */
export function httpStatusForResult(result: CommandResult): number {
  if (result.status === 'failed' && !result.replayed) {
    const first = result.steps.find((s) => !s.ok);
    if (first?.code !== undefined) {
      const mapped = httpStatusForRejection(first.code);
      if (mapped !== null) return mapped;
    }
    return 422;
  }
  return 200;
}

// ─────────────────────────────────────────────────────────────
// 端点级 zod schema（只校验传输形状，不裁决规则）
// ─────────────────────────────────────────────────────────────

const idParamSchema = z.string().min(1).max(64);

export const CreateRoomBodySchema = z
  .object({
    name: z.string().min(1).max(128),
    scenarioId: z.string().min(1).max(64),
    rootSeed: z.string().min(1).max(128).optional(),
    humanFactions: z.array(z.string().min(1).max(64)).max(32).optional(),
    unlimitedTurns: z.boolean().optional(),
    aiOverrides: z
      .record(
        z.string().min(1).max(64),
        z.object({ autoCommit: z.boolean().optional(), llmDriven: z.boolean().optional() }).strict(),
      )
      .optional(),
  })
  .strict();

export const JoinRoomBodySchema = z
  .object({
    seatId: z.string().min(1).max(64).optional(),
    asSpectator: z.boolean().optional(),
  })
  .strict();

export const RegisterBodySchema = z
  .object({
    username: z.string().min(2).max(24),
    password: z.string().min(8).max(128),
    displayName: z.string().max(32).optional(),
  })
  .strict();

export const LoginBodySchema = z
  .object({
    username: z.string().min(2).max(24),
    password: z.string().min(8).max(128),
  })
  .strict();

export const KickBodySchema = z
  .object({
    userId: z.string().min(1).max(64),
    ban: z.boolean().optional(),
    reason: z.string().max(200).optional(),
  })
  .strict();

export const UserIdBodySchema = z.object({ userId: z.string().min(1).max(64) }).strict();

export const AdoptAdviceBodySchema = z
  .object({
    commandIndices: z.array(z.number().int().min(0)).max(16).optional(),
  })
  .strict();

export const EventsQuerySchema = z
  .object({
    from: z.coerce.number().int().min(0).optional(),
  })
  .strict();

// ─────────────────────────────────────────────────────────────
// 处理器
// ─────────────────────────────────────────────────────────────

export interface HttpDeps {
  readonly auth: Auth;
  readonly roomManager: RoomManager;
  /** 账号系统（可选；不注入时保持旧的纯管理令牌模式） */
  readonly userService?: UserService;
  /** 剧本清单（main.ts 启动时装载好元数据；目录扫描发现，非白名单） */
  readonly listScenarios: () => readonly ScenarioMeta[];
  /** MCP 适配器（可选注入；/mcp 路由委托给它） */
  readonly mcp?: McpHttpHandler;
}

interface AuthContext {
  readonly admin: boolean;
  readonly principal: Principal | null;
  readonly user: PublicUser | null;
}

async function authenticate(deps: HttpDeps, req: IncomingMessage): Promise<AuthContext> {
  const token = bearerFrom(req);
  if (token === null) throw new HttpError(401, 'UNAUTHORIZED', '缺少 Bearer 令牌');
  if (deps.auth.isAdminToken(token)) return { admin: true, principal: null, user: null };
  const principal = await deps.auth.resolvePrincipal(token);
  if (principal !== null) return { admin: false, principal, user: null };
  const user = deps.userService?.resolveSession(token) ?? null;
  if (user !== null) return { admin: user.role === 'admin', principal: null, user };
  throw new HttpError(401, 'UNAUTHORIZED', '令牌无效或席位不存在');
}

function requireAdmin(ctx: AuthContext): void {
  if (!ctx.admin) throw new HttpError(403, 'ADMIN_REQUIRED', '该端点需要管理令牌');
}

function requireUser(ctx: AuthContext): PublicUser {
  if (ctx.user === null) throw new HttpError(401, 'UNAUTHORIZED', '该端点需要账号会话');
  return ctx.user;
}

function requireUserOrAdmin(ctx: AuthContext): PublicUser | null {
  if (ctx.admin) return ctx.user;
  return requireUser(ctx);
}

/** 要求某房间的席位主体；返回 recipient（观战席位 → 'spectator' 显式分支） */
function requireSeat(ctx: AuthContext, roomId: string): { principal: Principal; recipient: SeatId | 'spectator' } {
  if (ctx.admin) {
    // 管理令牌调试用：给全知观战视图（显式分支，不是"漏裁剪"）
    return {
      principal: { roomId, seatId: 'admin', kind: 'spectator', factionId: null, readOnly: true },
      recipient: 'spectator',
    };
  }
  const p = ctx.principal;
  if (p === null || p.roomId !== roomId) {
    throw new HttpError(403, RejectionCode.SEAT_NOT_AUTHORIZED, '席位令牌无权访问该房间');
  }
  return { principal: p, recipient: p.kind === 'spectator' ? 'spectator' : p.seatId };
}

function requireWritable(seat: { principal: Principal }): void {
  if (seat.principal.readOnly) {
    throw new HttpError(403, RejectionCode.SEAT_NOT_AUTHORIZED, '观战席位只读，禁止写操作');
  }
}

function parseWith<T>(schema: z.ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issue = r.error.issues[0];
    const path = issue?.path.join('.') ?? '';
    throw new HttpError(
      400,
      RejectionCode.MALFORMED_PAYLOAD,
      `载荷不符合 schema${path ? `（${path}）` : ''}：${issue?.message ?? '未知原因'}`,
    );
  }
  return r.data;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 一次性事件补发：借用 subscribe(roomId, recipient, fromOffset, sink) 收齐积压后返回。
 * 实现方可能同步或异步投递积压，因此给一个小的宽限窗。
 */
async function collectEvents(
  rm: RoomManager,
  roomId: string,
  recipient: SeatId | 'spectator',
  from: number,
  graceMs = 25,
): Promise<{ events: Array<{ offset: number; event: unknown }>; nextOffset: number }> {
  const events: Array<{ offset: number; event: unknown }> = [];
  const unsubscribe = rm.subscribe(roomId, recipient, from, (batch) => {
    for (const e of batch.events) events.push({ offset: e.offset, event: e.event });
  });
  await sleep(graceMs);
  unsubscribe();
  const nextOffset = await rm.nextOffset(roomId);
  return { events, nextOffset };
}

export function createHttpHandler(deps: HttpDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const { auth, roomManager } = deps;

  return function handler(req: IncomingMessage, res: ServerResponse): void {
    const cors = auth.corsHeaders(req);
    route(req, res, cors).catch((err: unknown) => {
      try {
        if (err instanceof HttpError) {
          sendError(res, err.status, err.code, err.message, cors);
        } else if (err instanceof UserServiceError) {
          sendError(res, err.status, err.code, err.message, cors);
        } else if (err instanceof PayloadTooLargeError) {
          // readBody 已把请求体排干，连接可安全复用
          sendError(res, 413, 'PAYLOAD_TOO_LARGE', err.message, cors);
        } else if (err instanceof MalformedBodyError) {
          sendError(res, 400, RejectionCode.MALFORMED_PAYLOAD, err.message, cors);
        } else if (err instanceof z.ZodError) {
          sendError(res, 400, RejectionCode.MALFORMED_PAYLOAD, err.issues[0]?.message ?? 'schema 校验失败', cors);
        } else {
          // RoomManager 抛出的带拒绝码错误也走同一张映射表
          const code = (err as { code?: unknown })?.code;
          const mapped = typeof code === 'string' ? httpStatusForRejection(code) : null;
          if (mapped !== null) {
            sendError(res, mapped, code as string, (err as Error).message, cors);
          } else {
            const message = err instanceof Error ? err.message : String(err);
            sendError(res, 500, 'INTERNAL', message, cors);
          }
        }
      } catch {
        // 响应已发出/连接已断，无处可报
        try { res.destroy(); } catch { /* noop */ }
      }
    });
  };

  async function route(req: IncomingMessage, res: ServerResponse, cors: Record<string, string>): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://guozhan.internal');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // CORS 预检：Origin 不合法也必须在预检阶段拒绝
    if (method === 'OPTIONS') {
      if (!auth.originAllowed(req)) {
        sendError(res, 403, 'ORIGIN_NOT_ALLOWED', `Origin 不在白名单：${String(req.headers.origin)}`, cors);
        return;
      }
      res.writeHead(204, cors);
      res.end();
      return;
    }

    // Origin 白名单（有 Origin 头的浏览器请求必须在名单内；curl/服务端无 Origin 放行）
    if (!auth.originAllowed(req)) {
      sendError(res, 403, 'ORIGIN_NOT_ALLOWED', `Origin 不在白名单：${String(req.headers.origin)}`, cors);
      return;
    }

    // ── /health（无鉴权，供 HEALTHCHECK）──
    if (path === '/health' && method === 'GET') {
      sendJson(res, 200, { status: 'ok', uptimeSec: Math.round(process.uptime()) }, cors);
      return;
    }

    // ── /mcp（委托 MCP 适配器；鉴权在会话初始化时绑定 Principal）──
    if (path === '/mcp') {
      if (deps.mcp === undefined) {
        sendError(res, 404, 'NOT_FOUND', 'MCP 适配器未启用', cors);
        return;
      }
      if (method === 'POST') {
        const raw = await auth.readBody(req);
        let body: unknown;
        try {
          body = raw.length > 0 ? JSON.parse(raw.toString('utf8')) : undefined;
        } catch (err) {
          throw new MalformedBodyError(err instanceof Error ? err.message : String(err));
        }
        await deps.mcp.handlePost(req, res, body, cors);
        return;
      }
      if (method === 'GET') {
        await deps.mcp.handleGet(req, res, cors);
        return;
      }
      if (method === 'DELETE') {
        await deps.mcp.handleDelete(req, res, cors);
        return;
      }
      sendError(res, 405, 'METHOD_NOT_ALLOWED', '/mcp 只接受 POST/GET/DELETE', cors);
      return;
    }

    // ── 账号：注册 / 登录 / 登出 / 我的资料 ──
    if (path === '/api/auth/register' && method === 'POST') {
      const svc = deps.userService;
      if (!svc) throw new HttpError(503, 'USERS_DISABLED', '该服务未启用账号系统');
      const body = parseWith(RegisterBodySchema, await auth.readJsonBody(req));
      const result = svc.register({
        username: body.username,
        password: body.password,
        ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
      });
      sendJson(res, 201, result, cors);
      return;
    }
    if (path === '/api/auth/login' && method === 'POST') {
      const svc = deps.userService;
      if (!svc) throw new HttpError(503, 'USERS_DISABLED', '该服务未启用账号系统');
      const body = parseWith(LoginBodySchema, await auth.readJsonBody(req));
      sendJson(res, 200, svc.login(body), cors);
      return;
    }
    if (path === '/api/auth/logout' && method === 'POST') {
      const token = bearerFrom(req);
      if (token !== null) deps.userService?.logout(token);
      sendJson(res, 200, { loggedOut: true }, cors);
      return;
    }
    if (path === '/api/me' && method === 'GET') {
      const ctx = await authenticate(deps, req);
      const user = requireUser(ctx);
      const memberships = deps.userService?.listMemberships(user.id) ?? [];
      const rooms: Array<RoomInfo & { seatId: string; joinedAt: number }> = [];
      for (const membership of memberships) {
        const room = await roomManager.getRoom(membership.roomId);
        if (!room) continue;
        rooms.push({ ...room, seatId: membership.seatId, joinedAt: membership.joinedAt });
      }
      sendJson(res, 200, {
        user,
        rooms,
        hostedRooms: rooms.filter((r) => deps.userService?.getRoomHost(r.roomId)?.userId === user.id).map((r) => r.roomId),
      }, cors);
      return;
    }

    if (path === '/api/admin/users' && method === 'GET') {
      const ctx = await authenticate(deps, req);
      requireAdmin(ctx);
      const svc = deps.userService;
      if (!svc) throw new HttpError(503, 'USERS_DISABLED', '该服务未启用账号系统');
      sendJson(res, 200, { users: svc.listUsers(200) }, cors);
      return;
    }

    // ── /api/scenarios ──
    if (path === '/api/scenarios' && method === 'GET') {
      const ctx = await authenticate(deps, req);
      if (!ctx.admin && ctx.user === null) throw new HttpError(401, 'UNAUTHORIZED', '需要管理令牌或账号会话');
      sendJson(res, 200, { scenarios: deps.listScenarios() }, cors);
      return;
    }

    // ── /api/rooms ──
    if (path === '/api/rooms') {
      const ctx = await authenticate(deps, req);
      requireUserOrAdmin(ctx);
      if (method === 'GET') {
        const rooms = await roomManager.listRooms();
        sendJson(res, 200, {
          rooms: rooms.map((room) => ({
            ...room,
            host: deps.userService?.getRoomHost(room.roomId) ?? null,
            members: deps.userService?.listMembers(room.roomId) ?? [],
          })),
        }, cors);
        return;
      }
      if (method === 'POST') {
        const body = parseWith(CreateRoomBodySchema, await auth.readJsonBody(req));
        const room = await roomManager.createRoom({
          name: body.name,
          scenarioId: body.scenarioId,
          ...(body.rootSeed !== undefined ? { rootSeed: body.rootSeed } : {}),
          ...(body.humanFactions !== undefined ? { humanFactions: body.humanFactions } : {}),
          ...(body.unlimitedTurns !== undefined ? { unlimitedTurns: body.unlimitedTurns } : {}),
          ...(body.aiOverrides !== undefined
            ? { aiOverrides: body.aiOverrides as Readonly<Record<string, { autoCommit?: boolean; llmDriven?: boolean }>> }
            : {}),
        });
        // 账号建房 = 成为房主；管理令牌建房仍是无主调试房
        if (ctx.user !== null) deps.userService?.setRoomHost(room.roomId, ctx.user.id);
        sendJson(res, 201, { room }, cors);
        return;
      }
      sendError(res, 405, 'METHOD_NOT_ALLOWED', '/api/rooms 只接受 GET/POST', cors);
      return;
    }

    // ── /api/rooms/:id 及其子路由 ──
    const roomMatch = /^\/api\/rooms\/([^/]+)$/.exec(path);
    if (roomMatch) {
      const roomId = decodeURIComponent(roomMatch[1] as string);
      parseWith(idParamSchema, roomId);
      const ctx = await authenticate(deps, req);
      if (method === 'GET') {
        if (!ctx.admin && ctx.user === null) requireSeat(ctx, roomId); // 房间成员或管理可见
        const room = await roomManager.getRoom(roomId);
        if (room === null) {
          sendError(res, 404, 'NOT_FOUND', `房间不存在：${roomId}`, cors);
          return;
        }
        sendJson(res, 200, {
          room: {
            ...room,
            host: deps.userService?.getRoomHost(roomId) ?? null,
            members: deps.userService?.listMembers(roomId) ?? [],
            ...(ctx.user !== null ? { mySeatId: deps.userService?.getMember(roomId, ctx.user.id)?.seatId ?? null } : {}),
          },
        }, cors);
        return;
      }
      if (method === 'DELETE') {
        if (!ctx.admin) {
          const user = requireUser(ctx);
          const host = deps.userService?.getRoomHost(roomId);
          if (!host || host.userId !== user.id) throw new HttpError(403, 'HOST_REQUIRED', '只有房主或管理令牌可以删除房间');
        }
        await roomManager.deleteRoom(roomId);
        deps.userService?.deleteRoomData(roomId);
        sendJson(res, 200, { deleted: roomId }, cors);
        return;
      }
      sendError(res, 405, 'METHOD_NOT_ALLOWED', '只接受 GET/DELETE', cors);
      return;
    }

    // ── 完整对局记忆：给酒馆/外部压缩器的原始历史 ──
    const memoryMatch = /^\/api\/rooms\/([^/]+)\/memory$/.exec(path);
    if (memoryMatch) {
      const roomId = decodeURIComponent(memoryMatch[1] as string);
      parseWith(idParamSchema, roomId);
      if (method !== 'GET') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', '对局记忆只接受 GET', cors);
        return;
      }
      const ctx = await authenticate(deps, req);
      const seat = requireSeat(ctx, roomId);
      const memory = await roomManager.getMatchMemory(roomId, seat.recipient);
      sendJson(res, 200, { memory }, cors);
      return;
    }

    const joinMatch = /^\/api\/rooms\/([^/]+)\/join$/.exec(path);
    if (joinMatch) {
      const roomId = decodeURIComponent(joinMatch[1] as string);
      const ctx = await authenticate(deps, req);
      if (!ctx.admin && ctx.user === null) requireAdmin(ctx);
      if (method !== 'POST') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', '只接受 POST', cors);
        return;
      }
      const raw = await auth.readJsonBody(req).catch(() => ({}));
      const body = parseWith(JoinRoomBodySchema, raw);
      if (ctx.user !== null) {
        const svc = deps.userService;
        if (!svc) throw new HttpError(503, 'USERS_DISABLED', '该服务未启用账号系统');
        if (svc.isBanned(roomId, ctx.user.id)) {
          throw new HttpError(403, 'ROOM_BANNED', '你已被该房间封禁，无法加入');
        }
        const existing = svc.getMember(roomId, ctx.user.id);
        if (existing) {
          const reclaimed = await roomManager.reclaimSeat(roomId, existing.seatId);
          if (reclaimed) {
            sendJson(res, 200, { seat: reclaimed.seat, token: reclaimed.token }, cors);
            return;
          }
          // 原席位已不存在/AI 接管：清掉旧关系后按普通加入处理
          svc.removeMember(roomId, ctx.user.id);
        }
        const joined = await roomManager.joinRoom(roomId, {
          ...(body.seatId !== undefined ? { seatId: body.seatId } : {}),
          ...(body.asSpectator !== undefined ? { asSpectator: body.asSpectator } : {}),
        });
        svc.setMember(roomId, ctx.user.id, joined.seat.seatId);
        sendJson(res, 200, { seat: joined.seat, token: joined.token }, cors);
        return;
      }
      // 管理令牌：保留原来的"调试/发放席位"路径
      const joined = await roomManager.joinRoom(roomId, {
        ...(body.seatId !== undefined ? { seatId: body.seatId } : {}),
        ...(body.asSpectator !== undefined ? { asSpectator: body.asSpectator } : {}),
      });
      sendJson(res, 200, { seat: joined.seat, token: joined.token }, cors);
      return;
    }

    // ── 房主管理：踢人 / 封禁 / 解封 / 离开 ──
    const kickMatch = /^\/api\/rooms\/([^/]+)\/kick$/.exec(path);
    if (kickMatch) {
      const roomId = decodeURIComponent(kickMatch[1] as string);
      if (method !== 'POST') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', '只接受 POST', cors);
        return;
      }
      const ctx = await authenticate(deps, req);
      const svc = deps.userService;
      if (!svc) throw new HttpError(503, 'USERS_DISABLED', '该服务未启用账号系统');
      if (!ctx.admin) {
        const user = requireUser(ctx);
        const host = svc.getRoomHost(roomId);
        if (!host || host.userId !== user.id) throw new HttpError(403, 'HOST_REQUIRED', '只有房主或管理令牌可以踢人');
      }
      const body = parseWith(KickBodySchema, await auth.readJsonBody(req));
      const target = svc.getMember(roomId, body.userId);
      if (!target) throw new HttpError(404, 'MEMBER_NOT_FOUND', '该账号不在房间成员中');
      const host = svc.getRoomHost(roomId);
      if (host?.userId === target.userId) throw new HttpError(409, 'CANNOT_KICK_HOST', '不能踢出房主');
      const seat = await roomManager.revokeSeat(roomId, target.seatId, { asAi: true });
      svc.removeMember(roomId, target.userId);
      if (body.ban === true) svc.ban(roomId, target.userId, body.reason ?? '');
      sendJson(res, 200, { kicked: target.userId, banned: body.ban === true, seat }, cors);
      return;
    }

    const unbanMatch = /^\/api\/rooms\/([^/]+)\/unban$/.exec(path);
    if (unbanMatch) {
      const roomId = decodeURIComponent(unbanMatch[1] as string);
      if (method !== 'POST') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', '只接受 POST', cors);
        return;
      }
      const ctx = await authenticate(deps, req);
      const svc = deps.userService;
      if (!svc) throw new HttpError(503, 'USERS_DISABLED', '该服务未启用账号系统');
      if (!ctx.admin) {
        const user = requireUser(ctx);
        const host = svc.getRoomHost(roomId);
        if (!host || host.userId !== user.id) throw new HttpError(403, 'HOST_REQUIRED', '只有房主或管理令牌可以解封');
      }
      const body = parseWith(UserIdBodySchema, await auth.readJsonBody(req));
      svc.unban(roomId, body.userId);
      sendJson(res, 200, { unbanned: body.userId }, cors);
      return;
    }

    const leaveMatch = /^\/api\/rooms\/([^/]+)\/leave$/.exec(path);
    if (leaveMatch) {
      const roomId = decodeURIComponent(leaveMatch[1] as string);
      if (method !== 'POST') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', '只接受 POST', cors);
        return;
      }
      const ctx = await authenticate(deps, req);
      const user = requireUser(ctx);
      const svc = deps.userService;
      if (!svc) throw new HttpError(503, 'USERS_DISABLED', '该服务未启用账号系统');
      const host = svc.getRoomHost(roomId);
      if (host?.userId === user.id) throw new HttpError(409, 'HOST_MUST_DELETE', '房主不能直接离开；请删除房间或先转移房主');
      const member = svc.getMember(roomId, user.id);
      if (!member) throw new HttpError(404, 'MEMBER_NOT_FOUND', '你不在该房间');
      await roomManager.revokeSeat(roomId, member.seatId, { asAi: true });
      svc.removeMember(roomId, user.id);
      sendJson(res, 200, { left: roomId }, cors);
      return;
    }

    // 本席位合法动作（含命令体）—— 给人类 UI 用；LLM 仍走快照里的 id 清单
    const actionsMatch = /^\/api\/rooms\/([^/]+)\/actions$/.exec(path);
    if (actionsMatch) {
      const roomId = decodeURIComponent(actionsMatch[1] as string);
      if (method !== 'GET') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', '只接受 GET', cors);
        return;
      }
      const ctx = await authenticate(deps, req);
      const seat = requireSeat(ctx, roomId);
      const result = await roomManager.getLegalActions(roomId, seat.principal.seatId);
      sendJson(res, 200, result, cors);
      return;
    }

    // 静态地图布局（纯展示层）。★与快照分开：坐标不塞进 Snapshot，避免每回合喂给 LLM
    const layoutMatch = /^\/api\/rooms\/([^/]+)\/layout$/.exec(path);
    if (layoutMatch) {
      const roomId = decodeURIComponent(layoutMatch[1] as string);
      if (method !== 'GET') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', '只接受 GET', cors);
        return;
      }
      const ctx = await authenticate(deps, req);
      requireSeat(ctx, roomId);
      const layout = await roomManager.getMapLayout(roomId);
      sendJson(res, 200, { layout }, cors);
      return;
    }

    const snapshotMatch = /^\/api\/rooms\/([^/]+)\/snapshot$/.exec(path);
    if (snapshotMatch) {
      const roomId = decodeURIComponent(snapshotMatch[1] as string);
      if (method !== 'GET') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', '只接受 GET', cors);
        return;
      }
      const ctx = await authenticate(deps, req);
      const { recipient } = requireSeat(ctx, roomId);
      const snapshot = await roomManager.getSnapshot(roomId, recipient);
      sendJson(res, 200, { snapshot }, cors);
      return;
    }

    const commandsMatch = /^\/api\/rooms\/([^/]+)\/commands$/.exec(path);
    if (commandsMatch) {
      const roomId = decodeURIComponent(commandsMatch[1] as string);
      if (method !== 'POST') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', '只接受 POST', cors);
        return;
      }
      const ctx = await authenticate(deps, req);
      const seat = requireSeat(ctx, roomId);
      requireWritable(seat);
      // ★信封三件套：stateId(CAS) + requestId(幂等) + commands[1..8]，.strict() 拒多余字段
      const envelope = parseWith(CommandEnvelopeSchema, await auth.readJsonBody(req));
      const result = await roomManager.submitCommands({ principal: seat.principal, envelope: envelope as unknown as CommandEnvelope });
      sendJson(res, httpStatusForResult(result), toWireResult(result), cors);
      return;
    }

    // ★军师模式的入口：人类席位按需请求一次建议（AI 席位由回合边界自动触发，不走这里）
    const adviceMatch = /^\/api\/rooms\/([^/]+)\/advice$/.exec(path);
    if (adviceMatch) {
      const roomId = decodeURIComponent(adviceMatch[1] as string);
      const ctx = await authenticate(deps, req);
      const seat = requireSeat(ctx, roomId);
      if (method === 'GET') {
        const pending = await roomManager.getPendingAdvice(roomId, seat.principal.seatId);
        sendJson(res, 200, { advice: pending }, cors);
        return;
      }
      if (method !== 'POST') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', '只接受 GET/POST', cors);
        return;
      }
      requireWritable(seat);
      const result = await roomManager.requestAdvice(roomId, seat.principal.seatId);
      sendJson(res, 200, result, cors);
      return;
    }

    const adoptMatch = /^\/api\/rooms\/([^/]+)\/advice\/([^/]+)\/adopt$/.exec(path);
    if (adoptMatch) {
      const roomId = decodeURIComponent(adoptMatch[1] as string);
      const adviceId = decodeURIComponent(adoptMatch[2] as string);
      if (method !== 'POST') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', '只接受 POST', cors);
        return;
      }
      const ctx = await authenticate(deps, req);
      const seat = requireSeat(ctx, roomId);
      requireWritable(seat);
      const raw = await auth.readJsonBody(req).catch(() => ({}));
      const body = parseWith(AdoptAdviceBodySchema, raw);
      const result = await roomManager.adoptAdvice({
        principal: seat.principal,
        adviceId,
        ...(body.commandIndices !== undefined ? { commandIndices: body.commandIndices } : {}),
      });
      sendJson(res, httpStatusForResult(result), toWireResult(result), cors);
      return;
    }

    const lockMatch = /^\/api\/rooms\/([^/]+)\/lock$/.exec(path);
    if (lockMatch) {
      const roomId = decodeURIComponent(lockMatch[1] as string);
      if (method !== 'POST') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', '只接受 POST', cors);
        return;
      }
      const ctx = await authenticate(deps, req);
      const seat = requireSeat(ctx, roomId);
      requireWritable(seat);
      const locked = await roomManager.lockOrders(seat.principal);
      sendJson(res, 200, locked, cors);
      return;
    }

    const turnMatch = /^\/api\/rooms\/([^/]+)\/turns\/([^/]+)$/.exec(path);
    if (turnMatch) {
      const roomId = decodeURIComponent(turnMatch[1] as string);
      const turnRaw = decodeURIComponent(turnMatch[2] as string);
      if (method !== 'GET') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', '只接受 GET', cors);
        return;
      }
      const turn = Number(turnRaw);
      if (!Number.isInteger(turn) || turn < 0) {
        throw new HttpError(400, RejectionCode.MALFORMED_PAYLOAD, `回合号必须是整数：${turnRaw}`);
      }
      const ctx = await authenticate(deps, req);
      requireSeat(ctx, roomId);
      const report = await roomManager.getTurnReport(roomId, turn);
      if (report === null) {
        sendError(res, 404, 'NOT_FOUND', `第 ${turn} 回合战报不存在`, cors);
        return;
      }
      sendJson(res, 200, { report }, cors);
      return;
    }

    const eventsMatch = /^\/api\/rooms\/([^/]+)\/events$/.exec(path);
    if (eventsMatch) {
      const roomId = decodeURIComponent(eventsMatch[1] as string);
      if (method !== 'GET') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', '只接受 GET', cors);
        return;
      }
      const query = parseWith(
        EventsQuerySchema,
        Object.fromEntries(url.searchParams.entries()),
      );
      const ctx = await authenticate(deps, req);
      const { recipient } = requireSeat(ctx, roomId);
      const from = query.from ?? 0;
      const collected = await collectEvents(roomManager, roomId, recipient, from);
      sendJson(res, 200, { roomId, from, ...collected }, cors);
      return;
    }

    sendError(res, 404, 'NOT_FOUND', `无此路由：${method} ${path}`, cors);
  }
}
