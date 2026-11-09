/**
 * 规范状态（GameState）与不可变内容（WorldConfig）。
 *
 * 分离依据 aonw ADR 0008：状态是"会变的事实"，内容是" immutable 的剧本/规则数据"。
 * 两者都显式传进核心，核心自己不读文件 —— 这是 P4「零 IO」的前提。
 *
 * ★本文件必须是纯类型 + 纯函数，不得 import 任何 IO/框架/随机源。
 *   tools/arch-check.ts 会静态扫描并强制。
 */

// ─────────────────────────────────────────────────────────────
// 标识符
// ─────────────────────────────────────────────────────────────

export type RegionId = string;
export type FactionId = string;

/** 间谍情报有效期：侦察当回合起，之后 INTEL_VALID_TURNS 个快照内保持 exact 视图 */
export const INTEL_VALID_TURNS = 3;
export type UnitId = string;
export type SeatId = string;
export type LawId = string;
export type UnitTypeId = string;
export type TerrainId = string;

/** 地形经济/情报/兵种倾向（规则代码常量；旧剧本 contentHash 不因它变化） */
export interface TerrainTraits {
  /** 粮产乘数 */
  readonly food: number;
  /** 金产乘数 */
  readonly gold: number;
  /** 人口增长速度乘数 */
  readonly popGrowth: number;
  /** 间谍费用乘数 */
  readonly intelCost: number;
  /** 森林等对步兵守军的战力乘数 */
  readonly infantryDefense: number;
}

export const TERRAIN_TRAITS: Readonly<Record<TerrainId, TerrainTraits>> = Object.freeze({
  plains: { food: 1.25, gold: 1.15, popGrowth: 1.25, intelCost: 1.0, infantryDefense: 1.0 },
  forest: { food: 1.65, gold: 1.25, popGrowth: 0.75, intelCost: 1.15, infantryDefense: 1.15 },
  hills: { food: 0.95, gold: 1.0, popGrowth: 0.85, intelCost: 1.15, infantryDefense: 1.05 },
  mountain: { food: 0.55, gold: 0.55, popGrowth: 0.45, intelCost: 1.8, infantryDefense: 1.0 },
  urban: { food: 0.7, gold: 1.45, popGrowth: 1.15, intelCost: 0.9, infantryDefense: 1.0 },
  river: { food: 1.2, gold: 1.0, popGrowth: 1.1, intelCost: 1.1, infantryDefense: 1.0 },
});

export function terrainTraits(terrain: TerrainId): TerrainTraits {
  return TERRAIN_TRAITS[terrain] ?? TERRAIN_TRAITS.plains!;
}

/**
 * 步兵类兵种：林地等地形的守备加成只给他们。
 * 骑兵、弓兵、攻城器械不吃步兵地形加成；旧剧本无这些兵种时集合自然为空命中。
 */
export const INFANTRY_TYPES: readonly UnitTypeId[] = Object.freeze(['militia', 'spearman', 'swordsman']);

export function isInfantryType(typeId: UnitTypeId): boolean {
  return INFANTRY_TYPES.includes(typeId);
}

/**
 * 兵种作战域（第二模式引入）。
 * ★默认 land，只有显式声明 water 的单位才能走 waterRoutes。
 *   旧剧本的 units.json 不写 domain，因此不会改变任何旧行为或 contentHash。
 */
export type UnitDomain = 'land' | 'water' | 'amphibious';

/** 对局阶段（同时提交-统一裁决模型） */
export type Phase = 'lobby' | 'submitting' | 'resolving' | 'narrating' | 'ended';

/** 势力间关系 */
export type RelationKind =
  | 'war'
  | 'alliance'
  | 'truce'
  | 'peace'
  | 'neutral';

/**
 * 潜在恨意：两国之间**长期累积**的敌意，不随一次停战立刻清零。
 * 0-100；由 grudge 模块按战争/战斗/毁约累积，和平期缓慢冷却。
 * 与 RelationKind 分开：关系是"现在签了什么"，恨意是"民间与朝堂还记得什么"。
 */
export const GRUDGE_MAX = 100;
export const TRADE_EMBARGO_GRUDGE = 70;
export const TRADE_RESTRICTED_GRUDGE = 30;

export type TradePolicy = 'free' | 'restricted' | 'embargo';

