/**
 * WebSocket 适配器 —— 事件推送 + 断线重连补发 + 心跳 + 背压。
 *
 * 连接串：/ws?room=<roomId>&token=<席位令牌>&from=<offset>
 *   · token → Principal（actor 身份只从令牌来，auth.resolvePrincipal）
 *   · from  → 断线重连补发起点（event_log offset 单调递增）
 *   · 观战席位 recipient='spectator'（显式分支，全知视图；不是"漏裁剪"）
 *
 * 投递信封 = EventBatch（room/types.ts）：{roomId, events:[{offset,event}], stateDigest, turn}
 * 客户端应记录收到的最大 offset，重连时带 from=lastOffset+1。
 *
 * 背压策略（轻量服务器）：bufferedAmount 超高水位 → close(1013 Try Again Later)。
 * 事件带 offset 且可补发，断开重连即恢复 —— 这比在适配器里堆无界缓冲安全。
 *
 * P4：本文件不裁决规则、不投影事件（投影由 RoomManager.subscribe 在投递时做）。
 */
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { EventBatch, Principal, RoomManager, SeatId } from '../room/types.ts';
import type { Auth } from './auth.ts';

/** 单连接发送缓冲高水位（1MB）。超过即主动断开，让客户端带 offset 重连 */
export const WS_BACKPRESSURE_HIGH_WATER = 1 * 1024 * 1024;
/** 心跳间隔（30s ping；一个周期无 pong 即判死） */
export const WS_HEARTBEAT_INTERVAL_MS = 30_000;

export interface WsDeps {
  readonly auth: Auth;
  readonly roomManager: RoomManager;
}

interface AuthedUpgrade {
  readonly principal: Principal;
  readonly roomId: string;
  readonly from: number;
}

function failUpgrade(socket: import('node:stream').Duplex, status: number, code: string, message: string): void {
  const body = JSON.stringify({ error: { code, message } });
  socket.end(
    `HTTP/1.1 ${status} ${code}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
  socket.destroy();
}

/** 升级前校验：路径 / Origin / 令牌 / 房间归属 / from 参数 */
export async function authorizeUpgrade(deps: WsDeps, req: IncomingMessage): Promise<AuthedUpgrade> {
  const { auth } = deps;
  if (!auth.originAllowed(req)) {
    throw new WsAuthError(403, 'ORIGIN_NOT_ALLOWED', `Origin 不在白名单：${String(req.headers.origin)}`);
  }
  const url = new URL(req.url ?? '/', 'http://guozhan.internal');
  if (url.pathname !== '/ws') {
    throw new WsAuthError(404, 'NOT_FOUND', `无此升级路径：${url.pathname}`);
  }
  const token = url.searchParams.get('token');
  const room = url.searchParams.get('room');
  if (token === null || token.length === 0) {
    throw new WsAuthError(401, 'UNAUTHORIZED', '缺少 token 查询参数');
  }
  if (room === null || room.length === 0) {
    throw new WsAuthError(400, 'MALFORMED_PAYLOAD', '缺少 room 查询参数');
  }
  const fromRaw = url.searchParams.get('from') ?? '0';
  const from = Number(fromRaw);
  if (!Number.isInteger(from) || from < 0) {
    throw new WsAuthError(400, 'MALFORMED_PAYLOAD', `from 必须是非负整数：${fromRaw}`);
  }
  // ★Principal 只从令牌推导；管理令牌不能开 WS（它不是席位）
  const principal = await auth.resolvePrincipal(token);
  if (principal === null) {
    throw new WsAuthError(401, 'UNAUTHORIZED', '席位令牌无效');
  }
  if (principal.roomId !== room) {
    throw new WsAuthError(403, 'SEAT_NOT_AUTHORIZED', '席位令牌与 room 参数不匹配');
  }
  return { principal, roomId: room, from };
}

export class WsAuthError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface AttachedWs {
  readonly wss: WebSocketServer;
  close(): Promise<void>;
}

export function attachWebSocket(server: HttpServer, deps: WsDeps): AttachedWs {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket, head: Buffer) => {
    authorizeUpgrade(deps, req)
      .then((authed) => {
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req, authed);
        });
      })
      .catch((err: unknown) => {
        if (err instanceof WsAuthError) {
          failUpgrade(socket, err.status, err.code, err.message);
        } else {
          failUpgrade(socket, 500, 'INTERNAL', err instanceof Error ? err.message : String(err));
        }
      });
  });

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage, authed: unknown) => {
    const { principal, roomId, from } = authed as AuthedUpgrade;
    const recipient: SeatId | 'spectator' =
      principal.kind === 'spectator' ? 'spectator' : principal.seatId;

    let lastSentOffset = from > 0 ? from - 1 : -1;
    let droppedByBackpressure = 0;

    const sink = (batch: EventBatch): void => {
      if (ws.readyState !== WebSocket.OPEN) return;
      // 背压：宁可断开让客户端带 offset 重连补发，也不在内存里堆无界缓冲
      if (ws.bufferedAmount > WS_BACKPRESSURE_HIGH_WATER) {
        droppedByBackpressure++;
        ws.close(1013, 'backpressure: reconnect with from=' + String(lastSentOffset + 1));
        return;
      }
      for (const e of batch.events) {
        if (e.offset > lastSentOffset) lastSentOffset = e.offset;
      }
      ws.send(JSON.stringify({ type: 'events', ...batch }));
    };

    const unsubscribe = deps.roomManager.subscribe(roomId, recipient, from, sink);

    // 欢迎帧：告知订阅身份与补发起点（客户端据此校对 offset）
    void deps.roomManager
      .nextOffset(roomId)
      .then((nextOffset) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: 'welcome',
              roomId,
              seatId: principal.seatId,
              kind: principal.kind,
              recipient,
              from,
              nextOffset,
            }),
          );
        }
      })
      .catch(() => { /* 房间可能已删除；订阅侧自然收不到事件 */ });

    // 心跳：ping/pong 判活（半开连接是轻量服务器上最常见的僵尸来源）
    let alive = true;
    ws.on('pong', () => {
      alive = true;
    });
    const heartbeat = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }, WS_HEARTBEAT_INTERVAL_MS);

    ws.on('message', (data: Buffer | string) => {
      // 客户端应用层 ping → pong；其余消息忽略（命令一律走 HTTP 信封三件套）
      let msg: unknown;
      try {
        msg = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
      } catch {
        return;
      }
      if (msg !== null && typeof msg === 'object' && (msg as { type?: unknown }).type === 'ping') {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'pong', lastOffset: lastSentOffset }));
        }
      }
    });

    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);

    // 观测点：背压断开计数（测试与运维用）
    Object.defineProperty(ws, 'guozhanDroppedByBackpressure', {
      get: () => droppedByBackpressure,
    });
  });

  return {
    wss,
    close(): Promise<void> {
      return new Promise((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve());
      });
    },
  };
}
