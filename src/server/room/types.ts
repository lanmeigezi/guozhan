/**
 * 房间管理与存储层的**接口契约**。
 *
 * ★本文件是外包/并行开发的对接面：store 实现方与 adapter 实现方都只认这里，
 *   不认任何人的口头描述。改本文件 = 改契约，必须同时改实现与测试。
 *
 * 分层（P4）：
 *   adapters（http/ws/mcp）→ RoomManager → core（纯函数）
 *                        ↘ Store（唯一 IO 边界）
 *   adapters 不得直接碰 core，也不得直接碰 Store。
 */
import type { GameState, WorldConfig, FactionId, SeatId } from '../../core/state.ts';
import type { CommandEnvelope, CommandResult } from '../../protocol/commands.ts';
import type { DomainEvent } from '../../protocol/events.ts';
import type { Snapshot } from '../../protocol/snapshot.ts';
import type { AdviceRecord } from '../../protocol/advice.ts';
import type { MapLayout } from '../../protocol/map-layout.ts';
import type { SanitizedLlmDelta } from '../../core/apply.ts';
import type { LegalAction } from '../../core/legal.ts';
import type { ScenarioMeta, LoadedScenario } from '../config-loader.ts';

// ─────────────────────────────────────────────────────────────
// 席位
// ─────────────────────────────────────────────────────────────

export type SeatKind = 'human' | 'ai' | 'spectator';

export interface SeatInfo {
  readonly seatId: SeatId;
  readonly factionId: FactionId | null; // 观战席位为 null
  readonly kind: SeatKind;
  /**
   * ★军师模式 vs 独立国家模式的**唯一分叉点**。
   *   false = 生成建议但**不自动提交**，等人类在酒馆里点"采纳"
   *   true  = 校验通过后自动提交，LLM 直接驱动这个国家
   * 两种形态共用同一个 AiAdvisor，零额外核心代码（aonw：AI 走与人类相同的命令通道）。
   */
  readonly autoCommit: boolean;
  /** 次级国家走启发式、不调 LLM（P14 分级策略，控成本的关键） */
  readonly llmDriven: boolean;
  readonly aiProfile: string | null;
  readonly tokenUsed: number;
  readonly tokenCap: number;
  readonly connected: boolean;
  /** 席位令牌派生出的连接标识；actor 身份只从这里来，载荷里的一律不信（aonw ADR 0013） */
  readonly controllerId: string | null;
}

