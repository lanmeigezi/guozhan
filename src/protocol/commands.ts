/**
 * 命令协议 —— P5 四分法（aonw ADR 0003）。
 *
 *   DomainCommand  玩家/AI 提交的权威命令，引擎接受的**唯一**客户端来源输入
 *   SystemCommand  受信确定性转移（超时、强制结算），永不暴露给玩家端点
 *   DomainEvent    已接受的事实（见 events.ts）
 *   GameIntent     表现层输入，**永不持久化、永不进核心** —— 只存在于酒馆扩展内部，
 *                  因此这里刻意不定义它：核心看不见它，就无法误用它。
 *
 * AI 与人类走完全相同的 DomainCommand 通道（P9），没有后门。
 */
import { z } from 'zod';

export type RegionId = string;
export type FactionId = string;
export type UnitId = string;
export type SeatId = string;
export type MessageId = string;
export type AdviceId = string;

/** id 一律限定字符集，防路径穿越与注入（它们会进 SQLite 与文件名） */
const idSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'id 只允许小写字母、数字、下划线、连字符');

export const RegionIdSchema = idSchema.brand<'RegionId'>();
export const FactionIdSchema = idSchema.brand<'FactionId'>();
export const UnitIdSchema = idSchema.brand<'UnitId'>();
export const SeatIdSchema = idSchema.brand<'SeatId'>();

/** 正整数（部队数量等），显式上限防 LLM 产出天文数字 */
const countSchema = z.number().int().min(1).max(1_000_000);

// ─────────────────────────────────────────────────────────────
// DomainCommand —— 判别联合，kind 是判别字段
// ─────────────────────────────────────────────────────────────

export const MoveUnitsCommandSchema = z
  .object({
    kind: z.literal('move_units'),
    unitId: UnitIdSchema,
    toRegion: RegionIdSchema,
  })
  .strict();

export const AttackCommandSchema = z
  .object({
    kind: z.literal('attack'),
    unitId: UnitIdSchema,
    targetRegion: RegionIdSchema,
    /** 先移动到该区域再进攻（移动力仍受兵种与地形限制） */
    moveTo: RegionIdSchema.optional(),
    /** 投入比例 0.1-1.0；缺省视为全部投入 */
    commitment: z.number().min(0.1).max(1).optional(),
  })
  .strict();

export const RecruitCommandSchema = z
  .object({
    kind: z.literal('recruit'),
    regionId: RegionIdSchema,
    unitType: z.string().min(1).max(32),
    count: countSchema,
  })
  .strict();

export const DisbandCommandSchema = z
  .object({
    kind: z.literal('disband'),
    unitId: UnitIdSchema,
    count: countSchema,
  })
  .strict();

/** 分兵：从 unitId 分出 count 兵，生成一支同区同兵种的新部队 */
export const SplitUnitCommandSchema = z
  .object({
    kind: z.literal('split_unit'),
    unitId: UnitIdSchema,
    count: countSchema,
  })
  .strict();

/** 合兵：把 unitId 的兵力并入 targetUnitId（同区、同兵种） */
export const MergeUnitsCommandSchema = z
  .object({
    kind: z.literal('merge_units'),
    unitId: UnitIdSchema,
    targetUnitId: UnitIdSchema,
  })
  .strict();

export const SetTaxCommandSchema = z
  .object({
    kind: z.literal('set_tax'),
    /** 实际范围由 config/rules/economy.yaml 的 tax.min_rate/max_rate 校验，
     *  这里只挡物理上不可能的值 */
    rate: z.number().min(0).max(1),
  })
  .strict();

export const SetLawCommandSchema = z
  .object({
    kind: z.literal('set_law'),
    lawId: z.string().min(1).max(32),
    enabled: z.boolean(),
  })
  .strict();

export const DevelopCommandSchema = z
  .object({
    kind: z.literal('develop'),
    regionId: RegionIdSchema,
  })
  .strict();

export const FortifyCommandSchema = z
  .object({
    kind: z.literal('fortify'),
    regionId: RegionIdSchema,
    /** 目标等级，必须 = 当前 +1（不可跳级） */
    toLevel: z.number().int().min(1).max(3),
  })
  .strict();

/** 地区基建：等级由引擎按当前等级 +1 推导，客户端不提交目标等级（少一条伪造面） */
export const BuildInfrastructureCommandSchema = z
  .object({
    kind: z.literal('build_infrastructure'),
    regionId: RegionIdSchema,
  })
  .strict();

/** 派间谍侦察一个区域：花费金，换取数回合的 exact 视图 */
export const SendSpyCommandSchema = z
  .object({
    kind: z.literal('send_spy'),
    regionId: RegionIdSchema,
  })
  .strict();

/**
 * 奴隶贸易（鬻奴令）：从相邻的卖方地块买入人口，编为最低级「贼配军」。
 * 买方必须已颁布对应国策；卖方无需同法，但必须非交战且未因恨意禁运。
 */
