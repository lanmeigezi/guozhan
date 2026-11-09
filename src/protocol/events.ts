/**
 * 事件协议 —— DomainEvent + ExecutionEvidence（P6）。
 *
 * 核心不变量：**掷骰证据由引擎产出并随事件下发，客户端只播放、绝不自己 roll。**
 * 这直接解决了 tavern-battle-mcp 实战用 CryptoRng 导致"战报无法复核、争议无法仲裁"的问题。
 *
 * 事件先按接收者投影再下发（战争迷雾），投影在 server 层做，核心只产规范事件。
 */
import { z } from 'zod';
import type { FactionId, RegionId, SeatId, UnitId } from './commands.ts';

// ─────────────────────────────────────────────────────────────
// ExecutionEvidence —— 确定性证据
// ─────────────────────────────────────────────────────────────

/** 一场战斗的完整掷骰证据。有了它，任何人都能复算出同样的结果。 */
export interface CombatExecution {
  /** 本场战斗的 RNG 种子 = f(rootSeed, turn, attackerId, defenderId) */
  readonly seed: number;
  /** 攻方出发地；UI 用它画「从哪打到哪」的箭头（旧存档事件可能没有） */
  readonly originRegion?: RegionId;
  /** 实际交战航线（水师可跨 1-2 条水路）；陆战通常就是 [出发地, 目标] */
  readonly attackPath?: readonly RegionId[];
  /** 本次进攻是否把双方从非战争状态推入战争（开战动员动乱记在出发地） */
  readonly startedWar?: boolean;
  readonly attackerMorale?: number;
  readonly defenderMorale?: number;
  /** 全国民心对攻/守战力的乘数 = 0.5 + morale / coefficient */
  readonly moraleFactorAttacker?: number;
  readonly moraleFactorDefender?: number;
  /** 兵种与克制加成（1.5 = +50%），用于战报解释“为什么赢/输” */
  readonly attackerType?: string;
  readonly defenderTypes?: readonly string[];
  readonly counters?: {
    readonly attackerBonus: number;
    readonly defenderBonus: number;
  };
  /** 本场战斗实际施加的地区动乱拆分（旧存档事件可能没有） */
  readonly unrest?: {
    readonly battle: number;
    readonly capture: number;
    readonly warDeclaration: number;
    /** 全国低民心的动乱放大系数；≥ 阈值时为 1 */
    readonly lowMoraleFactor: number;
    /** 地区动乱对守备战力的乘数 */
    readonly defenderUnrestFactor: number;
  };
  readonly attacker: {
    readonly factionId: FactionId;
    readonly unitId: UnitId;
    readonly troopsBefore: number;
    readonly troopsAfter: number;
    /** 有效战力 = 兵力 × 士气系数 × 兵种系数 */
    readonly effectivePower: number;
  };
  readonly defender: {
    readonly factionId: FactionId;
    readonly regionId: RegionId;
    readonly troopsBefore: number;
    readonly troopsAfter: number;
    readonly effectivePower: number;
  };
  readonly rounds: ReadonlyArray<{
    readonly round: number;
    /** 攻方骰值（由种子派生，可复算） */
    readonly attackRoll: number;
    readonly defenseRoll: number;
    readonly modifiers: {
      readonly terrain: number;
      readonly fort: number;
      readonly moraleAttacker: number;
      readonly moraleDefender: number;
      /** 守方地区动乱对守备战力的乘数（旧存档事件可能没有） */
      readonly unrestDefender?: number;
    };
    readonly attackerLosses: number;
    readonly defenderLosses: number;
  }>;
  readonly outcome: 'attacker_win' | 'defender_win' | 'stalemate' | 'attacker_rout' | 'defender_rout';
  readonly captured: boolean;
  /** 城池易手的**确定性**理由（P2：LLM 的 result 字符串根本不是门） */
  readonly captureReason: 'force_ratio' | 'morale_collapse' | 'not_authorized' | 'not_adjacent';
  readonly powerRatio: number;
}

