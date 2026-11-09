/**
 * 房间管理器 —— 进程内唯一的 IO 编排者（adapters → **这里** → core / store）。
 *
 * ★它不实现任何规则：合法性、数值、掷骰全在 src/core。这里只做编排：
 *   权限 → CAS/幂等 → 入队 → 锁定 → 调 core 结算 → 落库 → 派发事件 → 异步唤起 AI。
 *
 * ★三条纪律：
 *   1. **结算绝不等 LLM**。锁齐就立刻跑 core（毫秒级）；AI 的 LLM 建议是异步的，
 *      赶不上就按"已提交的命令"结算 —— 这正是 OpenRA-RL「观测可丢、动作不可丢」的镜像。
 *   2. **AI 与人类走同一条命令通道**（aonw）：AI 的命令同样过 CommandEnvelopeSchema、
 *      同样写 pending_orders、同样受 CAS 约束，没有任何后门。
 *   3. **拒绝不改状态**（P4）：任何一步被拒，磁盘上的 state 与"没发生过"逐位相同。
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { FactionId, FactionState, GameState, RegionState, SeatId, UnitState, WorldConfig } from '../../core/state.ts';
import { totalTroops } from '../../core/state.ts';
import { resolveTurn as resolveCore, type SanitizedLlmDelta } from '../../core/apply.ts';
import type { AcceptedOrder } from '../../core/module.ts';
import { buildModules } from '../../core/modules/index.ts';
import { enumerateLegalActions, type LegalAction } from '../../core/legal.ts';

import { CommandEnvelopeSchema } from '../../protocol/commands.ts';
import type { CommandEnvelope, CommandResult, CommandStepResult } from '../../protocol/commands.ts';
import { RejectionCode } from '../../protocol/rejections.ts';
import type { DomainEvent } from '../../protocol/events.ts';
import type { AdviceRecord } from '../../protocol/advice.ts';
import type { MapLayout } from '../../protocol/map-layout.ts';
import type { Alert, SelfReview, Snapshot } from '../../protocol/snapshot.ts';

import { loadScenario, sha256, stableStringify, type LoadedScenario } from '../config-loader.ts';
import {
  createSqliteStore,
  digestState,
  type SqliteRoomIndex,
  type SqliteRoomStore,
} from '../store/sqlite-store.ts';
import { audienceIncludes } from '../store/event-audience.ts';
import type { EventRow } from '../store/room-store-ext.ts';

import { AiAdvisor } from '../../ai/advisor.ts';
import { clientFromEnv, type LlmCallRecord, type LlmClient } from '../../ai/llm-client.ts';
import {
  EMPTY_FACTS,
  evaluateAlerts,
  evaluateMilestones,
  type AlertConfigEntry,
  type AlertFacts,
  type MilestoneStatus,
} from '../../ai/alerts.ts';
import { renderNarrativePrompt } from '../../ai/prompt-render.ts';
import { deriveSelfReview } from '../../ai/selfplay.ts';
import { archetypeForFaction, assignAiArchetypes } from '../../ai/archetypes.ts';
import type { AiArchetype } from '../../protocol/snapshot.ts';

import { buildSnapshot } from './snapshot.ts';
import type {
  EventBatch,
  MatchMemory,
  MatchMemoryTurn,
  Principal,
  RoomInfo,
  RoomManager,
  SeatInfo,
  SubmitOptions,
  TurnReport,
  Unsubscribe,
} from './types.ts';

export interface RoomManagerOptions {
  readonly dataDir: string;
  readonly configRoot: string;
  readonly scenarioIds: readonly string[];
  /** 注入 LLM 客户端（测试可传假实现）；缺省读环境变量 */
  readonly llm?: LlmClient;
  /** 关掉「回合结束自动唤起 AI」，测试用 */
  readonly autoAdvice?: boolean;
}

interface Subscriber {
  readonly recipient: SeatId | 'spectator';
  readonly sink: (batch: EventBatch) => void;
}

interface Runtime {
  readonly roomId: string;
  readonly rootSeed: string;
  readonly scenario: LoadedScenario;
  state: GameState;
  digest: string;
  readonly seats: Map<SeatId, SeatInfo>;
  /** AI 席位原型：只给 kind=ai 的势力；人类席位不参与 */
  readonly aiArchetypes: Map<FactionId, AiArchetype>;
  readonly locked: Set<SeatId>;
  readonly subscribers: Set<Subscriber>;
  /** 本回合已发起过建议的 `${seatId}:${turn}`，防重复唤起 */
  readonly adviceStarted: Set<string>;
  /** 各势力本回合通过闸门的 LLM delta，结算时并入 core */
  readonly llmDeltas: Map<FactionId, SanitizedLlmDelta[]>;
  /** 本回合告警事实缓存：factsFor 会扫事件表，不能每个 AI 席位都重扫 */
  readonly factsCache: Map<FactionId, { turn: number; facts: AlertFacts }>;
  /** 本回合自我复盘缓存：策略迭代每回合只算一次 */
  readonly reviewCache: Map<FactionId, { turn: number; review: SelfReview | undefined }>;
  /**
   * ★开局闸：指定了 humanFactions 的房间在**第一个真人认领席位之前**不许推进。
   *   否则 AI 席位会在玩家入场前自己把整局打完（冒烟测试实测：人类连上时对局已结束）。
   *   纯 AI 房间（没指定 humanFactions）创建即开局。
   */
  started: boolean;
  resolving: boolean;
  readonly chain: { tail: Promise<unknown> };
}

function nowMs(): number {
  return Date.now();
}

function seatOfFaction(fid: FactionId): SeatId {
  return `seat_${fid}`;
}

function failed(
  code: string,
  message: string,
  turn: number,
  stateId: string,
  detail?: Record<string, string | number | boolean>,
): CommandResult {
  const step: CommandStepResult = { index: 0, ok: false, code, message, ...(detail ? { detail } : {}) };
  return { status: 'failed', completedSteps: 0, steps: [step], replayed: false, stateId, turn };
}

function mergeLlmDeltas(map: ReadonlyMap<FactionId, SanitizedLlmDelta[]>): SanitizedLlmDelta | null {
  const moraleAdjustments: Array<{ factionId: FactionId; delta: number; reason: string }> = [];
  const unrestEvents: Array<{ regionId: string; delta: number; severity: 'minor' | 'major' | 'revolt'; reason: string }> = [];
  const casualtyHints: Array<{ regionId: string; attackerHint: number; defenderHint: number; reason: string }> = [];
  for (const fid of [...map.keys()].sort()) {
    for (const d of map.get(fid) ?? []) {
      for (const m of d.moraleAdjustments ?? []) moraleAdjustments.push({ ...m, factionId: m.factionId ?? fid });
      for (const u of d.unrestEvents ?? []) unrestEvents.push(u as (typeof unrestEvents)[number]);
      for (const c of d.casualtyHints ?? []) casualtyHints.push(c as (typeof casualtyHints)[number]);
    }
  }
  if (moraleAdjustments.length === 0 && unrestEvents.length === 0 && casualtyHints.length === 0) return null;
  return { moraleAdjustments, unrestEvents, casualtyHints };
}

export class RoomManagerImpl implements RoomManager {
  private readonly opts: RoomManagerOptions;
  private readonly store: SqliteRoomStore;
  private readonly index: SqliteRoomIndex;
  private readonly llm: LlmClient;
  private readonly advisor: AiAdvisor;
  private readonly rooms = new Map<string, Runtime>();
  private readonly tokens = new Map<string, { roomId: string; seatId: SeatId }>();
  private readonly alertConfigs: readonly AlertConfigEntry[];
  private readonly autoAdvice: boolean;
  /** 人格来自静态 factions.json，读一次即可；避免每回合每席位重复读盘 */
  private readonly personalityCache = new Map<string, { aggression: number; diplomacy: string; description: string }>();
  private shuttingDown = false;

  constructor(opts: RoomManagerOptions) {
    this.opts = opts;
    const { store, index } = createSqliteStore({ dataDir: opts.dataDir });
    this.store = store;
    this.index = index;
    this.llm = opts.llm ?? clientFromEnv();
    this.autoAdvice = opts.autoAdvice ?? process.env['GUOZHAN_AUTO_ADVICE'] !== '0';
    this.alertConfigs = this.readAlertConfigs();

    this.advisor = new AiAdvisor({
      llm: this.llm,
      onLlmCall: (roomId, seatId, rec) => this.onLlmCall(roomId, seatId, rec),
      onSaveAdvice: (roomId, record) => this.store.saveAdvice(roomId, record),
      onSubmitCommands: async (roomId, seatId, commands) => this.submitAiCommands(roomId, seatId, commands),
      onAdviceReady: (roomId, seatId, record, autoCommit) => this.onAdviceReady(roomId, seatId, record, autoCommit),
      onDelta: (roomId, seatId, delta) => this.onAdviceDelta(roomId, seatId, delta),
      newAdviceId: () => `adv_${nowMs().toString(36)}_${randomBytes(4).toString('hex')}`,
      now: nowMs,
    });
  }

  // ─────────────────────────────────────────────────────────────
  // 生命周期
  // ─────────────────────────────────────────────────────────────

