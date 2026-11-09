/**
 * 地图布局 DTO —— 纯展示层，**不参与规则裁决，也不进 LLM 提示词**。
 *
 * 两种棋盘：
 *   · hex    —— 六角格（warring-states / aria）
 *   · square —— 连续方块棋盘（iron-front：军棋式板块 + 大河 + 桥 + 水路）
 *
 * 为什么单独一个端点而不是塞进 Snapshot：
 *   · Snapshot 同时喂给 LLM，坐标会白烧 token（P13 的四层压缩刻意只留拓扑文本）；
 *   · 布局是静态的，客户端连上拉一次即可，不必每回合重发；
 *   · 区域名/归属/兵力仍以按接收者投影的 Snapshot 为准，布局只给"画在哪"。
 *
 * 颜色与首都是剧本静态数据（factions.json）；水路/港口是地图静态数据，
 * 不含任何随回合变化的隐藏信息。归属与兵力永远不在本 DTO 里。
 */
import { z } from 'zod';

const CanvasSchema = z
  .object({
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
  })
  .strict();

const HexRegionFileSchema = z
  .object({
    id: z.string().min(1),
    x: z.number().finite(),
    y: z.number().finite(),
  })
  .strict();

const SquareRegionFileSchema = z
  .object({
    id: z.string().min(1),
    col: z.number().int().min(0),
    row: z.number().int().min(0),
  })
  .strict();

export const HexLayoutFileSchema = z
  .object({
    /** 旧布局文件没有 kind；默认 hex，解析结果始终带 kind 便于判别 */
    kind: z.literal('hex').default('hex'),
    canvas: CanvasSchema,
    /** 六角格外接圆半径（px） */
    hexSize: z.number().finite().positive(),
    regions: z.array(HexRegionFileSchema).min(1),
  })
  .strict();

export const SquareLayoutFileSchema = z
  .object({
    kind: z.literal('square'),
    canvas: CanvasSchema,
    tile: z
      .object({
        width: z.number().finite().positive(),
        height: z.number().finite().positive(),
        gap: z.number().finite().min(0).optional(),
      })
      .strict(),
    grid: z
      .object({
        originX: z.number().finite(),
        originY: z.number().finite(),
        cols: z.number().int().positive(),
        rows: z.number().int().positive(),
        /** 河面在两排之间额外增加的垂直间距（px） */
        riverGap: z.number().finite().min(0).optional(),
      })
      .strict(),
    river: z
      .object({
        betweenRows: z.tuple([z.number().int().min(0), z.number().int().min(0)]),
        /** 0-based 列号；桥是陆军可以正常通过的普通邻接 */
        bridges: z.array(z.number().int().min(0)),
        label: z.string().optional(),
      })
      .strict()
      .optional(),
    regions: z.array(SquareRegionFileSchema).min(1),
  })
  .strict();

export const HexBoardLayoutFileSchema = z
  .object({
    kind: z.literal('hexboard'),
    canvas: CanvasSchema,
    /** 六角格外接圆半径；连续格子中心距由装载器按 pointy-top 几何计算 */
    hexSize: z.number().finite().positive(),
    grid: z
      .object({
        originX: z.number().finite(),
        originY: z.number().finite(),
        cols: z.number().int().positive(),
        rows: z.number().int().positive(),
        /** 水域排（0-based）；这些排整排生成蓝色水格，不承载规则区域 */
        waterRows: z.array(z.number().int().min(0)).min(1),
      })
      .strict(),
    river: z.object({ label: z.string().optional() }).strict().optional(),
    regions: z.array(SquareRegionFileSchema).min(1),
  })
  .strict();

export const MapLayoutFileSchema = z.union([
  HexLayoutFileSchema,
  SquareLayoutFileSchema,
  HexBoardLayoutFileSchema,
]);

export const MapLayoutRegionSchema = z
  .object({
    id: z.string().min(1),
    x: z.number().finite(),
    y: z.number().finite(),
    col: z.number().int().min(0).optional(),
    row: z.number().int().min(0).optional(),
  })
  .strict();

/** 地形图鉴：经济倾向、情报难度、行军/守备修正（纯展示，不进 contentHash） */
export const TerrainHelpSchema = z
  .object({
    id: z.string().min(1),
    food: z.number().finite(),
    gold: z.number().finite(),
    popGrowth: z.number().finite(),
    intelCost: z.number().finite(),
    infantryDefense: z.number().finite(),
    moveCost: z.number().finite(),
    defenderBonus: z.number().finite(),
  })
  .strict();

export const WaterRouteSchema = z
  .object({
    a: z.string().min(1),
    b: z.string().min(1),
    cost: z.number().int().positive(),
  })
  .strict();

/** 兵种图鉴（纯展示；数值仍是 core 的同一份 WorldConfig） */
export const UnitTypeHelpSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    attack: z.number().finite(),
    defense: z.number().finite(),
    movement: z.number().finite(),
    domain: z.enum(['land', 'water', 'amphibious']),
    recruitGold: z.number().finite(),
    recruitFood: z.number().finite(),
    recruitManpower: z.number().finite(),
    upkeepGold: z.number().finite(),
    upkeepFood: z.number().finite(),
    /** 被克制兵种 → 额外战力比例（0.5 = +50%） */
    counters: z.record(z.string(), z.number().finite()),
  })
  .strict();

/** 法令图鉴（纯帮助信息，不参与规则；layout 端点一次下发，供 UI 解释政令） */
export const LawHelpSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string(),
    effects: z.record(z.string(), z.number().finite()),
    enactGold: z.number().finite(),
  })
  .strict();