/**
 * 兵种头衔。目前只有奴隶贸易产生的「贼配军」：
 * 只能是最低级民兵，且驻扎时每回合额外制造动乱。
 */
export type UnitTitle = 'bandit_conscript' | 'rebel_militia' | 'rebel_garrison';

export const UNIT_TITLE_LABELS: Readonly<Record<UnitTitle, string>> = Object.freeze({
  bandit_conscript: '贼配军',
  rebel_militia: '起义民兵',
  rebel_garrison: '守城民兵',
});

export function unitTitleLabel(title: UnitTitle | undefined): string | null {
  return title ? UNIT_TITLE_LABELS[title] ?? title : null;
}

// ─────────────────────────────────────────────────────────────
// 不可变内容（来自 config/，开局加载后全程只读）
// ─────────────────────────────────────────────────────────────

export interface RegionDef {
  readonly id: RegionId;
  readonly name: string;
  readonly terrain: TerrainId;
  /** 邻接表。★加载时必须排序，否则 Object/JSON 顺序变化会破坏确定性 */
  readonly adjacency: readonly RegionId[];
  /** 基础产出（未开发时的每回合产量） */
  readonly baseFood: number;
  readonly baseGold: number;
  readonly baseManpower: number;
  /** 是否为战略要地（影响 AI 评估与告警，不参与数值结算） */
  readonly strategic: boolean;
  /** 可通行？false = 水域等，不可作为移动目标 */
  readonly passable: boolean;
  /** 港口：水师可在此征募/停泊，水路的端点也必须是港口。缺省 false。 */
  readonly port?: boolean;
}

export interface UnitTypeDef {
  readonly id: UnitTypeId;
  readonly name: string;
  readonly attack: number;
  readonly defense: number;
  /** 每回合移动力（地形成本累加，超出则不可达） */
  readonly movement: number;
  readonly recruitGold: number;
  readonly recruitFood: number;
  readonly recruitManpower: number;
  readonly upkeepGold: number;
  readonly upkeepFood: number;
  /** 作战域：默认 land；water 只能走水路，amphibious 两者皆可 */
  readonly domain?: UnitDomain;
  /** 克制：对被克制兵种战力 ×(1+bonus) */
  readonly counters?: Readonly<Record<UnitTypeId, number>>;
}

/**
 * 水路（无向边）：两个港口之间的一条特殊通道。
 * 只有 domain=water/amphibious 的部队能走，消耗 cost 点移动力；
 * 一回合可连走多条水路，这就是第二模式的"多格机动"。
 */
export interface WaterRoute {
  /** 规范化为字典序较小的端点，保证 JSON/digest 与输入顺序无关 */
  readonly a: RegionId;
  readonly b: RegionId;
  readonly cost: number;
}

export interface LawDef {
  readonly id: LawId;
  readonly name: string;
  /** 乘数型效果，全部数据驱动（Histrategy rules-as-data） */
  readonly effects: LawEffects;
  /** 启用成本（一次性） */
  readonly enactGold: number;
}

export interface LawEffects {
  readonly foodMultiplier?: number;
  readonly goldMultiplier?: number;
  readonly moralePerTurn?: number;
  readonly unrestPerTurn?: number;
  readonly upkeepMultiplier?: number;
  readonly recruitCostMultiplier?: number;
  /** 有效战力乘数（精兵令 = 1.15） */
  readonly combatPowerMultiplier?: number;
}

/**
 * 法令效果键的运行时白名单。
 *
 * 为什么要有它：`LawEffects` 是类型，运行时被擦除，无法反射校验。
 * 若只在 config.test.ts 里另写一份清单，就会变成"两处各一份、日久漂移"
 * —— 正是 Histrategy 剧本 ID 白名单散落两处的同款坑。故在此单一真源。
 * ★新增效果键时，必须同时改 LawEffects 与本数组，config.test.ts 会强制两者一致。
 */
export const LAW_EFFECT_KEYS: readonly string[] = Object.freeze([
  'foodMultiplier',
  'goldMultiplier',
  'moralePerTurn',
  'unrestPerTurn',
  'upkeepMultiplier',
  'recruitCostMultiplier',
  'combatPowerMultiplier',
]);