  // 0 = 不限回合；只覆盖 meta/world.maxTurns，不改 contentHash/规则身份。
  private scenarioWithMaxTurns<T extends { meta: { maxTurns: number }; world: { maxTurns: number } }>(scenario: T, maxTurns: number): T {
    if (scenario.meta.maxTurns === maxTurns && scenario.world.maxTurns === maxTurns) return scenario;
    return { ...scenario, meta: { ...scenario.meta, maxTurns }, world: { ...scenario.world, maxTurns } };
  }

  async createRoom(input: {
    name: string;
    scenarioId: string;
    rootSeed?: string;
    humanFactions?: readonly FactionId[];
    aiOverrides?: Readonly<Record<FactionId, { autoCommit?: boolean; llmDriven?: boolean }>>;
    unlimitedTurns?: boolean;
  }): Promise<RoomInfo> {
    if (!this.opts.scenarioIds.includes(input.scenarioId)) {
      throw new Error(`未知剧本 ${input.scenarioId}（可用：${this.opts.scenarioIds.join(', ')}）`);
    }
    const roomId = `room-${nowMs().toString(36)}-${randomBytes(3).toString('hex')}`;
    const rootSeed = input.rootSeed ?? sha256(`${input.scenarioId}:${roomId}`).slice(0, 32);
    const baseScenario = loadScenario(input.scenarioId, rootSeed, this.opts.configRoot);
    const scenario = input.unlimitedTurns === true ? this.scenarioWithMaxTurns(baseScenario, 0) : baseScenario;
    const now = nowMs();

    const state: GameState = { ...scenario.initialState, phase: 'submitting' };
    const digest = digestState(state);

    this.store.open(roomId);
    this.store.saveRoom(roomId, {
      roomId,
      name: input.name,
      scenarioId: input.scenarioId,
      phase: state.phase,
      turn: state.turn,
      maxTurns: scenario.meta.maxTurns,
      rootSeed,
      stateJson: JSON.stringify(state),
      stateDigest: digest,
      behaviorFingerprint: scenario.meta.behaviorFingerprint,
      contentHash: scenario.contentHash,
      moduleOrderJson: JSON.stringify(scenario.meta.moduleOrder),
      createdAt: now,
      updatedAt: now,
    });

    const human = new Set(input.humanFactions ?? []);
    const seats = new Map<SeatId, SeatInfo>();
    for (const fid of Object.keys(state.factions).sort()) {
      const isHuman = human.has(fid);
      const override = input.aiOverrides?.[fid] ?? {};
      const seat: SeatInfo = {
        seatId: seatOfFaction(fid),
        factionId: fid,
        kind: isHuman ? 'human' : 'ai',
        /**
         * ★两个开关正交，别合并：
         *   autoCommit = 谁拍板（true=AI 独立国家；false=人类确认）
         *   llmDriven  = 这个席位能不能用 LLM（人类席位＝军师模式，按需请求，不自动调用）
         * 把人类席位设成 llmDriven=false 会让"军师"根本没模型可用 —— 人机配合直接断掉。
         */
        autoCommit: isHuman ? false : (override.autoCommit ?? true),
        llmDriven: override.llmDriven ?? (isHuman || scenario.meta.seats.majorAi.includes(fid)),
        aiProfile: isHuman ? null : (state.factions[fid]?.name ?? fid),
        tokenUsed: 0,
        tokenCap: scenario.meta.budget.perSeatTokenCap,
        connected: false,
        controllerId: null,
      };
      seats.set(seat.seatId, seat);
      this.persistSeat(roomId, seat, now);
    }

    const aiFactionIds = [...seats.values()]
      .filter((s) => s.kind === 'ai' && s.factionId !== null)
      .map((s) => s.factionId as FactionId)
      .sort();
    const aiArchetypes = new Map<FactionId, AiArchetype>(
      Object.entries(assignAiArchetypes(rootSeed, aiFactionIds)) as Array<[FactionId, AiArchetype]>,
    );

    const rt: Runtime = {
      roomId,
      rootSeed,
      scenario,
      state,
      digest,
      seats,
      aiArchetypes,
      locked: new Set(),
      subscribers: new Set(),
      adviceStarted: new Set(),
      llmDeltas: new Map(),
      factsCache: new Map(),
      reviewCache: new Map(),
      started: human.size === 0,
      resolving: false,
      chain: { tail: Promise.resolve() },
    };
    this.rooms.set(roomId, rt);
    this.index.upsert({
      roomId,
      name: input.name,
      scenarioId: input.scenarioId,
      createdAt: now,
      updatedAt: now,
      phase: state.phase,
      turn: state.turn,
    });

    const info = this.infoOf(rt);
    if (this.autoAdvice) setImmediate(() => void this.kickoff(roomId));
    return info;
  }

  async listRooms(): Promise<RoomInfo[]> {
    const out: RoomInfo[] = [];
    for (const entry of this.index.list()) {
      try {
        out.push(await this.getRoom(entry.roomId) as RoomInfo);
      } catch {
        // 库损坏的房间不该拖垮列表；详细错误留给 getRoom 暴露
      }
    }
    return out;
  }

  async getRoom(roomId: string): Promise<RoomInfo | null> {
    const row = this.store.loadRoom(roomId);
    if (!row) return null;
    const rt = this.rooms.get(roomId);
    if (rt) return this.infoOf(rt);
    // 未装入内存：只为一个已结束的房间额外读 state（winner/endReason 用）
    let winner: FactionId | null = null;
    let endReason: GameState['endReason'] = null;
    if (row.phase === 'ended') {
      const loaded = this.store.loadState(roomId);
      winner = loaded?.state.winner ?? null;
      endReason = loaded?.state.endReason ?? null;
    }
    return {
      roomId: row.roomId,
      name: row.name,
      scenarioId: row.scenarioId,
      phase: row.phase,
      turn: row.turn,
      maxTurns: row.maxTurns,
      rootSeed: row.rootSeed,
      stateDigest: row.stateDigest,
      behaviorFingerprint: row.behaviorFingerprint,
      contentHash: row.contentHash,
      seats: this.store.loadSeats(roomId).map((s) => ({
        seatId: s.seatId,
        factionId: s.factionId,
        kind: s.kind,
        autoCommit: s.autoCommit,
        llmDriven: s.llmDriven,
        aiProfile: s.aiProfile,
        tokenUsed: s.tokenUsed,
        tokenCap: s.tokenCap,
        connected: false,
        controllerId: s.controllerId,
      })),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      winner,
      endReason,
    };
  }

  async deleteRoom(roomId: string): Promise<void> {
    await this.withLock(roomId, async () => {
      const rt = this.rooms.get(roomId);
      if (rt) {
        rt.subscribers.clear();
        this.rooms.delete(roomId);
      }
      for (const [token, ref] of this.tokens) if (ref.roomId === roomId) this.tokens.delete(token);
      this.store.destroyRoom(roomId);
      this.index.remove(roomId);
    });
  }

  // ─────────────────────────────────────────────────────────────
  // 席位
  // ─────────────────────────────────────────────────────────────

  async joinRoom(
    roomId: string,
    input: { seatId?: SeatId; asSpectator?: boolean },
  ): Promise<{ seat: SeatInfo; token: string }> {
    const rt = this.ensure(roomId);
    const token = `gz_${randomBytes(24).toString('base64url')}`;
    const controllerId = sha256(token).slice(0, 24);
    const now = nowMs();

    if (input.asSpectator) {
      let n = 1;
      while (rt.seats.has(`seat_guest_${n}`)) n++;
      const seat: SeatInfo = {
        seatId: `seat_guest_${n}`,
        factionId: null,
        kind: 'spectator',
        autoCommit: false,
        llmDriven: false,
        aiProfile: null,
        tokenUsed: 0,
        tokenCap: 0,
        connected: true,
        controllerId,
      };
      rt.seats.set(seat.seatId, seat);
      this.persistSeat(roomId, seat, now);
      this.tokens.set(token, { roomId, seatId: seat.seatId });
      return { seat, token };
    }

    const claimable = (s: SeatInfo): boolean =>
      s.kind !== 'spectator' &&
      s.factionId !== null &&
      (s.controllerId === null || !this.hasLiveTokenFor(roomId, s.seatId));

    let target: SeatInfo | undefined;
    if (input.seatId !== undefined) {
      const candidate = rt.seats.get(input.seatId);
      if (!candidate) throw new Error(`席位不存在：${input.seatId}`);
      if (!claimable(candidate)) throw new Error(`席位 ${input.seatId} 已被占用`);
      target = candidate;
    } else {
      target =
        [...rt.seats.values()].find((s) => s.kind === 'human' && claimable(s)) ??
        [...rt.seats.values()].find(claimable);
    }
    if (!target) throw new Error('没有可认领的席位');

    const seat: SeatInfo = {
      ...target,
      kind: 'human',
      // 人类必须自己拍板；但**保留** llmDriven —— 否则军师模式没有模型可用
      autoCommit: false,
      connected: true,
      controllerId,
    };
    rt.seats.set(seat.seatId, seat);
    if (seat.factionId !== null) rt.aiArchetypes.delete(seat.factionId);
    this.persistSeat(roomId, seat, now);
    this.tokens.set(token, { roomId, seatId: seat.seatId });
    this.touch(rt);
    // ★第一个真人入场 = 开局；此前 AI 不得自行推进回合
    if (!rt.started) {
      rt.started = true;
      if (this.autoAdvice) setImmediate(() => void this.kickoff(roomId));
    }
    return { seat, token };
  }