/** 一次资源结算的证据：逐项增量带 reason 与 source（Histrategy turn_delta） */
export interface ResourceDelta {
  readonly scope: string; // faction:<id> | region:<id>
  readonly field: string; // gold | food | troops | morale | development | owner ...
  readonly oldValue: number;
  readonly newValue: number;
  readonly delta: number;
  readonly reason: string; // "屯田制 +5%" / "战斗伤亡 -2000"
  /** ★归因：这个数是代码算的还是 LLM 提的 */
  readonly source: 'deterministic' | 'llm' | 'event';
}

/** 极值钳制命中记录（per-faction 独立，不按最大涨幅者全体缩放） */
export interface ClampRecord {
  readonly scope: string;
  readonly field: string;
  readonly beforeClamp: number;
  readonly afterClamp: number;
  readonly limit: string; // 'troop_gain:0.50' 等
}

// ─────────────────────────────────────────────────────────────
// DomainEvent
// ─────────────────────────────────────────────────────────────

export const DomainEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('turn_started'),
    turn: z.number().int(),
    /** 各席位的提交截止时间戳（ms）；酒馆扩展据此显示倒计时 */
    deadline: z.record(z.string(), z.number().int()),
  }).strict(),

  z.object({
    type: z.literal('frontier_settled'),
    turn: z.number().int(),
    regionId: z.string(),
    factionId: z.string(),
    natives: z.number().int(),
    manpower: z.number().int(),
    lootGold: z.number().int(),
    goldCost: z.number().int(),
    foodCost: z.number().int(),
    infrastructure: z.number().int(),
  }).strict(),

  z.object({
    type: z.literal('turn_recap'),
    turn: z.number().int(),
    /** 每回合各方势力的变化，供结算复盘（公开信息，不含隐藏国库精确值） */
    factions: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        regionsBefore: z.number().int(),
        regionsAfter: z.number().int(),
        regionsDelta: z.number().int(),
        goldDelta: z.number(),
        foodDelta: z.number(),
        moraleDelta: z.number(),
        troopsBefore: z.number().int(),
        troopsAfter: z.number().int(),
        eliminated: z.boolean(),
      }).strict(),
    ),
  }).strict(),

  z.object({
    type: z.literal('turn_resolved'),
    turn: z.number().int(),
    /** ★确定性基线结果，先于叙事到达（P11：状态先定、叙事后到） */
    deltas: z.array(z.custom<ResourceDelta>()),
    clamps: z.array(z.custom<ClampRecord>()),
    /** 本回合是否有 LLM delta 参与；false = 纯确定性回合 */
    llmApplied: z.boolean(),
    stateId: z.string(),
  }).strict(),

  z.object({
    type: z.literal('combat_resolved'),
    turn: z.number().int(),
    regionId: z.string(),
    /** ★完整掷骰证据 */
    evidence: z.custom<CombatExecution>(),
  }).strict(),

  z.object({
    type: z.literal('region_captured'),
    turn: z.number().int(),
    regionId: z.string(),
    from: z.string().nullable(),
    to: z.string(),
    reason: z.enum(['force_ratio', 'morale_collapse']),
  }).strict(),

  z.object({
    type: z.literal('units_moved'),
    turn: z.number().int(),
    unitId: z.string(),
    from: z.string(),
    to: z.string(),
    path: z.array(z.string()),
    movementSpent: z.number(),
  }).strict(),

  z.object({
    type: z.literal('units_split'),
    turn: z.number().int(),
    factionId: z.string(),
    unitId: z.string(),
    newUnitId: z.string(),
    regionId: z.string(),
    count: z.number().int(),
    remaining: z.number().int(),
  }).strict(),

  z.object({
    type: z.literal('units_merged'),
    turn: z.number().int(),
    factionId: z.string(),
    fromUnitId: z.string(),
    intoUnitId: z.string(),
    regionId: z.string(),
    count: z.number().int(),
    total: z.number().int(),
  }).strict(),

  z.object({
    type: z.literal('recruitment_completed'),
    turn: z.number().int(),
    regionId: z.string(),
    factionId: z.string(),
    unitType: z.string(),
    count: z.number().int(),
  }).strict(),

  z.object({
    type: z.literal('development_completed'),
    turn: z.number().int(),
    regionId: z.string(),
    fromLevel: z.number().int(),
    toLevel: z.number().int(),
    goldSpent: z.number(),
  }).strict(),

  z.object({
    type: z.literal('infrastructure_completed'),
    turn: z.number().int(),
    regionId: z.string(),
    factionId: z.string(),
    fromLevel: z.number().int(),
    toLevel: z.number().int(),
    goldSpent: z.number(),
    /** 建成时立即降低的本区动乱 */
    unrestRelief: z.number(),
    /** 建成时立即提升的全国民心 */
    moraleGained: z.number(),
  }).strict(),

  z.object({
    type: z.literal('spy_reported'),
    turn: z.number().int(),
    regionId: z.string(),
    factionId: z.string(),
    targetOwner: z.string().nullable(),
    /** 情报有效到这一回合（含） */
    expiresTurn: z.number().int(),
    goldSpent: z.number(),
  }).strict(),

  z.object({
    type: z.literal('morale_changed'),
    turn: z.number().int(),
    factionId: z.string(),
    from: z.number(),
    to: z.number(),
    reason: z.string(),
  }).strict(),

  z.object({
    type: z.literal('unrest_event'),
    turn: z.number().int(),
    regionId: z.string(),
    severity: z.enum(['minor', 'major', 'revolt']),
    description: z.string(),
  }).strict(),

  /** 外交文书投递。publicity 决定它被投影给谁 */
  z.object({
    type: z.literal('message_delivered'),
    turn: z.number().int(),
    messageId: z.string(),
    from: z.string(),
    to: z.string().nullable(),
    publicity: z.enum(['public', 'non-public']),
    requireResponse: z.boolean(),
    body: z.string(),
  }).strict(),

  z.object({
    type: z.literal('diplomacy_changed'),
    turn: z.number().int(),
    a: z.string(),
    b: z.string(),
    from: z.string(),
    to: z.string(),
    /** 密约变更只投影给缔约双方 */
    publicity: z.enum(['public', 'non-public']),
  }).strict(),

  /** 奴隶贸易成交（买方/卖方都可见；其他席位只看到公开？这里按 owner 只给双方） */
  z.object({
    type: z.literal('slaves_traded'),
    turn: z.number().int(),
    buyer: z.string(),
    seller: z.string(),
    fromRegion: z.string(),
    toRegion: z.string(),
    count: z.number().int(),
    gold: z.number(),
    buyerMoraleCost: z.number().int(),
    sellerMoraleCost: z.number().int(),
    title: z.string(),
    banditUnrestPerTurn: z.number().int(),
  }).strict(),

  /** 起义爆发：区域脱离原属国，当地人口化为起义民兵 */
  z.object({
    type: z.literal('rebellion_started'),
    turn: z.number().int(),
    regionId: z.string(),
    original: z.string(),
    cause: z.enum(['unrest', 'claimed_conscription']),
    rebelTroops: z.number().int(),
    claimedBy: z.string().optional(),
  }).strict(),

  /** 起义区被更高民心国家宣称归附 */
  z.object({
    type: z.literal('rebellion_claimed'),
    turn: z.number().int(),
    regionId: z.string(),
    claimant: z.string(),
    original: z.string(),
    garrison: z.number().int(),
    unrest: z.number().int(),
    conscriptionTurns: z.number().int(),
  }).strict(),

  /** 起义状态结束：动乱恢复到阈值以下，或被原属国重占 */
  z.object({
    type: z.literal('rebellion_ended'),
    turn: z.number().int(),
    regionId: z.string(),
    faction: z.string(),
    reason: z.enum(['unrest_recovered', 'reoccupied']),
  }).strict(),

  z.object({
    type: z.literal('faction_eliminated'),
    turn: z.number().int(),
    factionId: z.string(),
    reason: z.string(),
  }).strict(),

  /** AI 建议就绪（军师模式推给人类确认；独立国家模式仅留痕） */
  z.object({
    type: z.literal('advice_generated'),
    turn: z.number().int(),
    adviceId: z.string(),
    seatId: z.string(),
    autoCommit: z.boolean(),
    summary: z.string(),
    /** 可选的 AI 角色发言（纯展示，不是命令） */
    chat: z.string().optional(),
  }).strict(),

  z.object({
    type: z.literal('advice_resolved'),
    turn: z.number().int(),
    adviceId: z.string(),
    status: z.enum(['accepted', 'rejected', 'expired', 'budget_exceeded']),
    /** 被闸门剔除的条目数（逐条剔除而非整包拒绝，P3） */
    droppedCount: z.number().int(),
  }).strict(),

  /** 规则告警（P13：规则代码替 LLM 盯盘，含"该做没做"型） */
  z.object({
    type: z.literal('alerts_raised'),
    turn: z.number().int(),
    seatId: z.string(),
    alerts: z.array(z.object({
      id: z.string(),
      priority: z.number().int(),
      message: z.string(),
    }).strict()),
  }).strict(),

  /** 叙事流（P11：异步补发，失败不阻塞下一回合） */
  z.object({
    type: z.literal('narrative_chunk'),
    turn: z.number().int(),
    seatId: z.string(),
    seq: z.number().int(),
    text: z.string(),
    done: z.boolean(),
    /** 模板兜底时为 true，提示这是降级产物而非 LLM 生成 */
    degraded: z.boolean(),
  }).strict(),

  z.object({
    type: z.literal('match_ended'),
    turn: z.number().int(),
    winner: z.string().nullable(),
    reason: z.enum(['conquest', 'turn_limit', 'resignation', 'draw']),
    /** 多维评分（OpenRA-RL 教训：单一胜负定位不了失败模式） */
    scores: z.record(z.string(), z.record(z.string(), z.number())),
  }).strict(),
]);