export interface CombatParams {
  readonly lanchesterExponent: number;
  readonly attackerExposure: number;
  readonly defenderExposure: number;
  readonly terrainModifier: Readonly<Record<TerrainId, { def: number; mov: number }>>;
  readonly moraleCoefficient: number;
  readonly moraleCollapseThreshold: number;
  readonly fortBonusPerLevel: number;
  /** 攻城器械对要塞加成的削弱比例（0.5 = 要塞加成减半） */
  readonly siegeNegatesFort: number;
  readonly casualtyBaseRate: number;
  readonly routMultiplier: number;
  /** LLM 提示的伤亡被钳在确定值的这个区间（P2） */
  readonly casualtyClamp: readonly [number, number];
  readonly capturePowerRatio: number;
  readonly requireAdjacency: boolean;
  readonly maxRounds: number;
  /** 每回合每方掷几颗骰、几面。骰值归一化后作为"运气因子"乘进伤亡 */
  readonly dicePerRound: number;
  readonly diceSides: number;
  /** 兵力低于开局此比例即溃败 */
  readonly routThresholdRatio: number;
}

export interface EconomyParams {
  readonly taxPerPop: number;
  readonly taxMinRate: number;
  readonly taxMaxRate: number;
  readonly foodPerRegion: number;
  readonly foodPopRate: number;
  readonly foodPerSoldier: number;
  readonly developmentFoodMultiplierPerLevel: number;
  readonly upkeepPerSoldier: number;
  readonly upkeepEscalateEvery: number;
  readonly upkeepEscalateBy: number;
  /** 动态征兵比例：按人口规模递减（防滚雪球） */
  readonly conscriptTiers: ReadonlyArray<{ readonly popBelow: number | null; readonly ratio: number }>;
  readonly fatiguePerStreak: number;
  readonly fatigueFloor: number;
  readonly occupationCostPerRegionBeyondCapital: number;
  readonly developmentCostBase: number;
  readonly developmentCostPerLevel: number;
  readonly fortCostPerLevel: number;
  /** 国策基础价之外，每 10 万人口追加的金成本（未配置时用代码默认 600） */
  readonly lawEnactGoldPer100k?: number;
  readonly developmentPopulationDivisor: number;
  /** 税率每高于 0.2 一点，动乱增加多少 */
  readonly taxMoralePenaltyPerPointAbove02: number;
  readonly starvationMoraleLossPerTurn: number;
  readonly starvationDesertionRate: number;
  readonly bankruptMoraleLossPerTurn: number;
  readonly populationGrowthPerTurn: number;
  readonly unrestFromHighTaxAbove04: number;
  readonly unrestDecayPerTurn: number;
  readonly moraleRegenPerTurn: number;
  readonly moraleMax: number;
  readonly moraleMin: number;
  /** ★per-faction 独立钳制（不按最大涨幅者全体缩放） */
  readonly extremeClamp: {
    readonly troopLoss: number;
    readonly troopGain: number;
    readonly foodLoss: number;
    readonly foodGain: number;
    readonly goldLoss: number;
    readonly goldGain: number;
  };
}

export interface InfrastructureLevelDef {
  readonly level: Exclude<InfrastructureLevel, 0>;
  readonly name: string;
  /** 升到本级的一次性金成本 */
  readonly costGold: number;
  /** 建成时立即降低的本区动乱 */
  readonly unrestRelief: number;
  /** 建成后每回合为本区降低的动乱 */
  readonly unrestReductionPerTurn: number;
  /** 计入全国民心汇总的基建点（每 N 点 +1 民心/回合） */
  readonly moralePoints: number;
  /** 本区每回合额外的人口增长率（绝对比率，如 0.014 = +1.4%） */
  readonly populationGrowthBonus: number;
}

export interface InfrastructureParams {
  readonly maxLevel: Exclude<InfrastructureLevel, 0>;
  readonly levels: readonly InfrastructureLevelDef[];
  /** 每累计多少基建点，全国民心 +1/回合 */
  readonly moralePointsPerTurnPoint: number;
  /** 建成一级基建时立即提升的全国民心 */
  readonly moraleOnBuild: number;
}

