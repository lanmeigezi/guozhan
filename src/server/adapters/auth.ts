/**
 * 鉴权适配器 —— Bearer 令牌 + Origin 白名单 + CORS + 席位令牌→Principal。
 *
 * 铁律（aonw ADR 0013）：**actor 身份只从令牌推导**，请求体里声称的身份一律不信。
 * 本文件是适配器层唯一允许做"你是谁"判断的地方；规则裁决永远归核心。
 *
 * P4 薄适配器：这里只校验传输层的凭据形状，不碰任何游戏状态。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Principal, RoomManager } from '../room/types.ts';

/** 请求体上限 2MB（轻量服务器防内存放大） */
export const DEFAULT_BODY_LIMIT = 2 * 1024 * 1024;
/** 管理令牌最小长度（compose 里同样强制 ≥24） */
export const MIN_TOKEN_LENGTH = 24;

/** 未配置 GUOZHAN_TOKEN 时生成一次性令牌（43 字符 base64url） */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * 常量时间令牌比较。
 * 先 sha256 归一化长度再 timingSafeEqual —— 直接比较长度不等的 Buffer 会抛错，
 * 而先哈希可把"长度泄露"与"短路比较"两个侧信道一起消掉。
 */
export function safeTokenEqual(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/** 请求体超限（适配器翻成 413） */
export class PayloadTooLargeError extends Error {
  constructor(limit: number) {
    super(`请求体超过上限 ${limit} 字节`);
    this.name = 'PayloadTooLargeError';
  }
}

/** JSON 解析失败（适配器翻成 400 MALFORMED_PAYLOAD） */
export class MalformedBodyError extends Error {
  constructor(detail: string) {
    super(`请求体不是合法 JSON：${detail}`);
    this.name = 'MalformedBodyError';
  }
}

export interface AuthConfig {
  /** 管理令牌；null/undefined = 未配置（由调用方生成并打到 stderr） */
  readonly adminToken?: string | null;
  /** Origin 白名单（精确匹配）。空数组 = 拒绝一切带 Origin 的浏览器请求（fail-closed） */
  readonly origins?: readonly string[];
  readonly bodyLimit?: number;
}

export interface Auth {
  readonly adminToken: string;
  /** true = 令牌是本次启动生成的（main 负责打到 stderr） */
  readonly tokenGenerated: boolean;
  readonly origins: readonly string[];
  readonly bodyLimit: number;

  isAdminToken(token: string | null | undefined): boolean;
  /** 无 Origin 头（curl / 服务端调用）放行；有 Origin 必须在白名单内 */
  originAllowed(req: IncomingMessage): boolean;
  corsHeaders(req: IncomingMessage): Record<string, string>;
  /** 读原始 body，超上限抛 PayloadTooLargeError（→413） */
  readBody(req: IncomingMessage): Promise<Buffer>;
  /** 读 JSON body；解析失败抛 MalformedBodyError（→400 MALFORMED_PAYLOAD） */
  readJsonBody(req: IncomingMessage): Promise<unknown>;
  /** 席位令牌 → Principal（actor 身份的唯一来源）；无效令牌返回 null */
  resolvePrincipal(token: string): Promise<Principal | null>;
}

export function bearerFrom(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? (m[1] as string) : null;
}

export function createAuth(config: AuthConfig, roomManager: RoomManager): Auth {
  const provided = config.adminToken ?? null;
  if (provided !== null && provided.length < MIN_TOKEN_LENGTH) {
    // fail-closed：短令牌直接拒绝启动，而不是静默放行
    throw new Error(`GUOZHAN_TOKEN 长度 ${provided.length} < ${MIN_TOKEN_LENGTH}，拒绝启动`);
  }
  const adminToken = provided ?? generateToken();
  const origins = [...(config.origins ?? [])];
  const bodyLimit = config.bodyLimit ?? DEFAULT_BODY_LIMIT;

  function isAdminToken(token: string | null | undefined): boolean {
    if (typeof token !== 'string' || token.length === 0) return false;
    return safeTokenEqual(token, adminToken);
  }

  function originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (origin === undefined) return true; // 非浏览器客户端不带 Origin
    if (typeof origin !== 'string') return false;
    return origins.includes(origin);
  }

  function corsHeaders(req: IncomingMessage): Record<string, string> {
    const origin = req.headers.origin;
    const headers: Record<string, string> = {
      Vary: 'Origin',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, mcp-session-id, Last-Event-ID',
      'Access-Control-Expose-Headers': 'mcp-session-id',
      'Access-Control-Max-Age': '600',
    };
    if (typeof origin === 'string' && origins.includes(origin)) {
      headers['Access-Control-Allow-Origin'] = origin;
    }
    // Chrome Private Network Access：公网页面访问内网服务时的预检要求
    if (req.headers['access-control-request-private-network'] === 'true') {
      headers['Access-Control-Allow-Private-Network'] = 'true';
    }
    return headers;
  }

  function readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let overflowed = false;
      req.on('data', (chunk: Buffer) => {
        if (overflowed) return; // ★继续排干但不再累积：内存有界，且客户端能完整收到 413
        size += chunk.length;
        if (size > bodyLimit) {
          overflowed = true;
          chunks.length = 0;
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (overflowed) reject(new PayloadTooLargeError(bodyLimit));
        else resolve(Buffer.concat(chunks));
      });
      req.on('error', (err) => {
        reject(err);
      });
    });
  }

  async function readJsonBody(req: IncomingMessage): Promise<unknown> {
    const raw = await readBody(req);
    if (raw.length === 0) throw new MalformedBodyError('空请求体');
    try {
      return JSON.parse(raw.toString('utf8'));
    } catch (err) {
      throw new MalformedBodyError(err instanceof Error ? err.message : String(err));
    }
  }

  async function resolvePrincipal(token: string): Promise<Principal | null> {
    if (token.length === 0) return null;
    const resumed = await roomManager.resumeSeat(token);
    if (resumed === null) return null;
    const { room, seat } = resumed;
    // ★Principal 的每个字段都来自令牌换回的席位记录，绝不来自请求载荷
    return {
      roomId: room.roomId,
      seatId: seat.seatId,
      kind: seat.kind,
      factionId: seat.factionId,
      readOnly: seat.kind === 'spectator',
    };
  }

  return {
    adminToken,
    tokenGenerated: provided === null,
    origins,
    bodyLimit,
    isAdminToken,
    originAllowed,
    corsHeaders,
    readBody,
    readJsonBody,
    resolvePrincipal,
  };
}

/** 从 env 读鉴权配置（main.ts 用；GUOZHAN_ORIGINS 逗号分隔） */
export function authConfigFromEnv(env: Readonly<Record<string, string | undefined>>): AuthConfig {
  return {
    adminToken: env.GUOZHAN_TOKEN ?? null,
    origins: (env.GUOZHAN_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  };
}
