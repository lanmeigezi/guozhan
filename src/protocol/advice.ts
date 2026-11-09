/**
 * AI 建议协议 —— P10「LLM 建议锚定在合法动作空间上」。
 *
 * 设计依据：
 *   · CICERO：走子命令永远不来自语言模型，LLM 只产文本且以规划器 pseudo_orders 为锚
 *   · WarAgent：动作 schema 带 publicity / require_response，配纯代码校验 + 带原因重试
 *   · Histrategy：LLM 输出只作"提示"，最终数值由代码裁决并钳制在 [0.5×,1.5×]
 *
 * ★核心约束：LLM 只能引用引擎在 LegalAction 里给出的 id。
 *   引用任何不在清单里的 region/unit/faction ⇒ 闸门 ① 直接剔除该条（逐条剔除，不整包拒绝）。
 */
import { z } from 'zod';
import { DomainCommandSchema } from './commands.ts';

/**
 * 引擎给出的合法动作空间。这份清单随快照一起发给 LLM，
 * LLM 的建议必须从这里选 —— 这就是"锚定"。
 */
export const LegalActionSchema = z
  .object({
    /** 稳定 id，LLM 引用它；形如 'attack:u_qin_1:r_handan' */
    id: z.string().min(1).max(128),
    kind: z.enum([
      'move_units',
      'attack',
      'recruit',
      'disband',
      'set_tax',
      'set_law',
      'develop',
      'fortify',
      'send_message',
      'diplomacy',
    ]),
    /** 人类可读的一句话，进 LLM 上下文 */
    label: z.string().max(200),
    /** 该动作对应的 DomainCommand，采纳时原样提交（LLM 不改它） */
    command: DomainCommandSchema,
    /** 代码预算出的数值参考 —— ★LLM 只消费结果，绝不自己算 */
    estimate: z
      .object({
        goldCost: z.number().optional(),
        foodCost: z.number().optional(),
        movementCost: z.number().optional(),
        /** 攻方有效战力 / 守方有效战力，>1 表示优势 */
        powerRatio: z.number().optional(),
        expectedTurns: z.number().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type LegalAction = z.infer<typeof LegalActionSchema>;

/**
 * LLM 必须产出的结构。
 *
 * ★刻意不含任何"数值"字段 —— LLM 不能说"伤亡 3000"或"粮食 +500"。
 *   它只能：①引用 legalActionId ②给自然语言理由 ③给外交文本 ④给软性数值提示（trend）。
 *   Histrategy 的 state-complexity 文档结论：给 LLM 看分层标签、收 delta，绝对值代码算。
 */
export const AdviceOutputSchema = z
  .object({
    /** 战略判断，≤300 字，进酒馆显示 */
    assessment: z.string().max(600),
    /**
     * 建议采纳的动作，按优先级排序。★只能引用 legalActions 里的 id。
     *
     * 这里的 .max() 是**传输层防爆上限**，刻意远大于业务上限（GateLimits.maxAcceptedActions）。
     * 原因：若 schema 直接卡业务上限，超限会**整包 reject**，违反 P3「逐条剔除而非整包拒绝」
     * ——Histrategy GuardrailValidator 的核心纪律。真正的截断由闸门②逐条执行并留痕。
     */
    recommended: z
      .array(
        z
          .object({
            legalActionId: z.string().min(1).max(128),
            priority: z.number().int().min(1).max(10),
            /** 为什么建议这么做 —— 会显示给人类玩家 */
            rationale: z.string().max(400),
            /** 风险自评（低/中/高），仅用于 UI 着色，不参与结算 */
            risk: z.enum(['low', 'medium', 'high']).optional(),
          })
          .strict(),
      )
      .max(24),
    /** 外交文本（可选）。publicity 决定广播范围 */
    diplomacy: z
      .array(
        z
          .object({
            to: z.string().min(1).max(64),
            publicity: z.enum(['public', 'non-public']),
            body: z.string().min(1).max(800),
            /** ★文本不得承诺任何数值。闸门会扫描并标记违规 */
            intent: z.enum(['alliance', 'peace', 'warning', 'deception', 'trade']).optional(),
          })
          .strict(),
      )
      .max(12)
      .optional(),
    /**
     * 软性趋势提示 —— LLM 唯一被允许"碰数值"的地方，且只是提示。
     * 最终变化量由代码裁决并钳在 [0.5×,1.5×] 确定值（P2）。
     */
    moraleHints: z
      .array(
        z
          .object({
            factionId: z.string().min(1).max(64),
            /** 只给方向与档位，不给绝对数 */
            direction: z.enum(['up', 'down', 'steady']),
            magnitude: z.enum(['slight', 'moderate', 'strong']),
            reason: z.string().max(200),
          })
          .strict(),
      )
      .max(8)
      .optional(),
    /** 可选的角色内发言：给酒馆/面板看的短句，不是命令；不参与结算 */
    chat: z.string().max(240).optional(),
    /** 跨回合记忆：达到权重阈值才质变（Histrategy EpochMemory） */
    persistentNote: z.string().max(300).optional(),
  })
  .strict();

export type AdviceOutput = z.infer<typeof AdviceOutputSchema>;

/** 闸门①②的剔除留痕 —— 逐条剔除而非整包拒绝（P3），且必须可审计 */
export interface AdviceViolation {
  /** 'recommended[2]' / 'diplomacy[0].body' 这样的定位串 */
  readonly path: string;
  readonly rule: string;
  readonly severity: 'hard' | 'soft';
  /** hard = 剔除该条；soft = 钳制后保留 */
  readonly action: 'dropped' | 'clamped' | 'warned';
  readonly detail: string;
}

/** 落库到 ai_advice 表的完整记录 */
export interface AdviceRecord {
  readonly id: string;
  readonly turn: number;
  readonly seatId: string;
  /** 基于哪个快照生成；state_digest 变了即失效（防"用旧局面的建议改新局"） */
  readonly snapshotDigest: string;
  readonly output: AdviceOutput;
  /** 通过闸门的动作（已解析成可提交的 DomainCommand） */
  readonly commands: ReadonlyArray<{ legalActionId: string; command: unknown }>;
  readonly violations: readonly AdviceViolation[];
  readonly status: 'pending' | 'accepted' | 'rejected' | 'expired' | 'budget_exceeded';
  readonly model: string;
  readonly tokenUsage: { prompt: number; completion: number; total: number };
  readonly latencyMs: number;
  readonly createdAt: number;
}