export interface LowMoraleUnrestParams {
  /** 全国民心低于此值才放大地区动乱 */
  readonly threshold: number;
  /** 民心为 0 时的最大额外倍数：factor = 1 + gap/threshold × maxUnrestBonus */
  readonly maxUnrestBonus: number;
  /** 一次征兵在本区制造的基础动乱 */
  readonly recruitBase: number;
  /** 一场战斗在本区制造的基础动乱 */
  readonly battleBase: number;
  /** 夺城在本区追加的基础动乱 */
  readonly captureBase: number;
  /** 主动开战（由非战争状态转入战争）在出发地制造的基础动乱 */
  readonly warDeclarationBase: number;
}

export interface UnrestEffectsParams {
  /** 每 1 点地区动乱降低的本区金/粮产出比例 */
  readonly outputPenaltyPerPoint: number;
  /** 每 1 点地区动乱降低的本区守备战力比例 */
  readonly defensePenaltyPerPoint: number;
}

/** 可选治理规则。未声明 governance 的旧剧本行为与旧版本完全一致。 */
export interface GovernanceParams {
  readonly infrastructure: InfrastructureParams;
  readonly lowMoraleUnrest: LowMoraleUnrestParams;
  readonly unrestEffects: UnrestEffectsParams;
}

/**
 * 奴隶贸易参数（可选；只有显式声明 knowledge.slaveTradeFile 的剧本才启用）。
 *
 * 规则边界：
 *   · 买方必须已颁布 lawId 指定的国策；
 *   · 只能从**相邻**的卖方地块买入；
 *   · 卖方无需同法，但必须与买方非交战、且未因恨意进入禁运；
 *   · 奴隶只能编为最低级兵种（slaveUnitType），并带 bandit_conscript 头衔；
 *   · 每支贼配军每回合在其所在区制造 banditUnrestPerTurn 动乱。
 */
export interface SlaveTradeParams {
  readonly lawId: LawId;
  readonly slaveUnitType: UnitTypeId;
  readonly priceGoldPerThousand: number;
  readonly minPerTrade: number;
  readonly maxPerTrade: number;
  /** 单次最多买走源地块人口的这一比例（防止一口吃掉整块地） */
  readonly maxShareOfRegionPopulation: number;
  readonly buyerMoraleCost: number;
  readonly sellerMoraleCost: number;
  readonly banditUnrestPerTurn: number;
  /** 恨意达到此值即禁运（与贸易政策 embargo 对齐） */
  readonly grudgeBlock: number;
  /** 恨意每 1 点让价格上浮的比例（0.02 = 满恨意 +200%） */
  readonly grudgePriceSurcharge: number;
  /** 关系价格乘数；缺省 1 */
  readonly relationPriceMultiplier: Readonly<Partial<Record<RelationKind, number>>>;
}

/**
 * 起义状态（附着在区域上）。
 *
 * 生命周期：
 *   ① 动乱达到 100 → 原主失去区域，区域 owner=null，生成 rebel_militia；
 *   ② 原主只能通过进攻杀光全部起义民兵后重新占领；
 *   ③ 民兵未死光前，民心高于原主且满足宣称条件的国家可 claim_rebellion，
 *      区域归附该国，unrest 设 90，最多保留 2 万守城民兵（garrisonOnly）；
 *   ④ claim 后的 3 回合内若在该区征兵 → 再次起义（from=claimant）；
 *   ⑤ 动乱 ≤ normalizeUnrest 时恢复正常（解除守城锁定）。
 */
export interface RebellionState {
  /** 起义针对的原属国 / 当前被推翻的统治者 */
  readonly from: FactionId;
  readonly sinceTurn: number;
  /** 已通过外交宣称归附的国家；存在时区域 owner 应为该势力 */
  readonly claimedBy?: FactionId;
  readonly claimedTurn?: number;
}

/** 起义参数（可选；只有显式声明 knowledge.rebellionFile 的剧本才启用） */
export interface RebellionParams {
  readonly rebelUnitType: UnitTypeId;
  /** 起义民兵数量 = 本区人口 × 该比例 */
  readonly levyRatio: number;
  /** 起义/守城民兵的战力乘数（低战力） */
  readonly rebelCombatMultiplier: number;
  /** 宣称是否要求宣称国与起义区相邻 */
  readonly claimRequiresAdjacency: boolean;
  /** 宣称国民心必须比原主高出多少 */
  readonly claimMoraleLead: number;
  /** 宣称归附后的动乱值 */
  readonly claimedUnrest: number;
  /** 宣称归附后最多保留的守城民兵 */
  readonly claimedGarrisonCap: number;
  /** 宣称归附后多少回合内在该区征兵会再次起义（含宣称当回合起算） */
  readonly claimedConscriptionTurns: number;
  /** 动乱降到该值及以下时恢复正常 */
  readonly normalizeUnrest: number;
  /** 原主重新占领后设置的动乱值 */
  readonly originalReoccupyUnrest: number;
}

