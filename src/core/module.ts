/**
 * RuleModule —— 可插拔玩法系统接口（扩展性的核心）。
 *
 * 加外交/经济/科技 = 新增一个模块 + 一份 yaml + 在 scenario.toml 的 module_order 里插入。
 * **core/apply.ts 一行不改。**
 *
 * ★模块的 resolve() 必须是纯函数：只读 ctx，通过 ctx.emit() 产出事件，
 *   通过 ctx.mutate() 申请状态变更（由核心统一施加，模块不直接改 state）。
 *   这样"拒绝不改状态"（P4）与"事件顺序确定"才能成立。
 */
import type {
  FactionId,
  GameState,
  InfrastructureLevel,
  RebellionState,
  RegionId,
  RngState,
  UnitId,
  WorldConfig,
} from './state.ts';
import type { DeterministicRng } from './rng.ts';

/** 状态切片名。架构测试用它校验模块间 writes 无重叠。 */
export type StateSlice =
  | 'regions.owner'
  | 'regions.development'
  | 'regions.fortLevel'
  | 'regions.infrastructure'
  | 'regions.foodStock'
  | 'regions.unrest'
  | 'regions.rebellion'
  | 'factions.gold'
  | 'factions.food'
  | 'factions.morale'
  | 'factions.manpower'
  | 'factions.taxRate'
  | 'factions.laws'
  | 'factions.conscriptStreak'
  | 'factions.intel'
  | 'factions.eliminated'
  | 'units.regionId'
  | 'units.typeId'
  | 'units.troops'
  | 'relations';

/** 已被核心接受、可以进入结算的命令 */
export interface AcceptedOrder {
  readonly seatId: string;
  readonly factionId: FactionId;
  readonly command: unknown; // DomainCommand；核心已用 zod 校验过，模块按 kind 收窄
  readonly kind: string;
}

/** 状态变更申请。核心按申请顺序施加，模块之间看不到彼此的中间态。 */
export type Mutation =
  | { readonly op: 'set_region_owner'; readonly regionId: RegionId; readonly owner: FactionId | null }
  | { readonly op: 'set_region_development'; readonly regionId: RegionId; readonly development: 1 | 2 | 3 | 4 | 5 }
  | { readonly op: 'set_region_fort'; readonly regionId: RegionId; readonly fortLevel: 0 | 1 | 2 | 3 }
  | { readonly op: 'set_region_infrastructure'; readonly regionId: RegionId; readonly infrastructure: InfrastructureLevel }
  | { readonly op: 'add_region_food'; readonly regionId: RegionId; readonly delta: number }
  | { readonly op: 'add_region_unrest'; readonly regionId: RegionId; readonly delta: number; readonly reason?: string }
  | { readonly op: 'add_faction_gold'; readonly factionId: FactionId; readonly delta: number; readonly reason: string }
  | { readonly op: 'add_faction_food'; readonly factionId: FactionId; readonly delta: number; readonly reason: string }
  | { readonly op: 'add_faction_morale'; readonly factionId: FactionId; readonly delta: number; readonly reason: string }
  | { readonly op: 'add_faction_manpower'; readonly factionId: FactionId; readonly delta: number; readonly reason: string }
  | { readonly op: 'set_faction_tax_rate'; readonly factionId: FactionId; readonly rate: number }
  | { readonly op: 'set_faction_laws'; readonly factionId: FactionId; readonly laws: readonly string[] }
  | { readonly op: 'set_conscript_streak'; readonly factionId: FactionId; readonly streak: number }
  | { readonly op: 'set_faction_intel'; readonly factionId: FactionId; readonly regionId: RegionId; readonly turn: number }
  | { readonly op: 'eliminate_faction'; readonly factionId: FactionId; readonly reason: string }
  | { readonly op: 'move_unit'; readonly unitId: UnitId; readonly toRegion: RegionId; readonly path: readonly RegionId[]; readonly movementSpent: number }
  | { readonly op: 'add_unit_troops'; readonly unitId: UnitId; readonly delta: number; readonly reason: string }
  | { readonly op: 'spawn_unit'; readonly unitId: UnitId; readonly ownerId: FactionId; readonly regionId: RegionId; readonly typeId: string; readonly troops: number; readonly movedThisTurn?: boolean; readonly title?: string; readonly garrisonOnly?: boolean }
  | { readonly op: 'set_unit_garrison'; readonly unitId: UnitId; readonly garrisonOnly: boolean; readonly title?: string | null }
  | { readonly op: 'destroy_unit'; readonly unitId: UnitId; readonly reason: string }
  | { readonly op: 'set_relation'; readonly a: FactionId; readonly b: FactionId; readonly kind: string }
  | { readonly op: 'add_relation_grudge'; readonly a: FactionId; readonly b: FactionId; readonly delta: number; readonly reason: string }
  | { readonly op: 'set_region_rebellion'; readonly regionId: RegionId; readonly rebellion: RebellionState | null };