/** 民心/动乱/基建的解释信息 —— 只给 UI 显示，不参与裁决 */
export const MoraleHelpSchema = z
  .object({
    coefficient: z.number().finite().positive(),
    collapseThreshold: z.number().finite(),
    capturePowerRatio: z.number().finite(),
    min: z.number().finite(),
    max: z.number().finite(),
    regenPerTurn: z.number().finite(),
  })
  .strict();

export const LowMoraleHelpSchema = z
  .object({
    threshold: z.number().finite().positive(),
    maxUnrestBonus: z.number().finite().min(0),
    recruitBase: z.number().finite().min(0),
    battleBase: z.number().finite().min(0),
    captureBase: z.number().finite().min(0),
    warDeclarationBase: z.number().finite().min(0),
  })
  .strict();

export const InfrastructureLevelHelpSchema = z
  .object({
    level: z.number().int().min(1),
    name: z.string().min(1),
    costGold: z.number().finite().min(0),
    unrestRelief: z.number().finite().min(0),
    unrestReductionPerTurn: z.number().finite().min(0),
    moralePoints: z.number().finite().min(0),
    populationGrowthBonus: z.number().finite().min(0),
  })
  .strict();

export const InfrastructureHelpSchema = z
  .object({
    maxLevel: z.number().int().min(1),
    levels: z.array(InfrastructureLevelHelpSchema),
    moralePointsPerTurnPoint: z.number().finite().positive(),
    moraleOnBuild: z.number().finite().min(0),
  })
  .strict();

export const UnrestEffectsHelpSchema = z
  .object({
    outputPenaltyPerPoint: z.number().finite().min(0),
    defensePenaltyPerPoint: z.number().finite().min(0),
  })
  .strict();

export const RulesHelpSchema = z
  .object({
    morale: MoraleHelpSchema,
    lowMorale: LowMoraleHelpSchema.nullable(),
    infrastructure: InfrastructureHelpSchema.nullable(),
    unrestEffects: UnrestEffectsHelpSchema.nullable(),
  })
  .strict();

export const RiverSchema = z
  .object({
    top: z.number().finite(),
    bottom: z.number().finite(),
    left: z.number().finite(),
    right: z.number().finite(),
    label: z.string(),
    bridges: z.array(
      z
        .object({
          col: z.number().int().min(0),
          x: z.number().finite(),
          width: z.number().finite().positive(),
        })
        .strict(),
    ),
  })
  .strict();

export const MapLayoutSchema = z
  .object({
    kind: z.enum(['hex', 'square', 'hexboard']),
    canvas: CanvasSchema,
    /** hex 模式必填 */
    hexSize: z.number().finite().positive().optional(),
    /** square 模式必填（gap 已归一化） */
    tile: z
      .object({
        width: z.number().finite().positive(),
        height: z.number().finite().positive(),
        gap: z.number().finite().min(0),
      })
      .strict()
      .optional(),
    regions: z.array(MapLayoutRegionSchema),
    /** factionId → #rrggbb；只用于上色 */
    factionColors: z.record(z.string(), z.string().regex(/^#[0-9a-f]{6}$/)),
    /** factionId → 首都区域 id；只用于画星标 */
    capitals: z.record(z.string(), z.string()),
    /** 静态水路（水师专用），供前端画蓝色航道与判定移动路径是否涉水 */
    waterRoutes: z.array(WaterRouteSchema),
    /** 港口区域 id（水师可征募/停泊） */
    ports: z.array(z.string()),
    /** square 模式的大河视觉信息（像素坐标已归一化） */
    river: RiverSchema.optional(),
    /** hexboard 模式的蓝色水域格（纯视觉；不承载归属/部队） */
    waterCells: z
      .array(
        z
          .object({
            x: z.number().finite(),
            y: z.number().finite(),
            col: z.number().int().min(0),
            row: z.number().int().min(0),
          })
          .strict(),
      )
      .optional(),
    /** hexboard 模式的跨水域普通邻接（桥）：由装载器从跨水域普通邻接派生 */
    bridges: z
      .array(
        z
          .object({
            a: z.string().min(1),
            b: z.string().min(1),
          })
          .strict(),
      )
      .optional(),
    riverLabel: z.string().optional(),
    /** 法令图鉴（法令效果说明；不是游戏状态，不进 contentHash） */
    laws: z.array(LawHelpSchema).optional(),
    /** 兵种图鉴（攻防机动、成本、克制关系；纯展示，不进 contentHash） */
    units: z.array(UnitTypeHelpSchema).optional(),
    /** 地形图鉴（产出/人口/情报/行军/守备；同上纯展示） */
    terrain: z.array(TerrainHelpSchema).optional(),
    /** 民心/动乱/基建的解释信息（同上：纯展示，不进 contentHash） */
    rules: RulesHelpSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.kind === 'hex' || value.kind === 'hexboard') && value.hexSize === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'hex/hexboard 布局必须提供 hexSize' });
    }
    if (value.kind === 'square' && (value.tile === undefined || value.river === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'square 布局必须提供 tile 与 river' });
    }
    if (value.kind === 'hexboard' && value.waterCells === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'hexboard 布局必须提供 waterCells' });
    }
  });

export type HexLayoutFile = z.infer<typeof HexLayoutFileSchema>;
export type SquareLayoutFile = z.infer<typeof SquareLayoutFileSchema>;
export type HexBoardLayoutFile = z.infer<typeof HexBoardLayoutFileSchema>;
export type MapLayoutFile = z.infer<typeof MapLayoutFileSchema>;
export type MapLayoutRegion = z.infer<typeof MapLayoutRegionSchema>;
export type MapLayoutRiver = z.infer<typeof RiverSchema>;
export type MapLayout = z.infer<typeof MapLayoutSchema>;
