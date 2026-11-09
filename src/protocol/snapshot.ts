/**
 * 战场快照 DTO —— 给酒馆前端**和**给 LLM 的是同一份结构。
 *
 * 统一的好处：LLM 看到的与人类看到的完全一致，不存在"AI 全知"的作弊面
 * （aonw：AI 只看得见 recipient-safe 视图，和人类同样的信息边界）。
 *
 * ★压缩四层（P13，来自 OpenArma 的三层精度 AO 简报 + OpenRA-RL 的 TURN BRIEFING）：
 *   静态层：区域地形评级 + 一句话战术描述（开局算一次，长期缓存）
 *   动态层：部队按建制聚合、敌情 top-N 截断、与上回合 diff 出告警
 *   告警层：规则代码替 LLM 盯盘（含"该做没做"型）
 *   历史层：滑窗 + 摘要
 *
 * ★给 LLM 的数值一律是**分层标签 / 指数**，不是精确值
 *   （Histrategy state-complexity 文档的结论：离散 > 连续，LLM 调参数、代码算结果）。
 */
import { z } from 'zod';

/**
 * 发展度/兵力/金粮的**分层标签取值清单在 `src/core/labels.ts`**（单一真源）。
 * 这里只声明字段是 string —— protocol 不持有取值清单，避免 protocol→core 的反向依赖，
 * 也避免两处清单日久漂移。
 */
export const ArmyTierSchema = z.enum(['none', 'token', 'garrison', 'field_army', 'grand_army']);

export const ProjectedRegionSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    owner: z.string().nullable(),
    ownerName: z.string().nullable(),
    /** 可见性：full=完全掌握, partial=知道归属与大致兵力, name_only=只知道名字与归属, unknown=完全未知 */
    visibility: z.enum(['full', 'partial', 'name_only', 'unknown']),
    terrain: z.string().optional(),
    /** 分层标签，不是精确等级 */
    developmentLabel: z.string().optional(),
    /** 本区人口（full 可见时下发；baseManpower × 发展度系数） */
    population: z.number().int().min(0).optional(),
    /** 本区非军队人口 = 本区人口 − 本区驻军；用于展示与 frontier 地方产出 */
    civilianPopulation: z.number().int().min(0).optional(),
    /** 本区粮/金产出的平民劳动系数；仅启用 frontier 平民产出惩罚时下发 */
    civilianOutputFactor: z.number().min(0).max(1).optional(),
    fortLevel: z.number().int().optional(),
    /** 地区基建等级（0 = 未建）；只对 fully-visible 区域下发 */
    infrastructure: z.number().int().min(0).max(4).optional(),
    /** 地区动乱（0-100）；只对 fully-visible 区域下发 */
    unrest: z.number().int().optional(),
    /** 起义/归附状态：从 partial 可见起下发（归属与叛乱是公开信息） */
    rebellion: z
      .object({
        original: z.string(),
        originalName: z.string().optional(),
        claimedBy: z.string().optional(),
        claimedByName: z.string().optional(),
        claimedTurn: z.number().int().optional(),
        rebelTroops: z.number().int(),
        /** 归附后多少回合内征兵会再次起义（方便 UI 显示窗口） */
        conscriptionTurns: z.number().int().optional(),
      })
      .strict()
      .optional(),
    /** 开荒地块：未占领且剧本启用 frontier 时下发 */
    frontier: z
      .object({
        natives: z.number().int(),
        requiredTroops: z.number().int(),
        lootGold: z.number().int(),
        goldCost: z.number().int(),
        foodCost: z.number().int(),
        infrastructure: z.number().int(),
      })
      .strict()
      .optional(),
    /** 己方与已侦察的敌方部队，按建制聚合 */
    stacks: z
      .array(
        z
          .object({
            ownerId: z.string(),
            typeName: z.string(),
            troops: z.number().int(),
            /** 指数化战力档位 */
            tier: ArmyTierSchema,
            /** 特殊头衔：奴隶贸易的「贼配军」、起义/守城民兵 */
            title: z.enum(['bandit_conscript', 'rebel_militia', 'rebel_garrison']).optional(),
            /** 情报陈旧度：多少回合前看到的（0 = 本回合） */
            seenTurnsAgo: z.number().int(),
          })
          .strict(),
      )
      .optional(),
    adjacency: z.array(z.string()).optional(),
    /** 一句话战术描述（静态层，预计算） */
    tacticalNote: z.string().optional(),
  })
  .strict();

export const AI_ARCHETYPES = ['rush', 'turtle', 'random'] as const;
export type AiArchetype = (typeof AI_ARCHETYPES)[number];
export const AiArchetypeSchema = z.enum(AI_ARCHETYPES);