export const TradeSlavesCommandSchema = z
  .object({
    kind: z.literal('trade_slaves'),
    fromFaction: FactionIdSchema,
    fromRegion: RegionIdSchema,
    toRegion: RegionIdSchema,
    count: countSchema,
  })
  .strict();

/** 宣称一个尚未归附的起义区：民心高于原属国且满足相邻条件时自动归附 */
export const ClaimRebellionCommandSchema = z
  .object({
    kind: z.literal('claim_rebellion'),
    regionId: RegionIdSchema,
  })
  .strict();

/** 开荒：在已有本方部队的空白地块完成基建 Lv1 并占领 */
export const SettleRegionCommandSchema = z
  .object({
    kind: z.literal('settle_region'),
    regionId: RegionIdSchema,
  })
  .strict();

/** 外交文书。publicity 决定广播范围（WarAgent schema） */
export const SendMessageCommandSchema = z
  .object({
    kind: z.literal('send_message'),
    to: FactionIdSchema.nullable(), // null = 广播
    publicity: z.enum(['public', 'non-public']),
    requireResponse: z.boolean().default(false),
    body: z.string().min(1).max(2000),
  })
  .strict();

export const DiplomacyCommandSchema = z
  .object({
    kind: z.literal('diplomacy'),
    to: FactionIdSchema,
    action: z.enum([
      'propose_alliance',
      'accept_alliance',
      'reject_alliance',
      'propose_peace',
      'accept_peace',
      'reject_peace',
      'declare_war',
      'break_alliance',
    ]),
    /** 关联的文书 id（accept/reject 类必填，由核心校验） */
    inReplyTo: z.string().min(1).max(64).optional(),
  })
  .strict();

/** 锁定提交与采纳建议都**不是**命令 kind：它们各有专用端点（/lock、/advice/:id/adopt）。
 *  做成命令会多出一条在结算时被当未知命令丢弃的歧路。 */

export const DomainCommandSchema = z.discriminatedUnion('kind', [
  MoveUnitsCommandSchema,
  AttackCommandSchema,
  RecruitCommandSchema,
  DisbandCommandSchema,
  SplitUnitCommandSchema,
  MergeUnitsCommandSchema,
  SetTaxCommandSchema,
  SetLawCommandSchema,
  DevelopCommandSchema,
  FortifyCommandSchema,
  BuildInfrastructureCommandSchema,
  SendSpyCommandSchema,
  TradeSlavesCommandSchema,
  ClaimRebellionCommandSchema,
  SettleRegionCommandSchema,
  SendMessageCommandSchema,
  DiplomacyCommandSchema,
]);

export type DomainCommand = z.infer<typeof DomainCommandSchema>;
export type CommandKind = DomainCommand['kind'];

export const ALL_COMMAND_KINDS: readonly CommandKind[] = Object.freeze(
  DomainCommandSchema.options.map((o) => o.shape.kind.value),
);

// ─────────────────────────────────────────────────────────────
// 写命令信封 —— P8 三件套（CAS + 幂等 + 逐步提交不回滚）
// ─────────────────────────────────────────────────────────────

export const CommandEnvelopeSchema = z
  .object({
    /** = 客户端最近一次读到的 state_digest。不符 → STALE_REVISION(409) */
    stateId: z.string().min(8).max(128),
    /** 幂等键。同 id 同参 → 返回原回执 replayed:true；同 id 异参 → 409 */
    requestId: z.string().min(1).max(128),
    /** 1-8 步。逐步提交，失败即停，**已提交步骤不回滚** */
    commands: z.array(DomainCommandSchema).min(1).max(8),
  })
  .strict();

export type CommandEnvelope = z.infer<typeof CommandEnvelopeSchema>;

// ─────────────────────────────────────────────────────────────
// SystemCommand —— 受信转移，永不暴露给玩家端点
// ─────────────────────────────────────────────────────────────

export const SystemCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('resolve_turn') }).strict(),
  z.object({ kind: z.literal('timeout_lock'), seatId: SeatIdSchema }).strict(),
  z.object({ kind: z.literal('force_eliminate'), factionId: FactionIdSchema }).strict(),
  /** 房间 token 预算耗尽 → 本回合禁用 LLM 层，纯确定性结算 */
  z.object({ kind: z.literal('degrade_to_deterministic') }).strict(),
]);

export type SystemCommand = z.infer<typeof SystemCommandSchema>;

// ─────────────────────────────────────────────────────────────
// 提交结果
// ─────────────────────────────────────────────────────────────

export interface CommandStepResult {
  readonly index: number;
  readonly ok: boolean;
  readonly code?: string;
  readonly message?: string;
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
}

export interface CommandResult {
  /** completed=全部成功；partial=前 N 步成功后续失败；failed=第 0 步就失败 */
  readonly status: 'completed' | 'partial' | 'failed';
  readonly completedSteps: number;
  readonly steps: readonly CommandStepResult[];
  /** 幂等命中时为 true：本次未执行，返回的是上次的结果 */
  readonly replayed: boolean;
  /** 执行后的新 state_digest，客户端下次提交必须带上 */
  readonly stateId: string;
  readonly turn: number;
}
