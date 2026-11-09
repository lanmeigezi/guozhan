/**
 * RoomStore 的**实现侧扩展**接口。
 *
 * ★为什么需要它：`src/server/room/types.ts` 的 `RoomStore` 是对外契约（不许改），
 *   但要跑通"同时提交-统一裁决"与"战争迷雾事件投影"，实现方还需要几个契约里
 *   没有的内部能力。把它们集中声明在这里，memory-store 与 sqlite-store 都实现，
 *   RoomManager 只依赖这个扩展接口 —— 于是两套实现在房间层看来完全等价，
 *   测试可以互换（room.test.ts 用内存版跑，store.test.ts 两套都跑）。
 *
 * 原则：**只增不改**。契约里的方法签名一个都没动。
 */
import type { RoomStore } from '../room/types.ts';
import type { GameState, SeatId } from '../../core/state.ts';
import type { AdviceRecord } from '../../protocol/advice.ts';
import type { CommandResult } from '../../protocol/commands.ts';

/** 事件的投递受众：'all' = 广播；数组 = 只给这些势力（观战端永远全收） */
export type Audience = 'all' | readonly string[];

export interface EventRow {
  readonly offset: number;
  readonly turn: number;
  readonly type: string;
  readonly payload: unknown;
  readonly audience: Audience;
}

export interface PendingOrderRow {
  readonly turn: number;
  readonly seatId: SeatId;
  readonly index: number;
  readonly requestId: string;
  readonly factionId: string;
  readonly kind: string;
  readonly command: unknown;
  readonly createdAt: number;
}

export interface SubmissionRow {
  readonly seatId: SeatId;
  readonly lockedAt: number;
  readonly timedOut: boolean;
}

export interface ReceiptRow {
  readonly stateDigest: string;
  readonly paramsHash: string;
  readonly seatId: SeatId | null;
  readonly turn: number;
  readonly result: CommandResult;
}

export interface MessageRow {
  readonly id: string;
  readonly turn: number;
  readonly fromSeat: SeatId;
  readonly toSeat: SeatId | null;
  readonly publicity: 'public' | 'non-public';
  readonly requireResponse: boolean;
  readonly body: string;
  readonly createdAt: number;
}

/** 整房间导出文档（atomic-write 的载荷；恢复时也读它） */
export interface RoomExport {
  readonly format: 'guozhan-room-export';
  readonly version: 1;
  readonly exportedAt: number;
  readonly room: unknown;
  readonly seats: readonly unknown[];
  readonly turnRecords: readonly unknown[];
  readonly turnDeltas: readonly unknown[];
  readonly events: readonly unknown[];
  readonly advice: readonly unknown[];
  readonly receipts: readonly unknown[];
  readonly messages: readonly unknown[];
  readonly llmCalls: readonly unknown[];
}

export interface RoomStoreExt extends RoomStore {
  // ── 事件（带受众，供战争迷雾投影）──
  readEventRows(roomId: string, fromOffset: number, limit?: number): EventRow[];

  // ── 本回合待裁决命令（同时提交模型）──
  savePendingOrder(roomId: string, order: PendingOrderRow): void;
  loadPendingOrders(roomId: string, turn: number): PendingOrderRow[];
  clearPendingOrders(roomId: string, turn: number): void;

  // ── 席位锁定信号 ──
  saveSubmission(roomId: string, turn: number, seatId: SeatId, lockedAt: number, timedOut: boolean): void;
  loadSubmissions(roomId: string, turn: number): SubmissionRow[];
  clearSubmissions(roomId: string, turn: number): void;

  // ── 回执（含参数指纹，P8 同参/异参判定）──
  saveReceiptRow(roomId: string, requestId: string, row: ReceiptRow, createdAt: number): void;
  loadReceiptRow(roomId: string, requestId: string): ReceiptRow | null;

  // ── 叙事异步补写（P11：状态先定、叙事后到）──
  saveNarratives(roomId: string, turn: number, narratives: Readonly<Record<SeatId, string>>): void;

  // ── 建议按回合检索（战报里的 violations 来自这里）──
  loadAdviceByTurn(roomId: string, turn: number): AdviceRecord[];

  // ── 外交文书 ──
  saveMessage(roomId: string, message: MessageRow): void;
  loadMessages(roomId: string, turn?: number): MessageRow[];

  // ── 状态直写（回合边界推进：turn+1 / phase / submitted 清空）──
  saveState(roomId: string, state: GameState, digest: string, phase: GameState['phase'], turn: number, updatedAt: number): void;

  // ── 房间数据删除（deleteRoom）──
  destroyRoom(roomId: string): void;

  // ── 导出文档（atomic-write 用；不写盘，只组装）──
  buildExport(roomId: string, exportedAt: number): RoomExport;

  /** 已打开的房间库 id（shutdown 用） */
  openRoomIds(): readonly string[];
}