export const ProjectedFactionSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    isSelf: z.boolean(),
    relation: z.enum(['war', 'alliance', 'truce', 'peace', 'neutral', 'self']),
    /** 与观看者之间的潜在恨意（0-100）；自己/无 grudge 剧本不填 */
    grudge: z.number().int().min(0).max(100).optional(),
    /** 双方历史宣战次数（0 = 从未开战） */
    wars: z.number().int().min(0).optional(),
    /** 与观看者之间的贸易政策（交战/恨意 ≥70 为 embargo） */
    tradePolicy: z.enum(['free', 'restricted', 'embargo']).optional(),
    regionCount: z.number().int(),
    /** ★指数化，不给精确国库数字（防 LLM 算术幻觉） */
    goldTier: z.enum(['bankrupt', 'poor', 'moderate', 'rich', 'overflowing']),
    foodTier: z.enum(['starving', 'low', 'adequate', 'surplus', 'abundant']),
    /** 全国民心（0-100）。★全国性，不是地区平均 */
    morale: z.number().int(),
    /** 全国民心换算出的战斗战力乘数 = 0.5 + morale / coefficient */
    moraleFactor: z.number().finite().optional(),
    armyTier: ArmyTierSchema,
    eliminated: z.boolean(),
    capital: z.string().optional(),
    /** AI 席位原型；人类席位/本席位不填 */
    aiArchetype: AiArchetypeSchema.optional(),
    /** 只给自己看 */
    exact: z
      .object({
        gold: z.number(),
        food: z.number(),
        manpower: z.number(),
        troops: z.number().int(),
        taxRate: z.number(),
        /** 当前税率对全国民心的每回合影响（正=回民，负=伤民；0=中性） */
        taxMoralePerTurn: z.number().int().optional(),
        laws: z.array(z.string()),
      })
      .strict()
      .optional(),
  })
  .strict();

export const AlertSchema = z
  .object({
    id: z.string(),
    priority: z.number().int(),
    message: z.string(),
  })
  .strict();

/** 引擎生成的自我复盘：AI 与外部 Agent 都读这份，不靠模型自己臆想 */
export const SelfReviewSchema = z
  .object({
    turn: z.number().int(),
    /** AI 原型（人类席位不填） */
    archetype: AiArchetypeSchema.optional(),
    /** 原型奖励：疾攻看早期夺地，守成看存活/经济/防守 */
    reward: z.number().finite().optional(),
    metrics: z
      .object({
        regionsGained: z.number().int(),
        regionsLost: z.number().int(),
        battles: z.number().int(),
        attacksWon: z.number().int(),
        attacksLost: z.number().int(),
        rejectedCommands: z.number().int(),
        goldDelta: z.number(),
        foodDelta: z.number(),
        moraleDelta: z.number(),
      })
      .strict(),
    lessons: z.array(z.string()),
    policy: z
      .object({
        attackRatio: z.number(),
        defenseBias: z.number(),
        infraBias: z.number(),
        spyBias: z.number(),
        taxTarget: z.number(),
        lawBias: z.number(),
        maxCommands: z.number().int(),
      })
      .strict()
      .nullable(),
  })
  .strict();

/**
 * 完整快照。
 *
 * `mapText` 借鉴 OpenRA-RL 的 ASCII 小地图思路，但改为**拓扑式**而非坐标网格：
 * 国战的战略意义在邻接关系（谁能打谁、哪里是咽喉），不在像素距离。
 * 拓扑文本比 JSON 坐标省一个数量级 token，且对 LLM 更有用。
 * 网页面板要画地图时用 config 里另配的 x/y，与本字段无关。
 */
export const SnapshotSchema = z
  .object({
    recipient: z.string(),
    turn: z.number().int(),
    phase: z.string(),
    /** 终局时的胜者与原因；未结束为 null。UI 用它显示明确结果，而不是猜 phase */
    winner: z.string().nullable().optional(),
    endReason: z.string().nullable().optional(),
    /** ★CAS：客户端提交命令时必须回带 */
    stateId: z.string(),
    regions: z.array(ProjectedRegionSchema),
    factions: z.array(ProjectedFactionSchema),
    alerts: z.array(AlertSchema),
    /** 合法动作空间 —— LLM 的建议必须引用这里的 id（P10 锚定） */
    legalActions: z.array(
      z
        .object({
          id: z.string(),
          kind: z.string(),
          label: z.string(),
          estimate: z.record(z.string(), z.union([z.number(), z.string()])).optional(),
        })
        .strict(),
    ),
    mapText: z.string(),
    /** token 预算余量，让 LLM 自己也知道该省着说 */
    budget: z.object({ tokenUsed: z.number().int(), tokenCap: z.number().int() }).strict(),
    /** 引擎生成的自我复盘；只给本席位（敌方拿不到） */
    selfReview: SelfReviewSchema.optional(),
    /** 与上一回合的差异（动态层压缩：只讲变化，不复述全部） */
    sinceLastTurn: z
      .object({
        captured: z.array(z.string()),
        lost: z.array(z.string()),
        battles: z.number().int(),
        newAlerts: z.array(z.string()),
      })
      .strict()
      .optional(),
  })
  .strict();

export type Snapshot = z.infer<typeof SnapshotSchema>;
export type ProjectedRegion = z.infer<typeof ProjectedRegionSchema>;
export type ProjectedFaction = z.infer<typeof ProjectedFactionSchema>;
export type Alert = z.infer<typeof AlertSchema>;
export type SelfReview = z.infer<typeof SelfReviewSchema>;
export type AiPolicy = NonNullable<SelfReview['policy']>;
export type ArmyTier = z.infer<typeof ArmyTierSchema>;