/** 开荒参数（可选；只有显式声明 knowledge.frontierFile 的剧本才启用） */
export interface FrontierParams {
  readonly settleGoldCost: number;
  readonly settleFoodCost: number;
  /** 开垦成功后从地块“原住民资金”里获得的少量金（按 baseGold 比例） */
  readonly lootGoldRatio: number;
  /** 开垦所需兵力 / 原住民守军 的最小比例 */
  readonly nativeTroopRatio: number;
  /** 原住民转化为兵源的比例 */
  readonly nativeManpowerRatio: number;
  /** 开垦时自动建成的基建等级 */
  readonly settledInfrastructure: 1 | 2 | 3 | 4;
  /** 地块非军队人口对产出的惩罚系数：0 = 关闭（旧行为），0.35 = 满驻军时本区产出最多降 35% */
  readonly civilianLaborPenalty: number;
}

export interface WorldConfig {
  readonly scenarioId: string;
  readonly contentHash: string;
  readonly regions: Readonly<Record<RegionId, RegionDef>>;
  readonly unitTypes: Readonly<Record<UnitTypeId, UnitTypeDef>>;
  readonly laws: Readonly<Record<LawId, LawDef>>;
  readonly combat: CombatParams;
  readonly economy: EconomyParams;
  readonly movement: MovementParams;
  /** 水路网络（旧剧本为空数组；不影响旧剧本寻路） */
  readonly waterRoutes: readonly WaterRoute[];
  /** 全国民心 ↔ 地区动乱 ↔ 基建。旧剧本没有该字段 ⇒ 相关机制整体关闭 */
  readonly governance?: GovernanceParams;
  /** 奴隶贸易。旧剧本没有该字段 ⇒ 相关命令不出现 */
  readonly slaveTrade?: SlaveTradeParams;
  /** 起义规则。旧剧本没有该字段 ⇒ 动乱满 100 不会自动起义 */
  readonly rebellion?: RebellionParams;
  /** 开荒规则。旧剧本没有该字段 ⇒ 不出现 settle_region */
  readonly frontier?: FrontierParams;
  /**
   * 剧本启用的可选命令面（由 moduleOrder 推导，纯展示/枚举用）。
   * 旧剧本没有该字段 ⇒ 外交/间谍动作不出现，避免给出“提交了也不会生效”的假选项。
   */
  readonly capabilities?: {
    readonly diplomacy: boolean;
    readonly espionage: boolean;
    /** 是否启用国间潜在恨意（由 grudge 模块推导） */
    readonly grudge?: boolean;
    /** 是否启用奴隶贸易（由 slaveTrade 配置推导） */
    readonly slaveTrade?: boolean;
    /** 是否启用自动起义（由 rebellion 模块/配置推导） */
    readonly rebellion?: boolean;
    /** 是否启用开荒（由 frontier 配置推导） */
    readonly frontier?: boolean;
  };
  readonly maxTurns: number;
  /** 单一势力占领比例达到此值即征服胜利（来自 scenario.json 的 victory） */
  readonly victoryTerritoryRatio: number;
}

export interface MovementParams {
  readonly maxMovesPerUnitPerTurn: number;
  readonly allowPassThroughAllyTerritory: boolean;
  readonly allowPassThroughNeutralTerritory: boolean;
  readonly blockPassThroughEnemyTerritory: boolean;
  readonly pathSearchMaxNodes: number;
  readonly routRetreatToNearestOwned: boolean;
  readonly routRetreatMaxDistance: number;
}

// ─────────────────────────────────────────────────────────────
// 规范状态（会变的部分）
// ─────────────────────────────────────────────────────────────

/** RNG 流的可序列化状态（重放的地基） */
export interface RngState {
  readonly seed: number;
  readonly state: number;
}