export interface RoomInfo {
  readonly roomId: string;
  readonly name: string;
  readonly scenarioId: string;
  readonly phase: GameState['phase'];
  readonly turn: number;
  readonly maxTurns: number;
  readonly rootSeed: string;
  readonly stateDigest: string;
  readonly behaviorFingerprint: number;
  readonly contentHash: string;
  readonly seats: readonly SeatInfo[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly winner: FactionId | null;
  readonly endReason: GameState['endReason'];
}

// ─────────────────────────────────────────────────────────────
// 命令提交与鉴权
// ─────────────────────────────────────────────────────────────

/**
 * 席位令牌。adapter 层从 Authorization 头解析出它，
 * 然后把 actor 显式传给 RoomManager —— **绝不从请求体里取 actor**。
 */
export interface Principal {
  readonly roomId: string;
  readonly seatId: SeatId;
  readonly kind: SeatKind;
  readonly factionId: FactionId | null;
  /** 观战端为 true：只读，任何写命令一律 SEAT_NOT_AUTHORIZED */
  readonly readOnly: boolean;
}

export interface SubmitOptions {
  readonly principal: Principal;
  readonly envelope: CommandEnvelope;
}

// ─────────────────────────────────────────────────────────────
// 事件订阅
// ─────────────────────────────────────────────────────────────

export interface EventBatch {
  readonly roomId: string;
  readonly events: ReadonlyArray<{ offset: number; event: DomainEvent }>;
  /** 本批次之后的 state_digest（客户端下次提交命令要带上） */
  readonly stateDigest: string;
  readonly turn: number;
}

export type Unsubscribe = () => void;

// ─────────────────────────────────────────────────────────────
// RoomManager —— 进程内唯一的 IO 编排者
// ─────────────────────────────────────────────────────────────

export interface MatchMemoryTurn {
  readonly turn: number;
  readonly stateDigest: string;
  readonly resolvedAt: number;
  readonly events: readonly DomainEvent[];
  readonly orders: ReadonlyArray<{ seatId: SeatId; commands: readonly unknown[] }>;
  readonly baseline: TurnReport['baseline'];
  readonly clamps: TurnReport['clamps'];
  readonly rejected: TurnReport['rejected'];
  readonly narratives: Readonly<Record<SeatId, string>>;
}

/**
 * 给酒馆/外部压缩器使用的完整对局记忆。
 *
 * ★权限：玩家席位只拿到按受众裁剪的事件、自己的命令与自己的叙事；
 *   观战/管理令牌拿到全知版本。不要把全知版本交给对局中的玩家。
 */
export interface MatchMemory {
  readonly format: 'guozhan-match-memory';
  readonly version: 1;
  readonly generatedAt: number;
  readonly room: {
    readonly roomId: string;
    readonly name: string;
    readonly scenarioId: string;
    readonly rootSeed: string;
    readonly turn: number;
    readonly phase: GameState['phase'];
    readonly maxTurns: number;
    readonly winner: FactionId | null;
    readonly endReason: GameState['endReason'];
    readonly createdAt: number;
    readonly updatedAt: number;
  };
  readonly viewer: {
    readonly recipient: string;
    readonly seatId: SeatId | null;
    readonly factionId: FactionId | null;
    readonly full: boolean;
  };
  readonly seats: ReadonlyArray<Pick<SeatInfo, 'seatId' | 'factionId' | 'kind' | 'connected' | 'autoCommit' | 'llmDriven'>>;
  readonly turns: readonly MatchMemoryTurn[];
  /** 原始事件流（已按受众裁剪），供外部压缩器自行处理 */
  readonly events: ReadonlyArray<{ readonly offset: number; readonly turn: number; readonly type: string; readonly payload: unknown }>;
  readonly messages: ReadonlyArray<{
    readonly id: string;
    readonly turn: number;
    readonly fromSeat: SeatId;
    readonly toSeat: SeatId | null;
    readonly publicity: 'public' | 'non-public';
    readonly requireResponse: boolean;
    readonly body: string;
    readonly createdAt: number;
  }>;
}

export interface RoomManager {
  // ── 生命周期 ──
  createRoom(input: {
    name: string;
    scenarioId: string;
    rootSeed?: string;
    /** 人类玩家占哪些势力；其余按剧本 seats 配置分给 AI */
    humanFactions?: readonly FactionId[];
    /** 每个 AI 席位的形态；缺省按剧本 majorAi/minorAi 推断 */
    aiOverrides?: Readonly<Record<FactionId, { autoCommit?: boolean; llmDriven?: boolean }>>;
  }): Promise<RoomInfo>;

  listRooms(): Promise<RoomInfo[]>;
  getRoom(roomId: string): Promise<RoomInfo | null>;
  deleteRoom(roomId: string): Promise<void>;

  // ── 席位 ──
  /** 人类加入：认领一个空席位，返回其令牌 */
  joinRoom(roomId: string, input: { seatId?: SeatId; asSpectator?: boolean }): Promise<{ seat: SeatInfo; token: string }>;
  /** 断线重连：用已有令牌换回席位 */
  resumeSeat(token: string): Promise<{ room: RoomInfo; seat: SeatInfo } | null>;
  assignSeat(roomId: string, seatId: SeatId, patch: Partial<Pick<SeatInfo, 'autoCommit' | 'llmDriven' | 'kind'>>): Promise<SeatInfo>;
  /** 撤销某席位的所有连接令牌；asAi=true 时把该席位退回 AI 接管（主持人踢人用） */
  revokeSeat(roomId: string, seatId: SeatId, opts?: { asAi?: boolean }): Promise<SeatInfo | null>;
  /** 账号已持有该席位时重新签发席位令牌；旧令牌立即失效 */
  reclaimSeat(roomId: string, seatId: SeatId): Promise<{ seat: SeatInfo; token: string } | null>;