/** 逐字段增量归因（Histrategy turn_delta：这个数为什么变成这样） */
export interface DeltaRecord {
  readonly scope: string; // faction:<id> | region:<id>
  readonly field: string;
  readonly oldValue: number;
  readonly newValue: number;
  readonly delta: number;
  readonly reason: string;
  /** ★归因：代码算的 / LLM 提的 / 事件导致的 */
  readonly source: 'deterministic' | 'llm' | 'event';
}

/** 极值钳制命中记录（per-faction 独立） */
export interface ClampRecord {
  readonly scope: string;
  readonly field: string;
  readonly beforeClamp: number;
  readonly afterClamp: number;
  readonly limit: string;
}

export interface ResolveContext {
  /** 本回合开始时的规范状态。**只读** —— 深度冻结，改它会抛错 */
  readonly state: GameState;
  /** 不可变内容（剧本 + 规则参数）。模块不自己读文件 */
  readonly world: WorldConfig;
  /** 已通过校验的本回合命令（同时提交，顺序按 seatId 排序保证确定性） */
  readonly orders: readonly AcceptedOrder[];
  readonly turn: number;
  /** 时钟由房间层注入。★模块不得调用 Date.now() */
  readonly now: number;
  /** 房间根种子。模块用它派生自己的随机流，★不得调用 Math.random() */
  readonly rootSeed: string;
  /**
   * 取一条命名随机流。同一 (name, ...parts) 在本回合内返回同一实例，
   * 保证"多抽一次"不会因为调用顺序变化而改变别处的结果。
   */
  rng(name: 'combat' | 'event' | 'unrest' | 'ai', ...parts: ReadonlyArray<string | number>): DeterministicRng;
  /** 申请状态变更。核心在本模块 resolve() 返回后统一施加 */
  mutate(m: Mutation): void;
  /** 产出事件（含 ExecutionEvidence） */
  emit(event: unknown): void;
  /**
   * 报告一条**结算期**拒绝（结构校验已在锁定前做过，这里处理的是
   * 依赖同回合其他命令的资源竞争 —— 例如两个征兵命令抢同一笔国库）。
   * ★拒绝不产生任何副作用（P4）。
   */
  reject(order: AcceptedOrder, code: string, message: string): void;
  /** 记录逐字段增量归因 */
  recordDelta(d: DeltaRecord): void;
  /** 只读上一模块产出的增量（用于跨模块一致性检查） */
  readonly deltas: readonly DeltaRecord[];
}

export interface RuleModule {
  readonly id: string;
  /** 参与 behavior_fingerprint：改了模块逻辑必须升版本，否则旧存档 fail-closed */
  readonly version: number;
  readonly reads: readonly StateSlice[];
  readonly writes: readonly StateSlice[];
  /** 本模块处理的命令 kind。未声明的命令 → UNSUPPORTED_COMMAND */
  readonly commands: readonly string[];
  resolve(ctx: ResolveContext): void;
}

/** 回合结算的完整产物（all-or-nothing） */
export interface TurnOutcome {
  readonly state: GameState;
  readonly events: readonly unknown[];
  readonly deltas: readonly DeltaRecord[];
  readonly clamps: readonly ClampRecord[];
  readonly rngState: Readonly<Record<string, RngState>>;
  /** 本回合是否有 LLM delta 参与；false = 纯确定性回合 */
  readonly llmApplied: boolean;
  readonly newStateDigest: string;
  readonly rejected: ReadonlyArray<{ readonly seatId: string; readonly index: number; readonly code: string; readonly message: string }>;
}