/** 基建等级：0 = 未建，逐级修建；等级效果来自 governance 配置 */
export type InfrastructureLevel = 0 | 1 | 2 | 3 | 4;

export interface RegionState {
  readonly id: RegionId;
  /** null = 中立 */
  readonly owner: FactionId | null;
  /** ★离散等级 1-5，不是连续数值（Histrategy：离散 > 连续） */
  readonly development: 1 | 2 | 3 | 4 | 5;
  readonly fortLevel: 0 | 1 | 2 | 3;
  /**
   * 地区基建等级。★地区性：只影响本区的动乱/人口增长，
   * 并通过「基建点」以全国汇总的方式小幅提升全国民心。
   */
  readonly infrastructure: InfrastructureLevel;
  readonly foodStock: number;
  /**
   * 地区动乱（0-100）。★地区性：只影响本区产出与守备，
   * 不会直接等同于全国民心；低全国民心会放大征兵/战火在本区制造的动乱。
   */
  readonly unrest: number;
  readonly lastBattleTurn: number | null;
  /**
   * 上一任领主（易主时记录）。用于判定「夺回失地」：
   * 攻方 lastOwner === 攻方 时算收复故土。旧存档缺省 undefined。
   */
  readonly lastOwner?: FactionId | null;
  /** 起义状态；缺省 = 无起义 */
  readonly rebellion?: RebellionState;
}

export interface FactionState {
  readonly id: FactionId;
  readonly name: string;
  readonly gold: number;
  readonly food: number;
  /**
   * 全国民心（0-100）。★全国性：只挂在势力上，不按地区拆分。
   * 参与战斗战力系数、守军溃败判定，并在民心低于阈值时放大征兵/战火造成的地区动乱。
   */
  readonly morale: number;
  /** 可征兵池 */
  readonly manpower: number;
  readonly capital: RegionId;
  readonly taxRate: number;
  readonly laws: readonly LawId[];
  /** 连续征兵回合数（用于疲劳惩罚） */
  readonly conscriptStreak: number;
  /**
   * 已侦察区域 → 最后一次侦察的回合。★只给本势力用：
   * 在有效期内，投影层对该区给出 exact 视图（驻军/动乱/基建）。
   */
  readonly intel: Readonly<Record<RegionId, number>>;
  readonly eliminated: boolean;
}

export interface UnitState {
  readonly id: UnitId;
  readonly ownerId: FactionId;
  readonly regionId: RegionId;
  readonly typeId: UnitTypeId;
  readonly troops: number;
  /** 本回合是否已移动（同时提交模型下用于拒绝二次移动） */
  readonly movedThisTurn: boolean;
  /** 特殊头衔（如奴隶贸易产生的「贼配军」）；旧存档缺省无头衔 */
  readonly title?: UnitTitle;
  /** 守城锁定：不能移动、进攻、分兵、合兵；用于起义归附后的守城民兵 */
  readonly garrisonOnly?: boolean;
}

export interface RelationEntry {
  readonly kind: RelationKind;
  readonly sinceTurn: number;
  /** 潜在恨意 0-100；旧存档缺省 0 */
  readonly grudge?: number;
  /** 历史宣战次数；旧存档缺省 0 */
  readonly wars?: number;
  readonly lastWarTurn?: number;
}

export interface GameState {
  readonly turn: number;
  readonly phase: Phase;
  readonly regions: Readonly<Record<RegionId, RegionState>>;
  readonly factions: Readonly<Record<FactionId, FactionState>>;
  readonly units: Readonly<Record<UnitId, UnitState>>;
  /** 键必须是排序后的 `"a|b"`，保证与插入顺序无关 */
  readonly relations: Readonly<Record<string, RelationEntry>>;
  /** 各随机流的最新快照，键为流名（combat/event/unrest/ai） */
  readonly rngState: Readonly<Record<string, RngState>>;
  /** 已提交命令的席位（同时提交模型） */
  readonly submitted: readonly SeatId[];
  readonly winner: FactionId | null;
  readonly endReason: 'conquest' | 'turn_limit' | 'resignation' | 'draw' | null;
}

// ─────────────────────────────────────────────────────────────
// 纯查询函数（核心与 AI 层共用；无副作用）
// ─────────────────────────────────────────────────────────────