  // ── 读取 ──
  /** ★按接收者投影后的快照（战争迷雾）。观战端传 'spectator' 拿全知视图 */
  getSnapshot(roomId: string, recipient: SeatId | 'spectator'): Promise<Snapshot>;
  /**
   * 静态地图布局（六角坐标/画布/阵营色/首都）。纯展示层：
   * 不含归属与兵力，不进 LLM 提示词，也不参与 CAS/结算。
   */
  getMapLayout(roomId: string): Promise<MapLayout>;
  getTurnReport(roomId: string, turn: number): Promise<TurnReport | null>;
  /**
   * 完整对局记忆（逐回合战报 + 原始事件流 + 外交文书）。
   * recipient 为 'spectator' 时返回全知版本；玩家席位只返回该席位可见内容。
   */
  getMatchMemory(roomId: string, recipient: SeatId | 'spectator'): Promise<MatchMemory>;
  getState(roomId: string): Promise<{ state: GameState; world: WorldConfig; scenario: ScenarioMeta } | null>;
  getPendingAdvice(roomId: string, seatId: SeatId): Promise<readonly AdviceRecord[]>;
  /**
   * 本席位的合法动作空间，**含可直接提交的命令体**。
   * 人类 UI 用它构建命令；LLM 仍走快照里的 id 清单（不带命令体，P10）。
   * ★不让 UI 自己从 action id 里解析命令 —— 那会造出第二份规则真相。
   */
  getLegalActions(
    roomId: string,
    seatId: SeatId,
  ): Promise<{ turn: number; stateId: string; actions: readonly LegalAction[] }>;

  // ── 写入（全部经 core 校验；拒绝不改状态）──
  submitCommands(opts: SubmitOptions): Promise<CommandResult>;
  /** 军师模式：人类采纳 AI 建议 → 转成 DomainCommand 走同一条提交通道 */
  adoptAdvice(opts: { principal: Principal; adviceId: string; commandIndices?: readonly number[] }): Promise<CommandResult>;
  /** 席位声明本回合提交完毕 */
  lockOrders(principal: Principal): Promise<{ locked: boolean; waiting: readonly SeatId[] }>;
  /** 超时未提交 ⇒ 系统命令锁定（SystemCommand，不暴露给玩家端点） */
  timeoutLock(roomId: string, seatId: SeatId): Promise<void>;

  // ── 回合推进 ──
  /** 全部席位锁定后由房间层调用；纯确定性，毫秒级，**绝不等 LLM** */
  resolveTurn(roomId: string, opts?: { llmDelta?: Readonly<Record<FactionId, SanitizedLlmDelta>> }): Promise<TurnReport>;
  /** 异步生成叙事并流式推送（P11：状态先定、叙事后到）。不阻塞下一回合 */
  generateNarratives(roomId: string, turn: number): Promise<void>;
  /** 触发某 AI 席位的战略顾问（异步，不阻塞调用方） */
  requestAdvice(roomId: string, seatId: SeatId): Promise<{ adviceId: string } | { skipped: string }>;

  // ── 事件流 ──
  /**
   * 订阅事件。`fromOffset` 用于断线重连补发（event_log 的 offset 单调递增）。
   * ★投影在投递时做：同一个事件按接收者裁剪后才下发，客户端永不拿到规范隐藏状态。
   */
  subscribe(roomId: string, recipient: SeatId | 'spectator', fromOffset: number, sink: (batch: EventBatch) => void): Unsubscribe;
  nextOffset(roomId: string): Promise<number>;

  shutdown(): Promise<void>;
}

export interface TurnReport {
  readonly roomId: string;
  readonly turn: number;
  readonly stateDigest: string;
  readonly orders: ReadonlyArray<{ seatId: SeatId; commands: readonly unknown[] }>;
  readonly baseline: ReadonlyArray<{ scope: string; field: string; oldValue: number; newValue: number; delta: number; reason: string; source: string }>;
  readonly llmDelta: unknown | null;
  readonly violations: ReadonlyArray<{ path: string; rule: string; severity: string; action: string; detail: string }>;
  readonly clamps: ReadonlyArray<{ scope: string; field: string; beforeClamp: number; afterClamp: number; limit: string }>;
  readonly events: readonly DomainEvent[];
  readonly narratives: Readonly<Record<SeatId, string>>;
  readonly rejected: ReadonlyArray<{ seatId: string; index: number; code: string; message: string }>;
  readonly llmApplied: boolean;
  readonly resolvedAt: number;
}

// ─────────────────────────────────────────────────────────────
// Store —— 唯一 IO 边界（每房间一个 SQLite 文件，WAL）
// ─────────────────────────────────────────────────────────────

export interface RoomStore {
  /** 打开或创建 data/rooms/<roomId>.db；执行 schema 迁移 */
  open(roomId: string): void;
  close(roomId: string): void;
  /** 启动时校验 behavior_fingerprint 与 content_hash，不匹配 ⇒ fail-closed 抛错（P4） */
  verifyIdentity(roomId: string, expected: { behaviorFingerprint: number; contentHash: string }): void;