  async resumeSeat(token: string): Promise<{ room: RoomInfo; seat: SeatInfo } | null> {
    const ref = this.tokens.get(token);
    if (!ref) return null;
    const rt = this.ensure(ref.roomId);
    const seat = rt.seats.get(ref.seatId);
    if (!seat || seat.controllerId !== sha256(token).slice(0, 24)) return null;
    return { room: this.infoOf(rt), seat };
  }

  async assignSeat(
    roomId: string,
    seatId: SeatId,
    patch: Partial<Pick<SeatInfo, 'autoCommit' | 'llmDriven' | 'kind'>>,
  ): Promise<SeatInfo> {
    const rt = this.ensure(roomId);
    const seat = rt.seats.get(seatId);
    if (!seat) throw new Error(`席位不存在：${seatId}`);
    if (rt.state.phase === 'ended') throw new Error('对局已结束，不能改席位');
    const next: SeatInfo = {
      ...seat,
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
      ...(patch.autoCommit !== undefined ? { autoCommit: patch.autoCommit } : {}),
      ...(patch.llmDriven !== undefined ? { llmDriven: patch.llmDriven } : {}),
    };
    rt.seats.set(seatId, next);
    if (next.factionId !== null) {
      if (next.kind === 'ai' && !rt.aiArchetypes.has(next.factionId)) {
        rt.aiArchetypes.set(next.factionId, archetypeForFaction(rt.rootSeed, next.factionId));
      }
      if (next.kind !== 'ai') rt.aiArchetypes.delete(next.factionId);
    }
    this.persistSeat(roomId, next, nowMs());
    return next;
  }

  async revokeSeat(roomId: string, seatId: SeatId, opts: { asAi?: boolean } = {}): Promise<SeatInfo | null> {
    const rt = this.ensure(roomId);
    const seat = rt.seats.get(seatId);
    if (!seat) return null;
    for (const [token, ref] of this.tokens) {
      if (ref.roomId === roomId && ref.seatId === seatId) this.tokens.delete(token);
    }
    let next: SeatInfo = { ...seat, controllerId: null, connected: false };
    if (opts.asAi === true && seat.kind !== 'spectator') {
      next = { ...next, kind: 'ai', autoCommit: false, llmDriven: false, aiProfile: null };
      if (next.factionId !== null) {
        rt.aiArchetypes.set(next.factionId, archetypeForFaction(rt.rootSeed, next.factionId));
      }
    }
    rt.seats.set(seatId, next);
    if (next.factionId !== null && next.kind !== 'ai') rt.aiArchetypes.delete(next.factionId);
    this.persistSeat(roomId, next, nowMs());
    return next;
  }

  async reclaimSeat(roomId: string, seatId: SeatId): Promise<{ seat: SeatInfo; token: string } | null> {
    const rt = this.ensure(roomId);
    const seat = rt.seats.get(seatId);
    // AI 席位不能凭账号直接变回真人；请走 joinRoom 认领空席位。
    if (!seat || seat.kind === 'ai') return null;
    for (const [token, ref] of this.tokens) {
      if (ref.roomId === roomId && ref.seatId === seatId) this.tokens.delete(token);
    }
    const token = `gz_${randomBytes(24).toString('base64url')}`;
    const next: SeatInfo = {
      ...seat,
      kind: seat.kind === 'spectator' ? 'spectator' : 'human',
      autoCommit: false,
      connected: true,
      controllerId: sha256(token).slice(0, 24),
    };
    rt.seats.set(seatId, next);
    this.persistSeat(roomId, next, nowMs());
    this.tokens.set(token, { roomId, seatId });
    this.touch(rt);
    return { seat: next, token };
  }

  // ─────────────────────────────────────────────────────────────
  // 读取
  // ─────────────────────────────────────────────────────────────

  async getSnapshot(roomId: string, recipient: SeatId | 'spectator'): Promise<Snapshot> {
    const rt = this.ensure(roomId);
    if (recipient !== 'spectator') {
      const seat = rt.seats.get(recipient);
      if (!seat) throw new Error(`席位不存在：${recipient}`);
    }
    const seat = recipient === 'spectator' ? null : rt.seats.get(recipient)!;
    const viewer = seat?.factionId ?? null;
    const alerts = viewer ? this.alertsFor(rt, viewer, seat!.seatId) : [];
    const selfReview = viewer ? this.selfReviewFor(rt, viewer) : undefined;
    return buildSnapshot({
      state: rt.state,
      world: rt.scenario.world,
      recipient,
      viewer,
      digest: rt.digest,
      alerts,
      tokenUsed: seat?.tokenUsed ?? 0,
      tokenCap: seat?.tokenCap ?? 0,
      sinceLastTurn: this.sinceLastTurn(rt, viewer),
      ...(selfReview ? { selfReview } : {}),
      ...(Object.keys(this.aiArchetypeMap(rt)).length > 0 ? { aiArchetypes: this.aiArchetypeMap(rt) } : {}),
    });
  }

  /** 只暴露当前由 AI 控制的席位原型；人类席位即使原来分到过也不显示。 */
  private aiArchetypeMap(rt: Runtime): Readonly<Record<FactionId, AiArchetype>> {
    const out: Record<FactionId, AiArchetype> = {};
    for (const seat of rt.seats.values()) {
      if (seat.kind !== 'ai' || seat.factionId === null) continue;
      const archetype = rt.aiArchetypes.get(seat.factionId);
      if (archetype) out[seat.factionId] = archetype;
    }
    return out;
  }

  async getMapLayout(roomId: string): Promise<MapLayout> {
    return this.ensure(roomId).scenario.mapLayout;
  }

  async getTurnReport(roomId: string, turn: number): Promise<TurnReport | null> {
    this.ensure(roomId);
    return this.store.loadTurn(roomId, turn);
  }