/** 关系键：排序后拼接，保证 (a,b) 与 (b,a) 同键 */
export function relationKey(a: FactionId, b: FactionId): string {
  return a <= b ? `${a}|${b}` : `${b}|${a}`;
}

export function getRelation(state: GameState, a: FactionId, b: FactionId): RelationKind {
  if (a === b) return 'neutral';
  return state.relations[relationKey(a, b)]?.kind ?? 'neutral';
}

/** 潜在恨意（0-100）；旧存档/未接入 grudge 的剧本恒为 0 */
export function getGrudge(state: GameState, a: FactionId, b: FactionId): number {
  if (a === b) return 0;
  const value = state.relations[relationKey(a, b)]?.grudge ?? 0;
  return Number.isFinite(value) ? Math.max(0, Math.min(GRUDGE_MAX, Math.round(value))) : 0;
}

/**
 * 两国当前贸易政策（单一真源：外交面板、AI 提示、奴隶贸易合法动作共用）。
 *   embargo：交战，或恨意 ≥ 70；
 *   restricted：中立，或恨意 30-69；
 *   free：和平/同盟且恨意 < 30。
 */
export function tradePolicyBetween(
  state: GameState,
  a: FactionId,
  b: FactionId,
  blockGrudge: number = TRADE_EMBARGO_GRUDGE,
): TradePolicy {
  if (getRelation(state, a, b) === 'war') return 'embargo';
  const grudge = getGrudge(state, a, b);
  if (grudge >= blockGrudge) return 'embargo';
  if (grudge >= TRADE_RESTRICTED_GRUDGE || getRelation(state, a, b) === 'neutral') return 'restricted';
  return 'free';
}

export function isAtWar(state: GameState, a: FactionId, b: FactionId): boolean {
  return getRelation(state, a, b) === 'war';
}

/** 某势力拥有的全部区域 id，★排序后返回（保证迭代顺序确定） */
export function regionsOf(state: GameState, factionId: FactionId): RegionId[] {
  return Object.keys(state.regions)
    .filter((rid) => state.regions[rid]?.owner === factionId)
    .sort();
}