export type DomainEvent = z.infer<typeof DomainEventSchema>;
export type DomainEventType = DomainEvent['type'];

/**
 * 事件的默认可见性。'all' = 广播给全部席位；'owner' = 只给当事方；
 * 'public-only' = 只在 publicity==='public' 时广播，否则只给缔约双方。
 * 投影层按此裁剪（aonw RecipientDisclosure：客户端永不拿到规范隐藏状态）。
 */
export const EVENT_VISIBILITY: Readonly<Record<DomainEventType, 'all' | 'owner' | 'public-only'>> =
  Object.freeze({
    turn_started: 'all',
    turn_recap: 'all',
    frontier_settled: 'all',
    turn_resolved: 'all',
    combat_resolved: 'all',
    region_captured: 'all',
    units_moved: 'owner',
    units_split: 'owner',
    units_merged: 'owner',
    recruitment_completed: 'owner',
    development_completed: 'owner',
    infrastructure_completed: 'owner',
    spy_reported: 'owner',
    morale_changed: 'owner',
    unrest_event: 'owner',
    message_delivered: 'owner',
    diplomacy_changed: 'public-only',
    slaves_traded: 'owner',
    rebellion_started: 'all',
    rebellion_claimed: 'all',
    rebellion_ended: 'all',
    faction_eliminated: 'all',
    advice_generated: 'owner',
    advice_resolved: 'owner',
    alerts_raised: 'owner',
    narrative_chunk: 'owner',
    match_ended: 'all',
  });

/** WS 推送信封：客户端据 offset 断线重连补发 */
export interface EventEnvelope {
  readonly offset: number;
  readonly turn: number;
  readonly event: DomainEvent;
  /** 投影后的接收者；'spectator' 拿全知视图 */
  readonly deliveredTo: SeatId | 'spectator';
}