  async getMatchMemory(roomId: string, recipient: SeatId | 'spectator'): Promise<MatchMemory> {
    const rt = this.ensure(roomId);
    const row = this.store.loadRoom(roomId);
    if (!row) throw new Error(`房间不存在：${roomId}`);
    const seat = recipient === 'spectator' ? null : rt.seats.get(recipient) ?? null;
    if (recipient !== 'spectator' && !seat) throw new Error(`席位不存在：${recipient}`);
    // 观战端/观战席位拿全知版本；玩家席位只拿自己可见的部分，绝不通过记忆接口绕过迷雾。
    const full = recipient === 'spectator' || seat?.kind === 'spectator';
    const viewerFaction = full ? null : seat?.factionId ?? null;
    const viewerSeatId = seat?.seatId ?? null;
    const eventRows = this.store.readEventRows(roomId, 1);
    const visibleEvents = eventRows.filter((e) => full || (!viewerFaction || audienceIncludes(e.audience, viewerFaction)));
    const eventsByTurn = new Map<number, typeof visibleEvents>();
    for (const e of visibleEvents) {
      const list = eventsByTurn.get(e.turn) ?? [];
      list.push(e);
      eventsByTurn.set(e.turn, list);
    }

    const turns: MatchMemoryTurn[] = [];
    for (let turn = 1; turn <= rt.state.turn; turn++) {
      const report = this.store.loadTurn(roomId, turn);
      if (!report) continue;
      turns.push({
        turn: report.turn,
        stateDigest: report.stateDigest,
        resolvedAt: report.resolvedAt,
        events: (eventsByTurn.get(turn) ?? []).map((e) => e.payload as DomainEvent),
        orders: full
          ? report.orders
          : report.orders.filter((o) => o.seatId === viewerSeatId),
        baseline: full
          ? report.baseline
          : report.baseline.filter((d) => d.scope === `faction:${viewerFaction}`),
        clamps: full
          ? report.clamps
          : report.clamps.filter((c) => c.scope === `faction:${viewerFaction}`),
        rejected: full ? report.rejected : report.rejected.filter((r) => r.seatId === viewerSeatId),
        narratives: full
          ? report.narratives
          : viewerSeatId && report.narratives[viewerSeatId]
            ? { [viewerSeatId]: report.narratives[viewerSeatId]! }
            : {},
      });
    }

    const messages = this.store.loadMessages(roomId).filter((m) => {
      if (full) return true;
      if (m.publicity === 'public') return true;
      return m.fromSeat === viewerSeatId || m.toSeat === viewerSeatId;
    });

    return {
      format: 'guozhan-match-memory',
      version: 1,
      generatedAt: nowMs(),
      room: {
        roomId: rt.roomId,
        name: row.name,
        scenarioId: rt.scenario.meta.id,
        rootSeed: rt.rootSeed,
        turn: rt.state.turn,
        phase: rt.state.phase,
        maxTurns: row.maxTurns,
        winner: rt.state.winner,
        endReason: rt.state.endReason,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
      viewer: {
        recipient,
        seatId: viewerSeatId,
        factionId: viewerFaction,
        full,
      },
      seats: [...rt.seats.values()].map((s) => ({
        seatId: s.seatId,
        factionId: s.factionId,
        kind: s.kind,
        connected: s.connected,
        autoCommit: s.autoCommit,
        llmDriven: s.llmDriven,
      })),
      turns,
      events: visibleEvents.map((e) => ({
        offset: e.offset,
        turn: e.turn,
        type: e.type,
        payload: e.payload,
      })),
      messages: messages.map((m) => ({ ...m })),
    };
  }

  async getState(roomId: string): Promise<{ state: GameState; world: WorldConfig; scenario: LoadedScenario['meta'] } | null> {
    const rt = this.rooms.get(roomId);
    if (!rt) {
      const row = this.store.loadRoom(roomId);
      if (!row) return null;
    }
    const loaded = this.ensure(roomId);
    return { state: loaded.state, world: loaded.scenario.world, scenario: loaded.scenario.meta };
  }

  async getPendingAdvice(roomId: string, seatId: SeatId): Promise<readonly AdviceRecord[]> {
    this.ensure(roomId);
    return this.store.loadAdvice(roomId, seatId, 'pending');
  }

  async getLegalActions(
    roomId: string,
    seatId: SeatId,
  ): Promise<{ turn: number; stateId: string; actions: readonly LegalAction[] }> {
    const rt = this.ensure(roomId);
    const seat = rt.seats.get(seatId);
    const faction = seat?.factionId ? rt.state.factions[seat.factionId] : undefined;
    if (!seat || !seat.factionId || !faction || faction.eliminated || rt.state.phase === 'ended') {
      return { turn: rt.state.turn, stateId: rt.digest, actions: [] };
    }
    return {
      turn: rt.state.turn,
      stateId: rt.digest,
      // 人类 UI 必须看到全量动作：按类截断会让中后期的边境/内政动作凭空消失，
      // 看起来像“这个地块什么都不能做”。LLM/军师快照仍使用带 per-kind cap 的列表。
      actions: enumerateLegalActions(rt.state, rt.scenario.world, seat.factionId, { maxActions: 2000, uncapped: true, moveAttacks: true }),
    };
  }

  // ─────────────────────────────────────────────────────────────
  // 写入
  // ─────────────────────────────────────────────────────────────

  async submitCommands(opts: SubmitOptions): Promise<CommandResult> {
    const { principal, envelope } = opts;
    const rt = this.ensure(principal.roomId);
    const turn = rt.state.turn;

    if (principal.readOnly) {
      return failed(RejectionCode.SEAT_NOT_AUTHORIZED, '观战席位只读，不能提交命令', turn, rt.digest);
    }
    const seat = rt.seats.get(principal.seatId);
    if (!seat || seat.factionId === null || seat.factionId !== principal.factionId) {
      return failed(RejectionCode.SEAT_NOT_AUTHORIZED, '席位与势力不匹配', turn, rt.digest);
    }
    if (rt.state.phase === 'ended') {
      return failed(RejectionCode.MATCH_FINISHED, '对局已结束', turn, rt.digest);
    }
    if (rt.state.phase !== 'submitting') {
      return failed(RejectionCode.PHASE_NOT_SUBMITTING, `当前阶段（${rt.state.phase}）不接受命令`, turn, rt.digest);
    }
    if (rt.locked.has(principal.seatId)) {
      return failed(RejectionCode.ORDERS_ALREADY_LOCKED, '本回合已锁定，不能再追加命令', turn, rt.digest);
    }
    if (envelope.stateId !== rt.digest) {
      return failed(RejectionCode.STALE_REVISION, '你手上的 stateId 已过期，请重拉快照', turn, rt.digest, {
        expected: rt.digest,
        got: envelope.stateId,
      });
    }

    const paramsHash = sha256(stableStringify(envelope.commands));
    const prior = this.store.loadReceiptRow(principal.roomId, envelope.requestId);
    if (prior) {
      if (prior.paramsHash !== paramsHash) {
        return failed(RejectionCode.STALE_REVISION, '同 requestId 但命令参数不同（幂等键冲突）', turn, rt.digest, {
          requestId: envelope.requestId,
        });
      }
      return { ...prior.result, replayed: true };
    }

    const parsed = CommandEnvelopeSchema.safeParse(envelope);
    if (!parsed.success) {
      return failed(
        RejectionCode.MALFORMED_PAYLOAD,
        `命令信封不合法：${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        turn,
        rt.digest,
      );
    }

    const steps: CommandStepResult[] = [];
    const now = nowMs();
    for (let i = 0; i < parsed.data.commands.length; i++) {
      const command = parsed.data.commands[i]! as Record<string, unknown>;
      const declared = typeof command['factionId'] === 'string' ? command['factionId'] : null;
      if (declared !== null && declared !== principal.factionId) {
        steps.push({
          index: i,
          ok: false,
          code: RejectionCode.SEAT_NOT_AUTHORIZED,
          message: `命令声明的势力 ${declared} 与席位势力 ${principal.factionId} 不符`,
        });
        break;
      }
      // ★提交时快速失败：冒充别人的部队/区域是最常见的伪造向量。
      //   core 在结算时仍会再判一次（那才是权威），这里只是让 AI/玩家**立刻**拿到拒绝码，
      //   而不是等一回合后在战报里才发现命令没生效。
      const forged = this.detectForgery(rt, principal.factionId, command);
      if (forged !== null) {
        steps.push({ index: i, ok: false, code: forged.code, message: forged.message });
        break;
      }
      this.store.savePendingOrder(principal.roomId, {
        turn,
        seatId: principal.seatId,
        index: this.nextOrderIndex(rt, principal.seatId),
        requestId: envelope.requestId,
        factionId: principal.factionId,
        kind: String(command['kind'] ?? ''),
        command,
        createdAt: now,
      });
      steps.push({ index: i, ok: true });
    }

    const status: CommandResult['status'] =
      steps.length === 0 ? 'failed' : steps.every((s) => s.ok) ? 'completed' : steps[0]!.ok ? 'partial' : 'failed';
    const result: CommandResult = {
      status,
      completedSteps: steps.filter((s) => s.ok).length,
      steps,
      replayed: false,
      stateId: rt.digest,
      turn,
    };
    this.store.saveReceiptRow(
      principal.roomId,
      envelope.requestId,
      {
        stateDigest: rt.digest,
        paramsHash,
        seatId: principal.seatId,
        turn,
        result,
      },
      now,
    );
    this.touch(rt);
    return result;
  }

  /** AI 的命令入口 —— 与人类完全同一条通道，任何后门都没有 */
  private async submitAiCommands(roomId: string, seatId: SeatId, commands: readonly unknown[]): Promise<CommandResult> {
    const rt = this.ensure(roomId);
    const seat = rt.seats.get(seatId);
    if (!seat || seat.factionId === null) {
      return failed(RejectionCode.SEAT_NOT_AUTHORIZED, 'AI 席位无效', rt.state.turn, rt.digest);
    }
    const envelope: CommandEnvelope = {
      stateId: rt.digest,
      requestId: `ai_${seatId}_${rt.state.turn}_${randomBytes(4).toString('hex')}`,
      commands: commands as CommandEnvelope['commands'],
    };
    return this.submitCommands({
      principal: this.principalOf(rt, seat),
      envelope,
    });
  }

  async adoptAdvice(opts: {
    principal: Principal;
    adviceId: string;
    commandIndices?: readonly number[];
  }): Promise<CommandResult> {
    const rt = this.ensure(opts.principal.roomId);
    const advice = this.store
      .loadAdvice(opts.principal.roomId, opts.principal.seatId, 'pending')
      .find((a) => a.id === opts.adviceId);
    if (!advice) {
      return failed(RejectionCode.UNKNOWN_ADVICE, `建议 ${opts.adviceId} 不存在或已处理`, rt.state.turn, rt.digest);
    }
    if (advice.snapshotDigest !== rt.digest) {
      this.store.updateAdviceStatus(opts.principal.roomId, advice.id, 'expired');
      return failed(RejectionCode.STALE_REVISION, '该建议基于旧局面，已失效，请重新请求', rt.state.turn, rt.digest);
    }
    const picked =
      opts.commandIndices === undefined
        ? advice.commands
        : opts.commandIndices.map((i) => advice.commands[i]).filter((c): c is { legalActionId: string; command: unknown } => c !== undefined);
    if (picked.length === 0) {
      return failed(RejectionCode.MALFORMED_PAYLOAD, '没有可采纳的动作', rt.state.turn, rt.digest);
    }
    // ★幂等键由 (建议 id + 采纳范围) 决定，不能带时间戳：网络重试若换新 requestId，
    //   同一批命令会被入队两次（重复征兵/重复建设）。
    const indicesKey =
      opts.commandIndices === undefined ? 'all' : [...opts.commandIndices].sort((a, b) => a - b).join('_');
    const envelope: CommandEnvelope = {
      stateId: rt.digest,
      requestId: `adopt_${advice.id}_${indicesKey}`,
      commands: picked.map((p) => p.command) as CommandEnvelope['commands'],
    };
    const result = await this.submitCommands({ principal: opts.principal, envelope });
    if (result.status === 'completed') {
      this.store.updateAdviceStatus(opts.principal.roomId, advice.id, 'accepted');
      this.appendAndNotify(rt, [
        {
          type: 'advice_resolved',
          turn: rt.state.turn,
          adviceId: advice.id,
          status: 'accepted',
          droppedCount: advice.violations.filter((v) => v.action === 'dropped').length,
        } as DomainEvent,
      ]);
    }
    return result;
  }

  async lockOrders(principal: Principal): Promise<{ locked: boolean; waiting: readonly SeatId[] }> {
    const rt = this.ensure(principal.roomId);
    if (principal.readOnly || rt.state.phase === 'ended') {
      return { locked: false, waiting: this.waitingSeats(rt).filter((s) => !rt.locked.has(s)) };
    }
    rt.locked.add(principal.seatId);
    this.store.saveSubmission(principal.roomId, rt.state.turn, principal.seatId, nowMs(), false);
    const waiting = this.waitingSeats(rt).filter((s) => !rt.locked.has(s));
    if (waiting.length === 0) await this.maybeResolve(principal.roomId);
    return { locked: true, waiting };
  }

  async timeoutLock(roomId: string, seatId: SeatId): Promise<void> {
    const rt = this.ensure(roomId);
    if (rt.state.phase === 'ended' || rt.locked.has(seatId)) return;
    rt.locked.add(seatId);
    this.store.saveSubmission(roomId, rt.state.turn, seatId, nowMs(), true);
    if (this.waitingSeats(rt).every((s) => rt.locked.has(s))) await this.maybeResolve(roomId);
  }

  // ─────────────────────────────────────────────────────────────
  // 回合推进
  // ─────────────────────────────────────────────────────────────

  async resolveTurn(
    roomId: string,
    opts?: { llmDelta?: Readonly<Record<FactionId, SanitizedLlmDelta>> },
  ): Promise<TurnReport> {
    return this.withLock(roomId, async () => this.resolveNow(roomId, opts?.llmDelta));
  }

  private async resolveNow(
    roomId: string,
    extraDelta?: Readonly<Record<FactionId, SanitizedLlmDelta>>,
  ): Promise<TurnReport> {
    const rt = this.ensure(roomId);
    if (rt.resolving) throw new Error('本房间正在结算，请勿重入');
    if (rt.state.phase === 'ended') throw new Error('对局已结束');
    rt.resolving = true;
    try {
      const turn = rt.state.turn;
      const rows = this.store.loadPendingOrders(roomId, turn);
      const orders: AcceptedOrder[] = rows
        .slice()
        .sort((a, b) => (a.seatId === b.seatId ? a.index - b.index : a.seatId < b.seatId ? -1 : 1))
        .map((r) => ({ seatId: r.seatId, factionId: r.factionId as FactionId, command: r.command, kind: r.kind }));

      const deltas = new Map<FactionId, SanitizedLlmDelta[]>(rt.llmDeltas);
      for (const [fid, d] of Object.entries(extraDelta ?? {})) {
        if (!d) continue;
        deltas.set(fid, [...(deltas.get(fid) ?? []), d]);
      }

      const outcome = resolveCore({
        state: rt.state,
        world: rt.scenario.world,
        modules: buildModules(rt.scenario.meta.moduleOrder),
        orders,
        rootSeed: rt.rootSeed,
        turn,
        now: nowMs(),
        digest: digestState,
        llmDelta: mergeLlmDeltas(deltas),
      });

      const ended = outcome.state.phase === 'ended';
      const nextState: GameState = ended
        ? outcome.state
        : {
            ...outcome.state,
            turn: turn + 1,
            phase: 'submitting',
            submitted: [] as SeatId[],
          };
      const nextDigest = digestState(nextState);
      const events = (outcome.events as DomainEvent[]).map((e) =>
        e.type === 'turn_resolved' ? { ...e, stateId: nextDigest } : e,
      );

      const advice = this.store.loadAdviceByTurn(roomId, turn);
      const report: TurnReport = {
        roomId,
        turn,
        stateDigest: nextDigest,
        // 按席位聚合：同一席位可能提交了多条命令（多个信封），战报要按人展示
        orders: [...new Set(orders.map((o) => o.seatId))]
          .sort()
          .map((seatId) => ({
            seatId,
            commands: orders.filter((o) => o.seatId === seatId).map((o) => o.command),
          })),
        baseline: outcome.deltas.map((d) => ({
          scope: d.scope,
          field: d.field,
          oldValue: d.oldValue,
          newValue: d.newValue,
          delta: d.delta,
          reason: d.reason,
          source: d.source,
        })),
        llmDelta: outcome.llmApplied ? mergeLlmDeltas(deltas) : null,
        violations: advice.flatMap((a) => a.violations.map((v) => ({ ...v, severity: v.severity }))),
        clamps: outcome.clamps.map((c) => ({
          scope: c.scope,
          field: c.field,
          beforeClamp: c.beforeClamp,
          afterClamp: c.afterClamp,
          limit: c.limit,
        })),
        events,
        narratives: {},
        rejected: outcome.rejected.map((r) => ({ seatId: r.seatId, index: r.index, code: r.code, message: r.message })),
        llmApplied: outcome.llmApplied,
        resolvedAt: nowMs(),
      };

      const evidence = events
        .filter((e): e is Extract<DomainEvent, { type: 'combat_resolved' }> => e.type === 'combat_resolved')
        .map((e) => e.evidence);

      this.store.commitTurn(roomId, {
        turn,
        state: nextState,
        stateDigest: nextDigest,
        phase: nextState.phase,
        orders: report.orders.map((o) => ({ seatId: o.seatId, commands: o.commands })),
        baseline: report.baseline,
        llmDelta: report.llmDelta,
        violations: report.violations,
        clamps: report.clamps,
        events,
        evidence,
        narratives: null,
        rejected: report.rejected,
        llmApplied: report.llmApplied,
        resolvedAt: report.resolvedAt,
      });

      // ★commitTurn 的 turn 列记的是“刚结算的回合”；房间头要指向**下一回合**，
      //   否则重启后 getRoom 会报 turn=1 而 state_json 已是 turn=2。
      this.store.saveState(roomId, nextState, nextDigest, nextState.phase, nextState.turn, nowMs());
      this.store.clearPendingOrders(roomId, turn);
      this.store.clearSubmissions(roomId, turn);

      rt.state = nextState;
      rt.digest = nextDigest;
      rt.locked.clear();
      rt.llmDeltas.clear();
      rt.adviceStarted.clear();
      this.index.upsert({
        roomId,
        name: this.infoOf(rt).name,
        scenarioId: rt.scenario.meta.id,
        createdAt: this.store.loadRoom(roomId)?.createdAt ?? nowMs(),
        updatedAt: nowMs(),
        phase: nextState.phase,
        turn: nextState.turn,
      });

      // ★状态先定、叙事后到（P11）：事件立刻派发，叙事异步补
      this.deliverNewEvents(rt, events);
      if (!ended) {
        if (this.autoAdvice) setImmediate(() => void this.kickoff(roomId));
        setImmediate(() => void this.generateNarratives(roomId, turn));
      }
      return report;
    } finally {
      rt.resolving = false;
    }
  }

  async generateNarratives(roomId: string, turn: number): Promise<void> {
    if (!this.llm.enabled) return;
    const rt = this.ensure(roomId);
    const report = this.store.loadTurn(roomId, turn);
    if (!report) return;
    for (const seat of rt.seats.values()) {
      if (seat.kind !== 'human' || seat.factionId === null) continue;
      const faction = rt.state.factions[seat.factionId];
      if (!faction || faction.eliminated) continue;
      const facts = report.events
        .filter((e) => this.eventMentionsFaction(e, seat.factionId!))
        .slice(0, 8)
        .map((e) => this.describeEvent(e, rt.state));
      if (facts.length === 0) continue;
      const prompt = renderNarrativePrompt({
        factionName: faction.name,
        turn,
        facts,
        language: 'zh',
        maxChars: 600,
      });
      const res = await this.llm.chat({
        purpose: 'narrative',
        system: prompt.system,
        user: prompt.user,
        maxTokens: rt.scenario.meta.llm.narrativeMaxTokens,
        temperature: 0.8,
        json: false,
      });
      this.onLlmCall(roomId, seat.seatId, res.record);
      if (res.record.status !== 'ok' || res.text.length === 0) continue;
      this.store.saveNarratives(roomId, turn, { [seat.seatId]: res.text });
      this.appendAndNotify(rt, [
        {
          type: 'narrative_chunk',
          turn,
          seatId: seat.seatId,
          seq: 0,
          text: res.text,
          done: true,
          degraded: false,
        } as DomainEvent,
      ]);
    }
  }

  async requestAdvice(roomId: string, seatId: SeatId): Promise<{ adviceId: string } | { skipped: string }> {
    const rt = this.ensure(roomId);
    const seat = rt.seats.get(seatId);
    if (!seat || seat.factionId === null) return { skipped: 'seat_not_found' };
    const faction = rt.state.factions[seat.factionId];
    if (!faction || faction.eliminated) return { skipped: 'faction_eliminated' };
    if (rt.state.phase === 'ended') return { skipped: 'match_finished' };

    const snapshot = await this.getSnapshot(roomId, seatId);
    const facts = this.factsFor(rt, seat.factionId);
    const milestones = evaluateMilestones(
      rt.state,
      rt.scenario.world,
      seat.factionId,
      rt.scenario.meta.milestones,
      facts,
    );
    const personality = this.personalityOf(rt, seat.factionId);
    const archetype = seat.kind === 'ai' && seat.factionId !== null
      ? rt.aiArchetypes.get(seat.factionId)
      : undefined;

    const outcome = await this.advisor.request({
      roomId,
      seatId,
      factionId: seat.factionId,
      snapshot,
      state: rt.state,
      world: rt.scenario.world,
      scenario: {
        name: rt.scenario.meta.name,
        description: rt.scenario.meta.description,
        maxTurns: rt.scenario.meta.maxTurns,
        language: rt.scenario.meta.llm.language === 'en' ? 'en' : 'zh',
      },
      personality,
      ...(archetype ? { archetype } : {}),
      rootSeed: rt.rootSeed,
      milestones,
      pastLessons: this.pastLessons(rt),
      autoCommit: seat.autoCommit,
      llmDriven: seat.llmDriven,
      tokenUsed: seat.tokenUsed,
      tokenCap: seat.tokenCap,
      maxTokens: rt.scenario.meta.llm.advisorMaxTokens,
      temperature: rt.scenario.meta.llm.temperature,
      humanNotes: [],
    });

    if (outcome.kind === 'advice') return { adviceId: outcome.record.id };

    // 启发式降级：advisor 只给决策，提交仍走房间层的同一条通道。
    // ★即使这一回合**没有任何合法动作**也必须锁定（等于弃权）：
    //   否则该席位永远不进 waitingSeats 的已锁定集合，回合永远凑不齐人 —— 实测会让自动局卡死在第 2 回合。
    if (outcome.kind === 'heuristic' && seat.autoCommit) {
      if (outcome.decision.commands.length > 0) {
        await this.submitAiCommands(roomId, seatId, outcome.decision.commands.map((c) => c.command));
      }
      await this.lockSeatInternal(roomId, seatId);
    }
    return { skipped: outcome.kind === 'heuristic' ? `heuristic:${outcome.reason}` : outcome.reason };
  }

  // ─────────────────────────────────────────────────────────────
  // 事件流
  // ─────────────────────────────────────────────────────────────

  subscribe(
    roomId: string,
    recipient: SeatId | 'spectator',
    fromOffset: number,
    sink: (batch: EventBatch) => void,
  ): Unsubscribe {
    const rt = this.ensure(roomId);
    const sub: Subscriber = { recipient, sink };
    const backlog = this.projectRows(rt, recipient, this.store.readEventRows(roomId, fromOffset, 500));
    if (backlog !== null) sink(backlog);
    rt.subscribers.add(sub);
    return () => {
      rt.subscribers.delete(sub);
    };
  }

  async nextOffset(roomId: string): Promise<number> {
    this.ensure(roomId);
    const rows = this.store.readEventRows(roomId, 0, 1_000_000);
    return rows.length === 0 ? 1 : rows[rows.length - 1]!.offset + 1;
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    for (const rt of this.rooms.values()) rt.subscribers.clear();
    for (const roomId of this.store.openRoomIds()) {
      try {
        this.store.close(roomId);
      } catch {
        // 关不掉也要继续关下一个；WAL 由 SQLite 自行恢复
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 内部：装载 / 锁队列
  // ─────────────────────────────────────────────────────────────

  private ensure(roomId: string): Runtime {
    const cached = this.rooms.get(roomId);
    if (cached) return cached;
    const row = this.store.loadRoom(roomId);
    if (!row) throw new Error(`房间不存在：${roomId}`);
    const baseScenario = loadScenario(row.scenarioId, row.rootSeed, this.opts.configRoot);
    const scenario = row.maxTurns === 0 ? this.scenarioWithMaxTurns(baseScenario, 0) : baseScenario;
    // ★身份校验 fail-closed：规则版本或内容变了，旧档不得继续跑
    this.store.verifyIdentity(roomId, {
      behaviorFingerprint: scenario.meta.behaviorFingerprint,
      contentHash: scenario.contentHash,
    });
    const loaded = this.store.loadState(roomId);
    if (!loaded) throw new Error(`房间 ${roomId} 没有权威状态`);
    /**
     * ★旧档迁移：修复 movedThisTurn 只置 true 不复位的旧 bug。
     * 旧版结算后会把"已移动"永久留在状态里；新回合加载时清零并重算 digest，
     * 否则旧房间里的部队会在升级后多停摆一回合。只在 submitting 阶段做（此时单位本应可用）。
     */
    let restoredState = loaded.state;
    let restoredDigest = loaded.digest;
    let migrated = false;
    if (restoredState.phase === 'submitting' && Object.values(restoredState.units).some((u) => u.movedThisTurn)) {
      const units: Record<string, UnitState> = {};
      for (const id of Object.keys(restoredState.units).sort()) {
        units[id] = { ...restoredState.units[id]!, movedThisTurn: false };
      }
      restoredState = { ...restoredState, units };
      migrated = true;
    }
    /**
     * ★旧档迁移：infrastructure 是后加字段。旧存档没有它时补 0（等价于从未修建），
     *   否则快照/结算会读到 undefined。只在确实缺失时重算 digest。
     */
    if (Object.values(restoredState.regions).some((r) => r.infrastructure === undefined)) {
      const regions: Record<string, RegionState> = {};
      for (const id of Object.keys(restoredState.regions).sort()) {
        const r = restoredState.regions[id]!;
        regions[id] = { ...r, infrastructure: r.infrastructure ?? 0 };
      }
      restoredState = { ...restoredState, regions };
      migrated = true;
    }
    /**
     * ★旧档迁移：intel 是后加字段（间谍系统）。旧存档没有它时补空表，
     *   语义等于“从未侦察过”，不会凭空获得情报。
     */
    if (Object.values(restoredState.factions).some((f) => f.intel === undefined)) {
      const factions: Record<string, FactionState> = {};
      for (const id of Object.keys(restoredState.factions).sort()) {
        const f = restoredState.factions[id]!;
        factions[id] = { ...f, intel: f.intel ?? {} };
      }
      restoredState = { ...restoredState, factions };
      migrated = true;
    }
    if (migrated) {
      restoredDigest = digestState(restoredState);
      this.store.saveState(roomId, restoredState, restoredDigest, restoredState.phase, restoredState.turn, nowMs());
    }
    const seats = new Map<SeatId, SeatInfo>();
    for (const s of this.store.loadSeats(roomId)) {
      seats.set(s.seatId, {
        seatId: s.seatId,
        factionId: s.factionId,
        kind: s.kind,
        autoCommit: s.autoCommit,
        llmDriven: s.llmDriven,
        aiProfile: s.aiProfile,
        tokenUsed: s.tokenUsed,
        tokenCap: s.tokenCap,
        connected: false,
        controllerId: s.controllerId,
      });
    }
    const loadedAiFactions = [...seats.values()]
      .filter((s) => s.kind === 'ai' && s.factionId !== null)
      .map((s) => s.factionId as FactionId)
      .sort();
    const aiArchetypes = new Map<FactionId, AiArchetype>(
      Object.entries(assignAiArchetypes(row.rootSeed, loadedAiFactions)) as Array<[FactionId, AiArchetype]>,
    );
    const rt: Runtime = {
      roomId,
      rootSeed: row.rootSeed,
      scenario,
      state: restoredState,
      digest: restoredDigest,
      seats,
      aiArchetypes,
      locked: new Set(),
      subscribers: new Set(),
      adviceStarted: new Set(),
      llmDeltas: new Map(),
      factsCache: new Map(),
      reviewCache: new Map(),
      // 重启后：只要已经有真人在场（controllerId 非空）或本来就没有真人席位，就算已开局
      started: [...seats.values()].every((s) => s.kind !== 'human') ||
        [...seats.values()].some((s) => s.kind === 'human' && s.controllerId !== null),
      resolving: false,
      chain: { tail: Promise.resolve() },
    };
    this.rooms.set(roomId, rt);
    return rt;
  }

  private async withLock<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
    const rt = this.ensure(roomId);
    const run = rt.chain.tail.then(fn, fn);
    rt.chain.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async maybeResolve(roomId: string): Promise<void> {
    const rt = this.ensure(roomId);
    if (!rt.started || rt.resolving || rt.state.phase === 'ended') return;
    const waiting = this.waitingSeats(rt).filter((s) => !rt.locked.has(s));
    if (waiting.length > 0) return;
    await this.resolveTurn(roomId);
  }

  /** 必须锁定的席位：真人未认领的座位不参与法定人数，否则房间永远开不了局 */
  private waitingSeats(rt: Runtime): SeatId[] {
    const out: SeatId[] = [];
    for (const seat of [...rt.seats.values()].sort((a, b) => (a.seatId < b.seatId ? -1 : 1))) {
      if (seat.kind === 'spectator' || seat.factionId === null) continue;
      const faction = rt.state.factions[seat.factionId];
      if (!faction || faction.eliminated) continue;
      if (seat.kind === 'human' && seat.controllerId === null) continue;
      out.push(seat.seatId);
    }
    return out;
  }

  private async lockSeatInternal(roomId: string, seatId: SeatId): Promise<void> {
    const rt = this.ensure(roomId);
    if (rt.locked.has(seatId)) return;
    rt.locked.add(seatId);
    this.store.saveSubmission(roomId, rt.state.turn, seatId, nowMs(), false);
    if (this.waitingSeats(rt).every((s) => rt.locked.has(s))) await this.maybeResolve(roomId);
  }

  // ─────────────────────────────────────────────────────────────
  // 内部：AI 回调
  // ─────────────────────────────────────────────────────────────

  private onLlmCall(roomId: string, seatId: SeatId, record: LlmCallRecord): void {
    const rt = this.rooms.get(roomId);
    const tokens = record.usage.totalTokens ?? 0;
    this.store.logLlmCall(roomId, {
      turn: rt?.state.turn ?? null,
      seatId,
      purpose: record.purpose,
      provider: record.provider,
      model: record.model,
      promptTokens: record.usage.promptTokens,
      completionTokens: record.usage.completionTokens,
      totalTokens: record.usage.totalTokens,
      latencyMs: record.latencyMs,
      status: record.status,
      error: record.error,
      requestedAt: record.requestedAt,
    });
    if (!rt) return;
    const seat = rt.seats.get(seatId);
    if (!seat) return;
    const next: SeatInfo = { ...seat, tokenUsed: seat.tokenUsed + tokens };
    rt.seats.set(seatId, next);
    this.persistSeat(roomId, next, nowMs());
  }

  private onAdviceDelta(roomId: string, seatId: SeatId, delta: SanitizedLlmDelta): void {
    const rt = this.rooms.get(roomId);
    const seat = rt?.seats.get(seatId);
    if (!rt || !seat || seat.factionId === null) return;
    const list = rt.llmDeltas.get(seat.factionId) ?? [];
    list.push(delta);
    rt.llmDeltas.set(seat.factionId, list);
  }

  private onAdviceReady(roomId: string, seatId: SeatId, record: AdviceRecord, autoCommit: boolean): void {
    const rt = this.ensure(roomId);
    this.appendAndNotify(rt, [
      {
        type: 'advice_generated',
        turn: rt.state.turn,
        adviceId: record.id,
        seatId,
        autoCommit,
        summary: record.output.assessment.slice(0, 120),
        ...(record.output.chat ? { chat: record.output.chat.slice(0, 240) } : {}),
      } as DomainEvent,
    ]);
    const seat = rt.seats.get(seatId);
    if (autoCommit && seat && seat.kind === 'ai') void this.lockSeatInternal(roomId, seatId);
  }

  private async kickoff(roomId: string): Promise<void> {
    if (this.shuttingDown || !this.autoAdvice) return;
    let rt: Runtime;
    try {
      rt = this.ensure(roomId);
    } catch {
      return;
    }
    if (!rt.started || rt.state.phase === 'ended' || rt.resolving) return;
    const turn = rt.state.turn;
    for (const seat of [...rt.seats.values()].sort((a, b) => (a.seatId < b.seatId ? -1 : 1))) {
      if (seat.kind !== 'ai' || seat.factionId === null) continue;
      const faction = rt.state.factions[seat.factionId];
      if (!faction || faction.eliminated) continue;
      if (rt.locked.has(seat.seatId)) continue;
      const key = `${seat.seatId}:${turn}`;
      if (rt.adviceStarted.has(key)) continue;
      rt.adviceStarted.add(key);
      void this.requestAdvice(roomId, seat.seatId).catch(() => {
        // LLM/启发式失败不阻塞回合；超时由 timeoutLock 兜底
      });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 内部：告警 / 事实 / 叙事
  // ─────────────────────────────────────────────────────────────

  private readAlertConfigs(): AlertConfigEntry[] {
    const path = join(this.opts.configRoot, 'rules', 'alerts.json');
    try {
      const doc = JSON.parse(readFileSync(path, 'utf8')) as { alerts?: AlertConfigEntry[] };
      return doc.alerts ?? [];
    } catch {
      return [];
    }
  }

  private factsFor(rt: Runtime, fid: FactionId): AlertFacts {
    const cached = rt.factsCache.get(fid);
    if (cached && cached.turn === rt.state.turn) return cached.facts;
    const rows = this.store.readEventRows(rt.roomId, 0, 5000);
    const turn = rt.state.turn;
    let lastRecruit: number | null = null;
    let lastAttack: number | null = null;
    let attacksLaunched = 0;
    let regionsCaptured = 0;
    const attackedRegions: string[] = [];

    for (const row of rows) {
      const e = row.payload as DomainEvent;
      if (e.type === 'recruitment_completed' && e.factionId === fid) lastRecruit = e.turn;
      if (e.type === 'combat_resolved') {
        const attacker = e.evidence?.attacker.factionId ?? null;
        const defender = e.evidence?.defender.factionId ?? null;
        if (attacker === fid) {
          attacksLaunched++;
          lastAttack = Math.max(lastAttack ?? 0, e.turn);
        }
        if (defender === fid && e.turn === turn) attackedRegions.push(e.regionId);
      }
      if (e.type === 'region_captured' && e.to === fid) regionsCaptured++;
    }

    let idle = 0;
    let total = 0;
    let offensiveArmies = 0;
    for (const u of Object.values(rt.state.units)) {
      if (u.ownerId !== fid) continue;
      total += u.troops;
      if (u.movedThisTurn) idle += u.troops;
      const region = rt.scenario.world.regions[u.regionId];
      const touchesForeign = (region?.adjacency ?? []).some(
        (n) => rt.state.regions[n] && rt.state.regions[n]!.owner !== fid,
      );
      if (u.troops >= 8000 && touchesForeign) offensiveArmies++;
    }

    const facts: AlertFacts = {
      ...EMPTY_FACTS,
      attackedRegions,
      turnsSinceRecruit: lastRecruit === null ? turn - 1 : turn - lastRecruit,
      turnsSinceAttack: lastAttack === null ? turn - 1 : turn - lastAttack,
      idleTroopRatio: total === 0 ? 0 : idle / total,
      attacksLaunched,
      regionsCaptured,
      offensiveArmies,
    };
    rt.factsCache.set(fid, { turn: rt.state.turn, facts });
    return facts;
  }

  private alertsFor(rt: Runtime, fid: FactionId, seatId: SeatId): Alert[] {
    const facts = this.factsFor(rt, fid);
    const milestones = evaluateMilestones(
      rt.state,
      rt.scenario.world,
      fid,
      rt.scenario.meta.milestones,
      facts,
    );
    const alerts = evaluateAlerts(rt.state, rt.scenario.world, fid, this.alertConfigs, facts, milestones, 8);
    const key = `${seatId}:${rt.state.turn}`;
    if (alerts.length > 0 && !rt.adviceStarted.has(`alerts:${key}`)) {
      rt.adviceStarted.add(`alerts:${key}`);
      this.appendAndNotify(rt, [{ type: 'alerts_raised', turn: rt.state.turn, seatId, alerts } as DomainEvent]);
    }
    return alerts;
  }

  /**
   * 引擎侧自我复盘：上回合战报 → 指标 → lessons + 策略参数。
   * ★只给本席位；观战端不传 viewer，拿不到别人的复盘。
   */
  private selfReviewFor(rt: Runtime, fid: FactionId): SelfReview | undefined {
    const cached = rt.reviewCache.get(fid);
    if (cached && cached.turn === rt.state.turn) return cached.review;
    const faction = rt.state.factions[fid];
    if (!faction) return undefined;
    const prev = this.store.loadTurn(rt.roomId, Math.max(1, rt.state.turn - 1));
    const seat = [...rt.seats.values()].find((s) => s.factionId === fid);
    const rejectedForSeat = seat && prev
      ? prev.rejected.filter((r) => r.seatId === seat.seatId).length
      : 0;
    const personality = this.personalityOf(rt, fid);
    const archetype = seat?.kind === 'ai' ? rt.aiArchetypes.get(fid) : undefined;
    const review = deriveSelfReview({
      state: rt.state,
      world: rt.scenario.world,
      factionId: fid,
      aggression: personality.aggression,
      ...(archetype ? { archetype } : {}),
      ...(prev
        ? {
            previous: {
              turn: prev.turn,
              events: prev.events,
              baseline: prev.baseline,
              rejectedForSeat,
            },
          }
        : {}),
    });
    rt.reviewCache.set(fid, { turn: rt.state.turn, review });
    return review;
  }

  private pastLessons(rt: Runtime): string[] {
    const prev = this.store.loadTurn(rt.roomId, Math.max(1, rt.state.turn - 1));
    if (!prev) return [];
    const out: string[] = [];
    for (const r of prev.rejected.slice(0, 3)) out.push(`上回合命令被拒：${r.code} —— ${r.message}`);
    for (const v of prev.violations.slice(0, 2)) out.push(`闸门剔除：${v.rule} —— ${v.detail}`);
    return out;
  }

  private personalityOf(rt: Runtime, fid: FactionId): { aggression: number; diplomacy: string; description: string } {
    const key = `${rt.scenario.meta.id}:${fid}`;
    const cached = this.personalityCache.get(key);
    if (cached) return cached;
    const path = join(this.opts.configRoot, 'scenarios', rt.scenario.meta.id, 'factions.json');
    try {
      const doc = JSON.parse(readFileSync(path, 'utf8')) as {
        factions?: Array<{ id: string; personality?: { aggression?: number; diplomacy?: string; description?: string } }>;
      };
      const p = doc.factions?.find((f) => f.id === fid)?.personality;
      if (p) {
        const value = {
          aggression: typeof p.aggression === 'number' ? p.aggression : 0.5,
          diplomacy: p.diplomacy ?? 'balanced',
          description: p.description ?? '',
        };
        this.personalityCache.set(key, value);
        return value;
      }
    } catch {
      // 配置缺失不阻塞顾问；用中性人格兜底
    }
    const fallback = { aggression: 0.5, diplomacy: 'balanced', description: '' };
    this.personalityCache.set(key, fallback);
    return fallback;
  }

  private sinceLastTurn(rt: Runtime, viewer: FactionId | null): Snapshot['sinceLastTurn'] | undefined {
    if (viewer === null) return undefined;
    const prev = this.store.loadTurn(rt.roomId, Math.max(1, rt.state.turn - 1));
    if (!prev) return undefined;
    const captured: string[] = [];
    const lost: string[] = [];
    let battles = 0;
    for (const e of prev.events) {
      if (e.type === 'region_captured') {
        if (e.to === viewer) captured.push(e.regionId);
        if (e.from === viewer) lost.push(e.regionId);
      }
      if (e.type === 'combat_resolved') battles++;
    }
    return { captured: captured.sort(), lost: lost.sort(), battles, newAlerts: [] };
  }

  private eventMentionsFaction(e: DomainEvent, fid: FactionId): boolean {
    switch (e.type) {
      case 'region_captured':
        return e.to === fid || e.from === fid;
      case 'combat_resolved':
        return e.evidence?.attacker.factionId === fid || e.evidence?.defender.factionId === fid;
      case 'recruitment_completed':
      case 'infrastructure_completed':
      case 'spy_reported':
      case 'units_split':
      case 'units_merged':
      case 'faction_eliminated':
        return e.factionId === fid;
      case 'morale_changed':
        return e.factionId === fid;
      case 'message_delivered':
        return e.from === fid || e.to === fid;
      default:
        return false;
    }
  }

  private describeEvent(e: DomainEvent, state: GameState): string {
    switch (e.type) {
      case 'region_captured':
        return `${e.regionId} 易手：${e.from ?? '中立'} → ${e.to}（${e.reason === 'force_ratio' ? '兵力优势' : '守方士气崩溃'}）`;
      case 'combat_resolved': {
        const ev = e.evidence;
        return `${e.regionId} 战斗：${ev?.attacker.factionId ?? '?'} 攻 ${ev?.defender.factionId ?? '?'}，结果 ${String(ev?.outcome ?? '?')}`;
      }
      case 'recruitment_completed':
        return `${e.factionId} 在 ${e.regionId} 征募 ${e.unitType} ${e.count} 人`;
      case 'infrastructure_completed':
        return `${e.factionId} 在 ${e.regionId} 建成基建 Lv${e.toLevel}（动乱 -${e.unrestRelief}，全国民心 +${e.moraleGained}）`;
      case 'spy_reported':
        return `${e.factionId} 的间谍回报 ${e.regionId}（归属 ${e.targetOwner ?? '中立'}，情报有效至 T${e.expiresTurn}）`;
      case 'units_split':
        return `${e.factionId} 在 ${e.regionId} 分兵：${e.unitId} 分出 ${e.count}（留守 ${e.remaining}）`;
      case 'units_merged':
        return `${e.factionId} 在 ${e.regionId} 合兵：${e.fromUnitId} 并入 ${e.intoUnitId}，合计 ${e.total}`;
      case 'faction_eliminated':
        return `${e.factionId} 灭亡（${e.reason}）`;
      case 'morale_changed':
        return `${state.factions[e.factionId]?.name ?? e.factionId} 士气 ${e.from} → ${e.to}`;
      case 'message_delivered':
        return `外交文书：${e.from} → ${e.to ?? '天下'}（${e.body.slice(0, 60)}）`;
      default:
        return e.type;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 内部：事件写入与投影
  // ─────────────────────────────────────────────────────────────

  private appendAndNotify(rt: Runtime, events: readonly DomainEvent[]): void {
    if (events.length === 0) return;
    let offset = this.offsetNow(rt);
    const rows = events.map((event) => ({ offset: offset++, turn: rt.state.turn, type: event.type, payload: event }));
    this.store.appendEvents(rt.roomId, rows);
    this.deliverNewEvents(rt, events);
  }

  private deliverNewEvents(rt: Runtime, events: readonly DomainEvent[]): void {
    if (rt.subscribers.size === 0 || events.length === 0) return;
    const start = this.offsetNow(rt) - events.length;
    const rows = this.store.readEventRows(rt.roomId, Math.max(1, start), events.length + 8);
    for (const sub of rt.subscribers) {
      const batch = this.projectRows(rt, sub.recipient, rows);
      if (batch) sub.sink(batch);
    }
  }

  private projectRows(rt: Runtime, recipient: SeatId | 'spectator', rows: readonly EventRow[]): EventBatch | null {
    if (rows.length === 0) return null;
    const faction = recipient === 'spectator' ? 'spectator' : (rt.seats.get(recipient)?.factionId ?? null);
    const visible = rows
      .filter((r) => audienceIncludes(r.audience, faction))
      .map((r) => ({ offset: r.offset, event: r.payload as DomainEvent }));
    if (visible.length === 0) return null;
    return {
      roomId: rt.roomId,
      events: visible,
      stateDigest: rt.digest,
      turn: visible[visible.length - 1]!.event.turn ?? rt.state.turn,
    };
  }

  private offsetNow(rt: Runtime): number {
    const rows = this.store.readEventRows(rt.roomId, 0, 1_000_000);
    return rows.length === 0 ? 1 : rows[rows.length - 1]!.offset + 1;
  }

  // ─────────────────────────────────────────────────────────────
  // 内部：杂项
  // ─────────────────────────────────────────────────────────────

  /** 提交期伪造检查：只查"这条命令的操作对象是不是你的"，不查资源/合法性（那是 core 的事） */
  private detectForgery(
    rt: Runtime,
    fid: FactionId,
    command: Record<string, unknown>,
  ): { code: string; message: string } | null {
    const unitId = typeof command['unitId'] === 'string' ? command['unitId'] : null;
    if (unitId !== null) {
      const unit = rt.state.units[unitId];
      if (!unit) return { code: RejectionCode.UNKNOWN_UNIT, message: `部队 ${unitId} 不存在` };
      if (unit.ownerId !== fid) {
        return { code: RejectionCode.UNIT_NOT_OWNED, message: `部队 ${unitId} 属于 ${unit.ownerId}，不是你的` };
      }
    }
    const regionId = typeof command['regionId'] === 'string' ? command['regionId'] : null;
    if (regionId !== null && (
      command['kind'] === 'develop' ||
      command['kind'] === 'fortify' ||
      command['kind'] === 'build_infrastructure'
    )) {
      const region = rt.state.regions[regionId];
      if (!region) return { code: RejectionCode.UNKNOWN_REGION, message: `区域 ${regionId} 不存在` };
      if (region.owner !== fid) {
        return { code: RejectionCode.REGION_NOT_OWNED, message: `区域 ${regionId} 不属于你` };
      }
    }
    return null;
  }

  private principalOf(rt: Runtime, seat: SeatInfo): Principal {
    return {
      roomId: rt.roomId,
      seatId: seat.seatId,
      kind: seat.kind,
      factionId: seat.factionId,
      readOnly: seat.kind === 'spectator',
    };
  }

  private hasLiveTokenFor(roomId: string, seatId: SeatId): boolean {
    for (const ref of this.tokens.values()) if (ref.roomId === roomId && ref.seatId === seatId) return true;
    return false;
  }

  private nextOrderIndex(rt: Runtime, seatId: SeatId): number {
    const rows = this.store.loadPendingOrders(rt.roomId, rt.state.turn).filter((r) => r.seatId === seatId);
    return rows.length === 0 ? 0 : Math.max(...rows.map((r) => r.index)) + 1;
  }

  private persistSeat(roomId: string, seat: SeatInfo, joinedAt: number): void {
    this.store.saveSeat(roomId, {
      seatId: seat.seatId,
      kind: seat.kind,
      factionId: seat.factionId,
      controllerId: seat.controllerId,
      autoCommit: seat.autoCommit,
      llmDriven: seat.llmDriven,
      aiProfile: seat.aiProfile,
      tokenUsed: seat.tokenUsed,
      tokenCap: seat.tokenCap,
      joinedAt,
    });
  }

  private touch(rt: Runtime): void {
    const row = this.store.loadRoom(rt.roomId);
    if (!row) return;
    this.index.upsert({
      roomId: rt.roomId,
      name: row.name,
      scenarioId: row.scenarioId,
      createdAt: row.createdAt,
      updatedAt: nowMs(),
      phase: rt.state.phase,
      turn: rt.state.turn,
    });
  }

  private infoOf(rt: Runtime): RoomInfo {
    return {
      roomId: rt.roomId,
      name: this.store.loadRoom(rt.roomId)?.name ?? rt.roomId,
      scenarioId: rt.scenario.meta.id,
      phase: rt.state.phase,
      turn: rt.state.turn,
      maxTurns: rt.scenario.meta.maxTurns,
      rootSeed: rt.rootSeed,
      stateDigest: rt.digest,
      behaviorFingerprint: rt.scenario.meta.behaviorFingerprint,
      contentHash: rt.scenario.contentHash,
      seats: [...rt.seats.values()].sort((a, b) => (a.seatId < b.seatId ? -1 : 1)),
      createdAt: this.store.loadRoom(rt.roomId)?.createdAt ?? nowMs(),
      updatedAt: this.store.loadRoom(rt.roomId)?.updatedAt ?? nowMs(),
      winner: rt.state.winner,
      endReason: rt.state.endReason,
    };
  }
}

export function createRoomManager(opts: RoomManagerOptions): RoomManager {
  return new RoomManagerImpl(opts);
}