/** 某势力驻扎在某区域的部队，★按 id 排序 */
export function unitsIn(state: GameState, regionId: RegionId, ownerId?: FactionId): UnitState[] {
  return Object.values(state.units)
    .filter((u) => u.regionId === regionId && (ownerId === undefined || u.ownerId === ownerId))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** 某势力的总兵力（用于极值钳制的基准） */
export function totalTroops(state: GameState, factionId: FactionId): number {
  let sum = 0;
  for (const u of Object.values(state.units)) {
    if (u.ownerId === factionId) sum += u.troops;
  }
  return sum;
}

/** 某区尚存的起义/守城民兵兵力 */
export function rebelTroopsInRegion(state: GameState, regionId: RegionId): number {
  let sum = 0;
  for (const u of Object.values(state.units)) {
    if (u.regionId !== regionId || u.troops <= 0) continue;
    if (u.title === 'rebel_militia' || u.title === 'rebel_garrison') sum += u.troops;
  }
  return sum;
}

/** 地区人口口径（单一真源）：baseManpower × 发展度系数 0.25/级 */
export function regionPopulation(baseManpower: number, development: number): number {
  return baseManpower * (1 + (development - 1) * 0.25);
}

/** 某势力的总人口（= 所辖区域 baseManpower × 发展度系数之和） */
export function totalPopulation(state: GameState, world: WorldConfig, factionId: FactionId): number {
  let sum = 0;
  for (const rid of regionsOf(state, factionId)) {
    const def = world.regions[rid];
    if (!def) continue;
    const region = state.regions[rid];
    if (!region) continue;
    sum += regionPopulation(def.baseManpower, region.development);
  }
  return Math.floor(sum);
}

/** 可从事经济活动的平民人口 = 总人口 − 兵力；用于税收与人口增长 */
export function civilianPopulation(state: GameState, world: WorldConfig, factionId: FactionId): number {
  return Math.max(0, totalPopulation(state, world, factionId) - totalTroops(state, factionId));
}

/** 单个地块的平民人口 = 地块总人口 − 该地块上的全部驻军；只用于展示/地方产出，不替代势力级平民口径 */
export function regionCivilianPopulation(state: GameState, world: WorldConfig, regionId: RegionId): number {
  const def = world.regions[regionId];
  const st = state.regions[regionId];
  if (!def || !st) return 0;
  const troops = unitsIn(state, regionId).reduce((sum, u) => sum + Math.max(0, u.troops), 0);
  return Math.max(0, Math.floor(regionPopulation(def.baseManpower, st.development) - troops));
}

/** 两区域是否相邻 */
export function isAdjacent(world: WorldConfig, a: RegionId, b: RegionId): boolean {
  if (a === b) return false;
  const def = world.regions[a];
  if (!def) return false;
  return def.adjacency.includes(b);
}

/** 与某港口通过一条水路直接相连的港口（排序，保证遍历顺序确定） */
export function waterRouteNeighbors(world: WorldConfig, regionId: RegionId): RegionId[] {
  const out: RegionId[] = [];
  for (const route of world.waterRoutes) {
    if (route.a === regionId) out.push(route.b);
    else if (route.b === regionId) out.push(route.a);
  }
  return out.sort();
}

/** 两个港口之间是否有一条直接水路 */
export function isWaterRouteAdjacent(world: WorldConfig, a: RegionId, b: RegionId): boolean {
  if (a === b) return false;
  return world.waterRoutes.some((r) => (r.a === a && r.b === b) || (r.a === b && r.b === a));
}

/**
 * 沿水路 BFS 找 from→to 的航线（最多 maxHops 跳）。
 *
 * ★水师可以打「一到两格」：相邻港口是 1 跳；中间隔一个港口时是 2 跳。
 * 返回完整航线（含起点终点）以便战斗证据与夺城后的进驻路径都可复核；
 * 找不到返回 null。邻接表按 id 排序，平局选择确定。
 */
export function waterRoutePath(
  world: WorldConfig,
  from: RegionId,
  to: RegionId,
  maxHops = 2,
): RegionId[] | null {
  if (from === to) return [from];
  if (!world.regions[from] || !world.regions[to]) return null;
  if (!Number.isInteger(maxHops) || maxHops < 1) return null;
  const prev = new Map<RegionId, RegionId>();
  const depth = new Map<RegionId, number>([[from, 0]]);
  const queue: RegionId[] = [from];
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++]!;
    const d = depth.get(cur) ?? 0;
    if (d >= maxHops) continue;
    for (const next of waterRouteNeighbors(world, cur)) {
      if (depth.has(next)) continue;
      depth.set(next, d + 1);
      prev.set(next, cur);
      if (next === to) {
        const path: RegionId[] = [to];
        let step: RegionId | undefined = to;
        while (step !== undefined && step !== from) {
          step = prev.get(step);
          if (step !== undefined) path.unshift(step);
        }
        return path[0] === from ? path : null;
      }
      queue.push(next);
    }
  }
  return null;
}

/** from 沿水路 maxHops 内可达的港口（排序；不含起点） */
export function waterRouteReachable(world: WorldConfig, from: RegionId, maxHops = 2): RegionId[] {
  const out = new Set<RegionId>();
  const queue: Array<{ id: RegionId; d: number }> = [{ id: from, d: 0 }];
  const seen = new Set<RegionId>([from]);
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++]!;
    if (cur.d >= maxHops) continue;
    for (const next of waterRouteNeighbors(world, cur.id)) {
      if (seen.has(next)) continue;
      seen.add(next);
      out.add(next);
      queue.push({ id: next, d: cur.d + 1 });
    }
  }
  return [...out].sort();
}

/**
 * 进攻邻接判定：陆军只能沿普通邻接；水师/两栖还可以沿水路打 1-2 格。
 * ★这是 waterRoutes 参与战斗的唯一入口，避免把水路混进 adjacency 后让陆军也“隔水开打”。
 */
export function isAttackAdjacent(
  world: WorldConfig,
  unitType: UnitTypeDef | undefined,
  from: RegionId,
  to: RegionId,
): boolean {
  if (isAdjacent(world, from, to)) return true;
  const domain = unitType?.domain ?? 'land';
  if (domain !== 'water' && domain !== 'amphibious') return false;
  return waterRoutePath(world, from, to, 2) !== null;
}

export function aliveFactions(state: GameState): FactionId[] {
  return Object.keys(state.factions)
    .filter((fid) => !state.factions[fid]?.eliminated)
    .sort();
}