  loadRoom(roomId: string): PersistedRoom | null;
  saveRoom(roomId: string, row: PersistedRoom): void;

  loadSeats(roomId: string): PersistedSeat[];
  saveSeat(roomId: string, seat: PersistedSeat): void;

  loadState(roomId: string): { state: GameState; digest: string } | null;
  /** ★单事务写入：state + turn_record + turn_delta + event_log + command_receipt 一起提交 */
  commitTurn(roomId: string, tx: TurnCommit): void;

  loadTurn(roomId: string, turn: number): TurnReport | null;
  appendEvents(roomId: string, events: ReadonlyArray<{ offset: number; turn: number; type: string; payload: unknown }>): void;
  readEvents(roomId: string, fromOffset: number, limit?: number): Array<{ offset: number; turn: number; type: string; payload: unknown }>;

  saveAdvice(roomId: string, advice: AdviceRecord): void;
  loadAdvice(roomId: string, seatId: SeatId, status?: string): AdviceRecord[];
  updateAdviceStatus(roomId: string, adviceId: string, status: string): void;

  saveReceipt(roomId: string, receipt: { requestId: string; stateDigest: string; result: CommandResult }): void;
  loadReceipt(roomId: string, requestId: string): { stateDigest: string; result: CommandResult } | null;

  logLlmCall(roomId: string, entry: LlmCallEntry): void;
  sumTokens(roomId: string, seatId: SeatId): number;

  /** 整房间导出（原子写：临时文件 → fsync → 旧档轮转为 .bak → rename） */
  exportRoom(roomId: string, destPath: string): void;
}

export interface PersistedRoom {
  roomId: string;
  name: string;
  scenarioId: string;
  phase: GameState['phase'];
  turn: number;
  maxTurns: number;
  rootSeed: string;
  stateJson: string;
  stateDigest: string;
  behaviorFingerprint: number;
  contentHash: string;
  moduleOrderJson: string;
  createdAt: number;
  updatedAt: number;
}

export interface PersistedSeat {
  seatId: SeatId;
  kind: SeatKind;
  factionId: FactionId | null;
  controllerId: string | null;
  autoCommit: boolean;
  llmDriven: boolean;
  aiProfile: string | null;
  tokenUsed: number;
  tokenCap: number;
  joinedAt: number;
}

export interface TurnCommit {
  turn: number;
  state: GameState;
  stateDigest: string;
  phase: GameState['phase'];
  orders: ReadonlyArray<{ seatId: SeatId; commands: readonly unknown[] }>;
  baseline: TurnReport['baseline'];
  llmDelta: unknown | null;
  violations: TurnReport['violations'];
  clamps: TurnReport['clamps'];
  events: readonly DomainEvent[];
  evidence: readonly unknown[];
  narratives: Readonly<Record<SeatId, string>> | null;
  rejected: TurnReport['rejected'];
  llmApplied: boolean;
  resolvedAt: number;
}

export interface LlmCallEntry {
  turn: number | null;
  seatId: SeatId | null;
  purpose: 'advisor' | 'narrative' | 'intent_parse';
  provider: string;
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  latencyMs: number | null;
  /** ★'stream_broken' 也要记账 —— Histrategy 的教训：客户端断流时调用**已经被计费**，不记就是黑洞 */
  status: 'ok' | 'timeout' | 'parse_fail' | 'budget_exceeded' | 'aborted' | 'stream_broken' | 'http_error';
  error: string | null;
  requestedAt: number;
}

/** 房间注册表（data/index.db），用于 listRooms 而不必打开每个房间库 */
export interface RoomIndex {
  upsert(entry: { roomId: string; name: string; scenarioId: string; createdAt: number; updatedAt: number; phase: string; turn: number }): void;
  list(): Array<{ roomId: string; name: string; scenarioId: string; createdAt: number; updatedAt: number; phase: string; turn: number }>;
  remove(roomId: string): void;
}

export type { LoadedScenario };
/** 便捷再导出：适配器层只从本文件取类型，不直接依赖 core */
export type { SeatId };
