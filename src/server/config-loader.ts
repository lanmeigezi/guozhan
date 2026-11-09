/**
 * 配置装载器 —— 把 config/ 下的 JSON 组装成 WorldConfig 与初始 GameState。
 *
 * ★本文件在 server 层，不在 core 层：它是唯一被允许碰文件系统的配置入口。
 *   core 只接受装配好的 WorldConfig，从不自己读盘（P4 零 IO）。
 *
 * ★剧本发现走目录扫描，不是白名单 —— Histrategy 把剧本 id 硬编码在
 *   _validate_scenario_id 与 _CANONICAL_SCENARIO_IDS 两处，导致"加剧本要改代码"，
 *   它自己承诺的 rules-as-data 在最后一公里破功。我们不学。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type {
  FactionId,
  FrontierParams,
  GameState,
  GovernanceParams,
  InfrastructureLevelDef,
  LawDef,
  RegionDef,
  RegionId,
  RelationKind,
  RebellionParams,
  SlaveTradeParams,
  UnitDomain,
  UnitId,
  UnitTypeDef,
  WaterRoute,
  WorldConfig,
} from '../core/state.ts';
import { relationKey, terrainTraits } from '../core/state.ts';
import { buildModules, computeBehaviorFingerprint } from '../core/modules/index.ts';
import { MapLayoutFileSchema, MapLayoutSchema, type MapLayout, type MapLayoutRegion } from '../protocol/map-layout.ts';
import { generateRandomMap } from './random-map.ts';

const CONFIG_ROOT = 'config';

export interface ScenarioMeta {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly maxTurns: number;
  readonly moduleOrder: readonly string[];
  readonly behaviorFingerprint: number;
  readonly seats: {
    readonly humanCapable: readonly string[];
    readonly majorAi: readonly string[];
    readonly minorAi: readonly string[];
    readonly spectatorSlots: number;
  };
  readonly timeout: { readonly human: number; readonly ai: number };
  readonly milestones: ReadonlyArray<{ turn: number; require: Record<string, number>; message: string }>;
  readonly llm: {
    readonly model: string;
    readonly advisorMaxTokens: number;
    readonly narrativeMaxTokens: number;
    readonly intentMaxTokens: number;
    readonly temperature: number;
    readonly language: string;
  };
  readonly budget: { readonly perSeatTokenCap: number; readonly perTurnCallCap: number; readonly onExceed: string };
  /** 纯展示：剧本势力清单与座位上限，供快速开局前端按剧本切换势力 */
  readonly factions?: ReadonlyArray<{ readonly id: string; readonly name: string; readonly color: string }>;
  readonly minPlayers?: number;
  readonly maxPlayers?: number;
}

function readJson(path: string): any {
  if (!existsSync(path)) throw new Error(`配置文件缺失：${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * 按剧本 knowledge.* 解析配置文件路径（第二模式引入）。
 *
 * 旧剧本的 knowledge 指向共享文件，解析结果与旧的硬编码路径逐字相同，
 * contentHash 因此保持不变；新剧本可指向自己的 map/units/layout。
 * ★路径必须落在 config/ 内，防止剧本配置读到宿主机任意文件。
 */
function resolveScenarioFile(
  configRoot: string,
  scenarioDir: string,
  ref: unknown,
  fallback: string,
  label: string,
): string {
  if (ref !== undefined && (typeof ref !== 'string' || ref.length === 0)) {
    throw new Error(`剧本 ${label} 路径必须是非空字符串，实得 ${String(ref)}`);
  }
  const abs = typeof ref === 'string' ? resolve(scenarioDir, ref) : fallback;
  const rel = relative(resolve(configRoot), abs);
  if (isAbsolute(rel) || rel.startsWith('..')) {
    throw new Error(`剧本 ${label} 路径越界（必须位于 config/ 内）：${String(ref ?? abs)}`);
  }
  if (!existsSync(abs)) throw new Error(`剧本 ${label} 文件缺失：${abs}`);
  return abs;
}

const UNIT_DOMAINS: ReadonlySet<string> = new Set(['land', 'water', 'amphibious']);

/** 解析并规范化水路：端点必须存在且是港口；无向边按 a|b 排序去重 */
function parseWaterRoutes(raw: unknown, regions: Readonly<Record<RegionId, RegionDef>>): WaterRoute[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error('map.waterRoutes 必须是数组');
  const byKey = new Map<string, WaterRoute>();
  for (const item of raw) {
    if (item === null || typeof item !== 'object') throw new Error('map.waterRoutes 的每一项必须是对象');
    const rec = item as Record<string, unknown>;
    const a = rec['a'];
    const b = rec['b'];
    const cost = rec['cost'];
    if (typeof a !== 'string' || typeof b !== 'string' || a === b) {
      throw new Error(`水路端点非法：${JSON.stringify(item)}`);
    }
    if (typeof cost !== 'number' || !Number.isInteger(cost) || cost <= 0) {
      throw new Error(`水路 ${a}↔${b} 的 cost 必须是正整数，实得 ${String(cost)}`);
    }
    if (!regions[a] || !regions[b]) throw new Error(`水路 ${a}↔${b} 指向不存在的区域`);
    if (regions[a]?.port !== true || regions[b]?.port !== true) {
      throw new Error(`水路端点必须是港口：${a}↔${b}`);
    }
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    const normalized: WaterRoute = { a: a < b ? a : b, b: a < b ? b : a, cost };
    const prev = byKey.get(key);
    if (prev && prev.cost !== cost) throw new Error(`水路 ${key} 重复且 cost 不一致`);
    byKey.set(key, normalized);
  }
  return [...byKey.entries()].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([, route]) => route);
}

/**
 * 解析可选的治理规则（全国民心 / 地区动乱 / 基建）。
 *
 * 只有显式声明 `knowledge.governanceFile` 的剧本才启用：旧剧本的 contentHash
 * 与 behaviorFingerprint 因此保持逐字不变，旧存档不会因为新机制 fail-closed。
 */
function parseGovernance(raw: any, label: string): GovernanceParams {
  const infra = raw?.infrastructure;
  const low = raw?.lowMoraleUnrest;
  const unrest = raw?.unrestEffects;
  if (!infra || !Array.isArray(infra.levels) || infra.levels.length === 0) {
    throw new Error(`${label}.infrastructure.levels 必须是非空数组`);
  }
  const maxLevel = Number(infra.maxLevel);
  if (!Number.isInteger(maxLevel) || maxLevel < 1 || maxLevel > 4) {
    throw new Error(`${label}.infrastructure.maxLevel 必须是 1-4 的整数，实得 ${String(infra.maxLevel)}`);
  }
  const levels: InfrastructureLevelDef[] = (infra.levels as any[])
    .map((l) => ({
      level: Number(l.level) as InfrastructureLevelDef['level'],
      name: String(l.name ?? ''),
      costGold: Number(l.costGold),
      unrestRelief: Number(l.unrestRelief),
      unrestReductionPerTurn: Number(l.unrestReductionPerTurn),
      moralePoints: Number(l.moralePoints),
      populationGrowthBonus: Number(l.populationGrowthBonus),
    }))
    .sort((a, b) => a.level - b.level);
  if (levels.length !== maxLevel) {
    throw new Error(`${label}.infrastructure.levels 必须恰好覆盖 1-${maxLevel}（实得 ${levels.length} 项）`);
  }
  for (let i = 0; i < levels.length; i++) {
    const l = levels[i]!;
    if (l.level !== i + 1) throw new Error(`${label}.infrastructure.levels 必须逐级声明，缺 Lv${i + 1}`);
    if (!l.name) throw new Error(`${label}.infrastructure.levels[${i}].name 不能为空`);
    for (const key of ['costGold', 'unrestRelief', 'unrestReductionPerTurn', 'moralePoints', 'populationGrowthBonus'] as const) {
      if (!Number.isFinite(l[key]) || l[key] < 0) {
        throw new Error(`${label}.infrastructure.levels[${i}].${key} 必须是非负有限数，实得 ${String(l[key])}`);
      }
    }
  }
  if (!low || !unrest) throw new Error(`${label} 缺少 lowMoraleUnrest 或 unrestEffects`);
  const lowMoraleUnrest = {
    threshold: Number(low.threshold),
    maxUnrestBonus: Number(low.maxUnrestBonus),
    recruitBase: Number(low.recruitBase),
    battleBase: Number(low.battleBase),
    captureBase: Number(low.captureBase),
    warDeclarationBase: Number(low.warDeclarationBase),
  };
  for (const [key, value] of Object.entries(lowMoraleUnrest)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${label}.lowMoraleUnrest.${key} 必须是非负有限数，实得 ${String(value)}`);
    }
  }
  if (lowMoraleUnrest.threshold <= 0) throw new Error(`${label}.lowMoraleUnrest.threshold 必须大于 0`);
  const unrestEffects = {
    outputPenaltyPerPoint: Number(unrest.outputPenaltyPerPoint),
    defensePenaltyPerPoint: Number(unrest.defensePenaltyPerPoint),
  };
  for (const [key, value] of Object.entries(unrestEffects)) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`${label}.unrestEffects.${key} 必须在 [0,1]，实得 ${String(value)}`);
    }
  }
  const governance: GovernanceParams = {
    infrastructure: {
      maxLevel: maxLevel as 1 | 2 | 3 | 4,
      levels,
      moralePointsPerTurnPoint: Number(infra.moralePointsPerTurnPoint),
      moraleOnBuild: Number(infra.moraleOnBuild),
    },
    lowMoraleUnrest,
    unrestEffects,
  };
  for (const key of ['moralePointsPerTurnPoint', 'moraleOnBuild'] as const) {
    const value = governance.infrastructure[key];
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${label}.infrastructure.${key} 必须是正有限数，实得 ${String(value)}`);
    }
  }
  assertNoHoles(governance, label);
  return governance;
}

/**
 * 解析可选的奴隶贸易规则。
 *
 * 与 governance 相同的兼容原则：只有显式声明 knowledge.slaveTradeFile 的剧本
 * 才读取并写进 contentHash；旧剧本不产生新键、哈希不变。
 */
function parseSlaveTrade(raw: any, label: string): SlaveTradeParams {
  if (!raw || typeof raw !== 'object') throw new Error(`${label} 必须是对象`);
  const lawId = String(raw.lawId ?? '');
  const slaveUnitType = String(raw.slaveUnitType ?? '');
  if (!lawId) throw new Error(`${label}.lawId 不能为空`);
  if (!slaveUnitType) throw new Error(`${label}.slaveUnitType 不能为空`);
  const numericKeys = [
    'priceGoldPerThousand',
    'minPerTrade',
    'maxPerTrade',
    'maxShareOfRegionPopulation',
    'buyerMoraleCost',
    'sellerMoraleCost',
    'banditUnrestPerTurn',
    'grudgeBlock',
    'grudgePriceSurcharge',
  ] as const;
  const values: Record<string, number> = {};
  for (const key of numericKeys) {
    const value = Number(raw[key]);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${label}.${key} 必须是非负有限数，实得 ${String(raw[key])}`);
    }
    values[key] = value;
  }
  if (values['minPerTrade']! <= 0 || values['maxPerTrade']! < values['minPerTrade']!) {
    throw new Error(`${label} 的 minPerTrade/maxPerTrade 非法`);
  }
  if (values['maxShareOfRegionPopulation']! <= 0 || values['maxShareOfRegionPopulation']! > 1) {
    throw new Error(`${label}.maxShareOfRegionPopulation 必须在 (0,1]`);
  }
  if (values['grudgeBlock']! <= 0 || values['grudgeBlock']! > 100) {
    throw new Error(`${label}.grudgeBlock 必须在 (0,100]`);
  }
  const relationPriceMultiplier: Partial<Record<RelationKind, number>> = {};
  const rawMultipliers = raw.relationPriceMultiplier;
  if (rawMultipliers !== undefined && (rawMultipliers === null || typeof rawMultipliers !== 'object')) {
    throw new Error(`${label}.relationPriceMultiplier 必须是对象`);
  }
  for (const [kind, value] of Object.entries((rawMultipliers ?? {}) as Record<string, unknown>)) {
    if (!['war', 'alliance', 'truce', 'peace', 'neutral'].includes(kind)) {
      throw new Error(`${label}.relationPriceMultiplier 含未知关系 ${kind}`);
    }
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`${label}.relationPriceMultiplier.${kind} 必须是正有限数`);
    }
    relationPriceMultiplier[kind as RelationKind] = n;
  }
  const parsed: SlaveTradeParams = {
    lawId,
    slaveUnitType,
    priceGoldPerThousand: values['priceGoldPerThousand']!,
    minPerTrade: Math.round(values['minPerTrade']!),
    maxPerTrade: Math.round(values['maxPerTrade']!),
    maxShareOfRegionPopulation: values['maxShareOfRegionPopulation']!,
    buyerMoraleCost: Math.round(values['buyerMoraleCost']!),
    sellerMoraleCost: Math.round(values['sellerMoraleCost']!),
    banditUnrestPerTurn: Math.round(values['banditUnrestPerTurn']!),
    grudgeBlock: Math.round(values['grudgeBlock']!),
    grudgePriceSurcharge: values['grudgePriceSurcharge']!,
    relationPriceMultiplier,
  };
  assertNoHoles(parsed, label);
  return parsed;
}

/**
 * 解析可选的起义规则。只有显式声明 knowledge.rebellionFile 的剧本才启用；
 * 旧剧本不读取、不写进 contentHash。
 */
function parseRebellion(raw: any, label: string): RebellionParams {
  if (!raw || typeof raw !== 'object') throw new Error(`${label} 必须是对象`);
  const rebelUnitType = String(raw.rebelUnitType ?? '');
  if (!rebelUnitType) throw new Error(`${label}.rebelUnitType 不能为空`);
  const numericKeys = [
    'levyRatio',
    'rebelCombatMultiplier',
    'claimMoraleLead',
    'claimedUnrest',
    'claimedGarrisonCap',
    'claimedConscriptionTurns',
    'normalizeUnrest',
    'originalReoccupyUnrest',
  ] as const;
  const values: Record<string, number> = {};
  for (const key of numericKeys) {
    const value = Number(raw[key]);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${label}.${key} 必须是非负有限数，实得 ${String(raw[key])}`);
    }
    values[key] = value;
  }
  if (values['levyRatio']! <= 0 || values['levyRatio']! > 1) {
    throw new Error(`${label}.levyRatio 必须在 (0,1]`);
  }
  if (values['rebelCombatMultiplier']! <= 0 || values['rebelCombatMultiplier']! > 1) {
    throw new Error(`${label}.rebelCombatMultiplier 必须在 (0,1]`);
  }
  if (values['claimedUnrest']! > 100 || values['normalizeUnrest']! > 100 || values['originalReoccupyUnrest']! > 100) {
    throw new Error(`${label} 的动乱值必须在 [0,100]`);
  }
  if (values['claimedConscriptionTurns']! < 1 || !Number.isInteger(values['claimedConscriptionTurns'])) {
    throw new Error(`${label}.claimedConscriptionTurns 必须 ≥1 的整数`);
  }
  const parsed: RebellionParams = {
    rebelUnitType,
    levyRatio: values['levyRatio']!,
    rebelCombatMultiplier: values['rebelCombatMultiplier']!,
    claimRequiresAdjacency: raw.claimRequiresAdjacency !== false,
    claimMoraleLead: values['claimMoraleLead']!,
    claimedUnrest: Math.round(values['claimedUnrest']!),
    claimedGarrisonCap: Math.round(values['claimedGarrisonCap']!),
    claimedConscriptionTurns: Math.round(values['claimedConscriptionTurns']!),
    normalizeUnrest: Math.round(values['normalizeUnrest']!),
    originalReoccupyUnrest: Math.round(values['originalReoccupyUnrest']!),
  };
  assertNoHoles(parsed, label);
  return parsed;
}

/** 解析可选的开荒规则。未声明的剧本不读取、不写进 contentHash。 */
function parseFrontier(raw: any, label: string): FrontierParams {
  if (!raw || typeof raw !== 'object') throw new Error(`${label} 必须是对象`);
  const settleGoldCost = Number(raw.settleGoldCost);
  const settleFoodCost = Number(raw.settleFoodCost);
  const lootGoldRatio = Number(raw.lootGoldRatio);
  const nativeTroopRatio = Number(raw.nativeTroopRatio);
  const nativeManpowerRatio = Number(raw.nativeManpowerRatio);
  const settledInfrastructure = Number(raw.settledInfrastructure);
  const civilianLaborPenalty = Number(raw.civilianLaborPenalty ?? 0);
  for (const [key, value] of Object.entries({ settleGoldCost, settleFoodCost, lootGoldRatio, nativeTroopRatio, nativeManpowerRatio, civilianLaborPenalty })) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${label}.${key} 必须是非负有限数，实得 ${String(value)}`);
  }
  if (civilianLaborPenalty > 1) throw new Error(`${label}.civilianLaborPenalty 必须在 0 到 1 之间`);
  if (!Number.isInteger(settledInfrastructure) || settledInfrastructure < 1 || settledInfrastructure > 4) {
    throw new Error(`${label}.settledInfrastructure 必须是 1-4 的整数`);
  }
  if (nativeTroopRatio <= 0) throw new Error(`${label}.nativeTroopRatio 必须大于 0`);
  const parsed: FrontierParams = {
    settleGoldCost: Math.round(settleGoldCost),
    settleFoodCost: Math.round(settleFoodCost),
    lootGoldRatio,
    nativeTroopRatio,
    nativeManpowerRatio,
    settledInfrastructure: settledInfrastructure as 1 | 2 | 3 | 4,
    civilianLaborPenalty,
  };
  assertNoHoles(parsed, label);
  return parsed;
}

/** 目录扫描发现剧本 */
export function discoverScenarios(configRoot = CONFIG_ROOT): string[] {
  const dir = join(configRoot, 'scenarios');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => {
      const full = join(dir, n);
      return statSync(full).isDirectory() && existsSync(join(full, 'scenario.json'));
    })
    .sort();
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * 深度扫描 undefined / NaN / Infinity，返回问题路径清单（纯函数，不抛）。
 *
 * ★为什么必须有它：2026-10-24 本项目实测，装载器漏复制一个经济参数键
 *   ⇒ 发展度乘数 NaN ⇒ 国库 NaN，而**全部确定性测试依然绿**（NaN 也是确定性的）。
 *   "同输入同输出"证明不了"输出是对的"。这条扫描是唯一能抓住它的闸门。
 */
export function findHoles(value: unknown, path = '', holes: string[] = []): string[] {
  if (value === undefined) {
    holes.push(`${path || '<root>'} = undefined`);
    return holes;
  }
  if (typeof value === 'number') {
    if (Number.isNaN(value)) holes.push(`${path} = NaN`);
    else if (!Number.isFinite(value)) holes.push(`${path} = ${value}`);
    return holes;
  }
  if (value === null || typeof value !== 'object') return holes;
  if (Array.isArray(value)) {
    value.forEach((v, i) => findHoles(v, `${path}[${i}]`, holes));
    return holes;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    findHoles(v, path ? `${path}.${k}` : k, holes);
  }
  return holes;
}

/** findHoles 的抛错版，供装载路径使用 */
export function assertNoHoles(value: unknown, label: string): void {
  const holes = findHoles(value, label);
  if (holes.length > 0) {
    throw new Error(`${label} 存在 ${holes.length} 处 undefined/NaN/Infinity（配置装载漏洞）：\n  ${holes.slice(0, 20).join('\n  ')}`);
  }
}

export interface LoadedScenario {
  readonly meta: ScenarioMeta;
  readonly world: WorldConfig;
  readonly initialState: GameState;
  readonly rootSeed: string;
  readonly contentHash: string;
  /**
   * 纯展示层的地图布局（坐标/画布/阵营色/首都）。
   * ★不进 contentHash、不进 behaviorFingerprint：换配色或挪一下六角格
   *   不该让旧存档 fail-closed。
   */
  readonly mapLayout: MapLayout;
}

/**
 * 读取并装配地图布局（hex 或 square）。
 *
 * 布局只描述"画在哪"，区域名/归属/兵力仍以按接收者投影的 Snapshot 为准。
 * 这里做 fail-fast 的形状/覆盖面/几何归一化；更细的规则一致性（桥必须对应普通邻接、
 * 非桥列不得有跨河邻接）由 tests/deterministic/scenario-iron-front.test.ts 强制。
 */
function loadMapLayout(
  layoutPath: string,
  regions: Readonly<Record<string, RegionDef>>,
  factionsDoc: any,
  waterRoutes: readonly WaterRoute[],
): MapLayout {
  const doc = readJson(layoutPath);
  if (doc.kind !== undefined && doc.kind !== 'hex' && doc.kind !== 'square' && doc.kind !== 'hexboard') {
    throw new Error(`地图布局 kind 非法：${String(doc.kind)}（只支持 hex / square / hexboard）`);
  }
  const kind: 'hex' | 'square' | 'hexboard' =
    doc.kind === 'square' ? 'square' : doc.kind === 'hexboard' ? 'hexboard' : 'hex';
  const candidate = kind === 'square'
    ? {
        kind: 'square' as const,
        canvas: doc.canvas,
        tile: doc.tile,
        grid: doc.grid,
        river: doc.river,
        regions: doc.regions,
      }
    : kind === 'hexboard'
      ? {
          kind: 'hexboard' as const,
          canvas: doc.canvas,
          hexSize: doc.hexSize,
          grid: doc.grid,
          river: doc.river,
          regions: doc.regions,
        }
      : {
          kind: 'hex' as const,
          canvas: doc.canvas,
          hexSize: doc.hexSize,
          regions: doc.regions,
        };
  const file = MapLayoutFileSchema.safeParse(candidate);
  if (!file.success) {
    const issue = file.error.issues[0];
    const at = issue?.path.join('.') ?? '';
    throw new Error(`地图布局非法（${layoutPath}）${at ? `：${at}` : ''} ${issue?.message ?? ''}`);
  }

  const known = new Set(Object.keys(regions));
  const seen = new Set<string>();
  const rawRegions = file.data.regions;
  for (const r of rawRegions) {
    if (!known.has(r.id)) throw new Error(`地图布局包含未知区域：${r.id}`);
    if (seen.has(r.id)) throw new Error(`地图布局区域重复：${r.id}`);
    seen.add(r.id);
  }
  const missing = [...known].filter((id) => !seen.has(id)).sort();
  if (missing.length > 0) throw new Error(`地图布局缺少区域：${missing.join('、')}`);

  const factionColors: Record<string, string> = {};
  const capitals: Record<string, string> = {};
  for (const f of factionsDoc.factions as any[]) {
    const id = String(f.id);
    if (typeof f.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(f.color)) {
      throw new Error(`势力 ${id} 缺少合法颜色（#rrggbb）：${String(f.color)}`);
    }
    factionColors[id] = f.color.toLowerCase();
    if (typeof f.capital !== 'string' || !known.has(f.capital)) {
      throw new Error(`势力 ${id} 的首都 ${String(f.capital)} 不在区域表中`);
    }
    capitals[id] = f.capital;
  }

  const ports = Object.keys(regions).filter((id) => regions[id]?.port === true).sort();

  if (file.data.kind === 'hex') {
    return MapLayoutSchema.parse({
      kind: 'hex',
      canvas: file.data.canvas,
      hexSize: file.data.hexSize,
      regions: file.data.regions.map((r) => ({ id: r.id, x: r.x, y: r.y })),
      factionColors,
      capitals,
      waterRoutes,
      ports,
    });
  }

  if (file.data.kind === 'hexboard') {
    const data = file.data;
    const { width, height } = data.canvas;
    const { originX, originY, cols, rows, waterRows } = data.grid;
    const waterSet = new Set<number>();
    for (const row of waterRows) {
      if (row < 0 || row >= rows) throw new Error(`hexboard 水域排 ${row} 超出 ${rows} 排`);
      if (waterSet.has(row)) throw new Error(`hexboard 水域排 ${row} 重复`);
      waterSet.add(row);
    }
    const dx = Math.sqrt(3) * data.hexSize;
    const dy = 1.5 * data.hexSize;
    const halfW = dx / 2;
    const centerOf = (col: number, row: number) => ({
      x: originX + dx * (col + (row % 2 === 1 ? 0.5 : 0)),
      y: originY + dy * row,
    });
    const checkBounds = (label: string, x: number, y: number) => {
      if (x - halfW < 0 || y - data.hexSize < 0 || x + halfW > width || y + data.hexSize > height) {
        throw new Error(`hexboard ${label} 超出画布：中心 (${x},${y})，画布 ${width}×${height}`);
      }
    };

    const cellSeen = new Set<string>();
    const normalized: MapLayoutRegion[] = data.regions.map((r) => {
      if (r.col >= cols || r.row >= rows) {
        throw new Error(`hexboard 区域 ${r.id} 的格子 (${r.col},${r.row}) 超出 ${cols}×${rows} 网格`);
      }
      if (waterSet.has(r.row)) throw new Error(`hexboard 区域 ${r.id} 不能落在水域排 ${r.row}`);
      const cell = `${r.col},${r.row}`;
      if (cellSeen.has(cell)) throw new Error(`hexboard 格子重叠：${cell}（${r.id}）`);
      cellSeen.add(cell);
      const { x, y } = centerOf(r.col, r.row);
      checkBounds(`区域 ${r.id}`, x, y);
      return { id: r.id, x, y, col: r.col, row: r.row };
    });

    const waterCells = [...waterSet]
      .sort((a, b) => a - b)
      .flatMap((row) =>
        Array.from({ length: cols }, (_, col) => {
          const { x, y } = centerOf(col, row);
          checkBounds(`水格 (${col},${row})`, x, y);
          return { x, y, col, row };
        }),
      );

    // 从规则层的普通邻接派生"桥"：比六角邻居更远的普通边就是跨水域桥
    const byId = new Map(normalized.map((r) => [r.id, r]));
    const bridges: Array<{ a: string; b: string }> = [];
    for (const id of Object.keys(regions).sort()) {
      for (const n of regions[id]?.adjacency ?? []) {
        if (id >= n) continue;
        const a = byId.get(id);
        const b = byId.get(n);
        if (!a || !b) continue;
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (distance > dx + 1) {
          const aRow = a.row;
          const bRow = b.row;
          if (aRow === undefined || bRow === undefined) continue;
          const lo = Math.min(aRow, bRow);
          const hi = Math.max(aRow, bRow);
          if (![...waterSet].some((w) => w > lo && w < hi)) {
            throw new Error(`hexboard 普通长边 ${id}-${n} 没有跨过水域排，无法解释为桥`);
          }
          bridges.push({ a: id, b: n });
        }
      }
    }
    bridges.sort((x, y) => (x.a + '|' + x.b < y.a + '|' + y.b ? -1 : 1));

    return MapLayoutSchema.parse({
      kind: 'hexboard',
      canvas: data.canvas,
      hexSize: data.hexSize,
      regions: normalized,
      waterCells,
      bridges,
      riverLabel: data.river?.label ?? '大江',
      factionColors,
      capitals,
      waterRoutes,
      ports,
    });
  }

  const data = file.data;
  const { width, height } = data.canvas;
  const tileW = data.tile.width;
  const tileH = data.tile.height;
  const gap = data.tile.gap ?? 8;
  const { originX, originY, cols, rows } = data.grid;
  const riverGap = data.grid.riverGap ?? 0;

  const cellSeen = new Set<string>();
  const normalized: MapLayoutRegion[] = data.regions.map((r) => {
    if (r.col >= cols || r.row >= rows) {
      throw new Error(`方块布局 ${r.id} 的格子 (${r.col},${r.row}) 超出 ${cols}×${rows} 网格`);
    }
    const cell = `${r.col},${r.row}`;
    if (cellSeen.has(cell)) throw new Error(`方块布局格子重叠：${cell}（${r.id}）`);
    cellSeen.add(cell);
    const x = originX + r.col * (tileW + gap) + tileW / 2;
    const riverAfterRow = data.river?.betweenRows[1] ?? rows;
    const y = originY + r.row * (tileH + gap) + tileH / 2 + (r.row >= riverAfterRow ? riverGap : 0);
    if (x - tileW / 2 < 0 || y - tileH / 2 < 0 || x + tileW / 2 > width || y + tileH / 2 > height) {
      throw new Error(`方块布局 ${r.id} 超出画布：中心 (${x},${y})，画布 ${width}×${height}`);
    }
    return { id: r.id, x, y, col: r.col, row: r.row };
  });

  let river: MapLayout['river'];
  if (data.river) {
    const [r1, r2] = data.river.betweenRows;
    if (r2 !== r1 + 1 || r1 < 0 || r2 >= rows) {
      throw new Error(`方块布局河道的 betweenRows 必须是相邻且有效的两排，实得 [${r1},${r2}]`);
    }
    const riverTop = originY + (r1 + 1) * tileH + r1 * gap;
    const riverBottom = originY + r2 * (tileH + gap) + riverGap;
    const riverLeft = originX;
    const riverRight = originX + cols * tileW + (cols - 1) * gap;
    if (riverBottom <= riverTop || riverLeft >= riverRight) {
      throw new Error('方块布局河道几何非法：河道宽度/边界为负');
    }
    const bridges = [...new Set(data.river.bridges)].sort((a, b) => a - b).map((col) => {
      if (col >= cols) throw new Error(`方块布局桥列 ${col} 超出 ${cols} 列`);
      return { col, x: originX + col * (tileW + gap) + tileW / 2, width: Math.min(48, tileW * 0.3) };
    });
    river = {
      top: riverTop,
      bottom: riverBottom,
      left: riverLeft,
      right: riverRight,
      label: data.river.label ?? '大江',
      bridges,
    };
  }

  return MapLayoutSchema.parse({
    kind: 'square',
    canvas: data.canvas,
    tile: { width: tileW, height: tileH, gap },
    regions: normalized,
    factionColors,
    capitals,
    waterRoutes,
    ports,
    ...(river ? { river } : {}),
  });
}

/**
 * 装载剧本。
 * @param scenarioId 目录名
 * @param rootSeed   房间根种子；缺省用 scenarioId 派生一个**固定**种子（便于测试与复现）
 */
export function loadScenario(scenarioId: string, rootSeed?: string, configRoot = CONFIG_ROOT): LoadedScenario {
  const scDir = join(configRoot, 'scenarios', scenarioId);
  const sc = readJson(join(scDir, 'scenario.json'));
  const knowledge = sc.knowledge && typeof sc.knowledge === 'object' ? (sc.knowledge as Record<string, unknown>) : {};
  const isGenerator = sc.generator !== undefined && typeof sc.generator === 'object';
  const effectiveRootSeed = rootSeed ?? (isGenerator
    ? sha256(`guozhan:${scenarioId}:random-default:v1`).slice(0, 32)
    : undefined);
  const factionsPath = resolveScenarioFile(
    configRoot, scDir, knowledge['factionsFile'], join(scDir, 'factions.json'), 'factionsFile',
  );
  const unitsDoc = readJson(resolveScenarioFile(
    configRoot, scDir, knowledge['unitsFile'], join(configRoot, 'rules', 'units.json'), 'unitsFile',
  ));
  const combat = readJson(resolveScenarioFile(
    configRoot, scDir, knowledge['combatFile'], join(configRoot, 'rules', 'combat.json'), 'combatFile',
  ));
  const economy = readJson(resolveScenarioFile(
    configRoot, scDir, knowledge['economyFile'], join(configRoot, 'rules', 'economy.json'), 'economyFile',
  ));
  const movement = readJson(resolveScenarioFile(
    configRoot, scDir, knowledge['movementFile'], join(configRoot, 'rules', 'movement.json'), 'movementFile',
  ));
  const lawsDoc = readJson(resolveScenarioFile(
    configRoot, scDir, knowledge['lawsFile'], join(configRoot, 'rules', 'laws.json'), 'lawsFile',
  ));
  // ★可选：只有显式声明 governanceFile 的剧本才启用民心/动乱/基建新机制。
  //   未声明的旧剧本不读取、不写进 contentHash，哈希与指纹保持逐字不变。
  const governance = knowledge['governanceFile'] !== undefined
    ? parseGovernance(
        readJson(resolveScenarioFile(
          configRoot, scDir, knowledge['governanceFile'], '', 'governanceFile',
        )),
        `governance(${scenarioId})`,
      )
    : undefined;
  // ★可选：奴隶贸易规则。未声明的剧本不读取、不写进 contentHash。
  const slaveTrade = knowledge['slaveTradeFile'] !== undefined
    ? parseSlaveTrade(
        readJson(resolveScenarioFile(
          configRoot, scDir, knowledge['slaveTradeFile'], '', 'slaveTradeFile',
        )),
        `slaveTrade(${scenarioId})`,
      )
    : undefined;
  // ★可选：起义规则。未声明的剧本不读取、不写进 contentHash。
  const rebellion = knowledge['rebellionFile'] !== undefined
    ? parseRebellion(
        readJson(resolveScenarioFile(
          configRoot, scDir, knowledge['rebellionFile'], '', 'rebellionFile',
        )),
        `rebellion(${scenarioId})`,
      )
    : undefined;
  // ★可选：开荒规则。未声明的剧本不读取、不写进 contentHash。
  const frontier = knowledge['frontierFile'] !== undefined
    ? parseFrontier(
        readJson(resolveScenarioFile(
          configRoot, scDir, knowledge['frontierFile'], '', 'frontierFile',
        )),
        `frontier(${scenarioId})`,
      )
    : undefined;

  let fac: any;
  let regionsDoc: any;
  let layoutPath: string | null = null;
  let generatedLayout: MapLayout | null = null;
  if (isGenerator) {
    const roster = readJson(factionsPath);
    const generated = generateRandomMap({
      scenarioId,
      rootSeed: effectiveRootSeed!,
      scenario: sc,
      roster,
      unitsDoc,
    });
    fac = generated.factionsDoc;
    regionsDoc = generated.regionsDoc;
    generatedLayout = generated.mapLayout;
  } else {
    const mapPath = resolveScenarioFile(
      configRoot, scDir, knowledge['mapFile'], join(configRoot, 'map', 'regions.json'), 'mapFile',
    );
    layoutPath = resolveScenarioFile(
      configRoot, scDir, knowledge['layoutFile'], join(configRoot, 'map', 'layout.json'), 'layoutFile',
    );
    fac = readJson(factionsPath);
    regionsDoc = readJson(mapPath);
  }

  // ── WorldConfig ──
  const regions: Record<RegionId, RegionDef> = {};
  for (const r of regionsDoc.regions as any[]) {
    regions[r.id as RegionId] = {
      id: r.id,
      name: r.name,
      terrain: r.terrain,
      adjacency: [...(r.adjacency as string[])].sort(),
      baseFood: r.baseFood,
      baseGold: r.baseGold,
      baseManpower: r.baseManpower,
      strategic: r.strategic === true,
      passable: r.passable !== false,
      // ★只有显式 true 才写入 port；旧地图不产生新键 ⇒ contentHash 不变
      ...(r.port === true ? { port: true } : {}),
    };
    if (r.port !== undefined && typeof r.port !== 'boolean') {
      throw new Error(`区域 ${String(r.id)} 的 port 必须是布尔值`);
    }
  }
  const unitTypes: Record<string, UnitTypeDef> = {};
  for (const u of unitsDoc.unitTypes as any[]) {
    const domain = u.domain as UnitDomain | undefined;
    if (domain !== undefined && !UNIT_DOMAINS.has(domain)) {
      throw new Error(`兵种 ${String(u.id)} 的 domain 非法：${String(u.domain)}`);
    }
    unitTypes[u.id as string] = {
      id: u.id,
      name: u.name,
      attack: u.attack,
      defense: u.defense,
      movement: u.movement,
      recruitGold: u.recruitGold,
      recruitFood: u.recruitFood,
      recruitManpower: u.recruitManpower,
      upkeepGold: u.upkeepGold,
      upkeepFood: u.upkeepFood,
      // ★同上：旧兵种配置不写 domain 就不产生新键
      ...(domain !== undefined ? { domain } : {}),
      ...(u.counters ? { counters: u.counters } : {}),
    };
  }
  const waterRoutes = parseWaterRoutes(regionsDoc.waterRoutes, regions);
  const laws: Record<string, LawDef> = {};
  for (const l of lawsDoc.laws as any[]) {
    laws[l.id as string] = { id: l.id, name: l.name, effects: l.effects ?? {}, enactGold: l.enactGold ?? 0 };
  }
  if (slaveTrade) {
    if (!laws[slaveTrade.lawId]) {
      throw new Error(`slaveTrade(${scenarioId}).lawId '${slaveTrade.lawId}' 不在本剧本的法令表中`);
    }
    if (!unitTypes[slaveTrade.slaveUnitType]) {
      throw new Error(`slaveTrade(${scenarioId}).slaveUnitType '${slaveTrade.slaveUnitType}' 不在本剧本兵种表中`);
    }
  }
  if (rebellion && !unitTypes[rebellion.rebelUnitType]) {
    throw new Error(`rebellion(${scenarioId}).rebelUnitType '${rebellion.rebelUnitType}' 不在本剧本兵种表中`);
  }

  /**
   * ★旧地图没有 waterRoutes 键时，不把它放进 hash 输入。
   *   否则所有旧存档的 contentHash 会凭空变化、在 verifyIdentity 处 fail-closed。
   */
  const hashInput: Record<string, unknown> = { regions, unitTypes, laws, combat, economy, movement, scenario: sc, factions: fac };
  if (regionsDoc.waterRoutes !== undefined) hashInput['waterRoutes'] = waterRoutes;
  // ★只有启用治理规则的剧本才把 governance 放进内容哈希；旧剧本哈希不变
  if (governance !== undefined) hashInput['governance'] = governance;
  if (slaveTrade !== undefined) hashInput['slaveTrade'] = slaveTrade;
  if (rebellion !== undefined) hashInput['rebellion'] = rebellion;
  if (frontier !== undefined) hashInput['frontier'] = frontier;
  const contentHash = sha256(stableStringify(hashInput));

  const world: WorldConfig = {
    scenarioId,
    contentHash,
    regions,
    unitTypes,
    laws,
    /**
     * ★整体展开，不逐键复制。
     *
     * 血泪教训（2026-10-24 本项目实测）：逐键复制漏了 developmentFoodMultiplierPerLevel，
     * 导致发展度乘数变 NaN、传染到国库，而**所有确定性测试依然全绿**——因为 NaN 也是确定性的。
     * 展开后"配置里有、接口里没声明"是安全的（多余键无害），
     * 而"接口要、配置漏"会由 tests/deterministic/replay.test.ts 的深度 NaN 扫描抓到。
     */
    combat: { ...combat, requireAdjacency: combat.requireAdjacency === true } as WorldConfig['combat'],
    economy: { ...economy } as WorldConfig['economy'],
    movement: {
      ...movement,
      allowPassThroughAllyTerritory: movement.allowPassThroughAllyTerritory === true,
      allowPassThroughNeutralTerritory: movement.allowPassThroughNeutralTerritory === true,
      blockPassThroughEnemyTerritory: movement.blockPassThroughEnemyTerritory === true,
      routRetreatToNearestOwned: movement.routRetreatToNearestOwned === true,
    } as WorldConfig['movement'],
    waterRoutes,
    ...(governance !== undefined ? { governance } : {}),
    ...(slaveTrade !== undefined ? { slaveTrade } : {}),
    ...(rebellion !== undefined ? { rebellion } : {}),
    ...(frontier !== undefined ? { frontier } : {}),
    ...(Array.isArray(sc.engine?.moduleOrder) && sc.engine.moduleOrder.includes('statecraft')
      ? {
          capabilities: {
            diplomacy: true,
            espionage: true,
            ...(sc.engine.moduleOrder.includes('grudge') ? { grudge: true } : {}),
            ...(slaveTrade !== undefined ? { slaveTrade: true } : {}),
            ...(rebellion !== undefined ? { rebellion: true } : {}),
            ...(frontier !== undefined ? { frontier: true } : {}),
          },
        }
      : {}),
    maxTurns: sc.meta.maxTurns,
    victoryTerritoryRatio: sc.victory?.conquestRegionsRatio ?? 0.6,
  };

  assertNoHoles(world, `WorldConfig(${scenarioId})`);

  // ── 初始 GameState ──
  const regionState: GameState['regions'] = {} as Record<RegionId, any>;
  for (const id of Object.keys(regions).sort()) {
    (regionState as Record<string, unknown>)[id] = {
      id,
      owner: null,
      development: 3 as const,
      fortLevel: (id === regions[id]!.name ? 0 : 0) as 0,
      infrastructure: 0 as const,
      foodStock: 0,
      unrest: 10,
      lastBattleTurn: null,
    };
  }

  const factionState: Record<FactionId, any> = {};
  const unitState: Record<UnitId, any> = {};
  const ownerOf = new Map<RegionId, FactionId>();

  for (const f of fac.factions as any[]) {
    factionState[f.id as FactionId] = {
      id: f.id,
      name: f.name,
      gold: f.gold,
      food: f.food,
      morale: f.morale,
      manpower: f.manpower ?? 0,
      capital: f.capital,
      taxRate: f.taxRate,
      laws: [...(f.laws ?? [])].sort(),
      conscriptStreak: 0,
      intel: {},
      eliminated: false,
    };
    for (const t of f.territories as string[]) {
      ownerOf.set(t as RegionId, f.id as FactionId);
      const r = (regionState as Record<string, any>)[t];
      if (r) r.owner = f.id;
      // 首都与战略要地自带一级要塞
      const isCapital = t === f.capital;
      if (r) r.fortLevel = isCapital ? 2 : regions[t as RegionId]!.strategic ? 1 : 0;
    }
    for (const u of f.units ?? []) {
      unitState[u.id as UnitId] = {
        id: u.id,
        ownerId: f.id,
        regionId: u.region,
        typeId: u.type,
        troops: u.troops,
        movedThisTurn: false,
      };
    }
  }

  // 中立区驻军：ownerId 用 'neutral' 标记，combat 模块按"区域 owner 为 null"识别
  for (const n of fac.neutralTerritories ?? []) {
    unitState[`garrison_${n.id}` as UnitId] = {
      id: `garrison_${n.id}`,
      ownerId: 'neutral',
      regionId: n.id,
      typeId: n.garrison.type,
      troops: n.garrison.troops,
      movedThisTurn: false,
    };
  }

  const relations: Record<string, any> = {};
  const grudgeEnabled = Array.isArray(sc.engine?.moduleOrder) && sc.engine.moduleOrder.includes('grudge');
  for (const r of fac.initialRelations ?? []) {
    relations[relationKey(r.a, r.b)] = {
      kind: r.kind,
      sinceTurn: 0,
      ...(grudgeEnabled && r.kind === 'war' ? { grudge: 25, wars: 1, lastWarTurn: 0 } : {}),
    };
  }

  // 初始兵源池 = 所辖人口
  for (const f of fac.factions as any[]) {
    let pop = 0;
    for (const t of f.territories as string[]) {
      const def = regions[t as RegionId];
      const st = (regionState as Record<string, any>)[t];
      if (def && st) pop += def.baseManpower * (1 + (st.development - 1) * 0.25);
    }
    factionState[f.id as FactionId].manpower = f.manpower ?? Math.floor(pop * 0.1);
  }

  const seed = rootSeed ?? (isGenerator
    ? effectiveRootSeed!
    : sha256(`guozhan:${scenarioId}:${contentHash}`).slice(0, 32));

  const initialState: GameState = {
    turn: sc.meta.startTurn ?? 1,
    phase: 'submitting',
    regions: regionState,
    factions: factionState,
    units: unitState,
    relations,
    rngState: {},
    submitted: [],
    winner: null,
    endReason: null,
  };

  const meta: ScenarioMeta = {
    id: sc.meta.id,
    name: sc.meta.name,
    description: sc.meta.description ?? '',
    maxTurns: sc.meta.maxTurns,
    moduleOrder: sc.engine.moduleOrder,
    /**
     * ★不是照抄 scenario.json 里那个数，而是 **声明值 × 实际模块的 id+version**。
     *   只信声明值的话，改了模块逻辑却忘了升 JSON 里的数字，旧存档会静默按新规则续跑 ——
     *   这正是 behavior_fingerprint 要防的事故。运行期注册的插件也会自动进入指纹。
     */
    behaviorFingerprint: computeBehaviorFingerprint(buildModules(sc.engine.moduleOrder), sc.engine.behaviorFingerprint),
    seats: sc.seats,
    timeout: sc.timeout,
    milestones: sc.milestones ?? [],
    llm: sc.llm,
    budget: sc.budget,
    factions: (fac.factions as any[]).map((f) => ({
      id: String(f.id),
      name: String(f.name ?? f.id),
      color: String(f.color ?? '#9c8d6e').toLowerCase(),
    })),
    minPlayers: 2,
    maxPlayers: Math.min(12, (fac.factions as any[]).length),
  };

  const lawHelp = (lawsDoc.laws as any[])
    .map((l) => ({
      id: String(l.id),
      name: String(l.name ?? l.id),
      description: String(l.description ?? ''),
      effects: (l.effects ?? {}) as Record<string, number>,
      enactGold: Number(l.enactGold ?? 0),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  /**
   * 规则解释 DTO：只给 UI 解释"民心/动乱/基建怎么算"。
   * ★不是规则真源——真正的裁决在 core；这里只把同一份 WorldConfig 参数摊开。
   */
  const unitHelp = Object.values(unitTypes)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((u) => ({
      id: u.id,
      name: u.name,
      attack: u.attack,
      defense: u.defense,
      movement: u.movement,
      domain: u.domain ?? 'land',
      recruitGold: u.recruitGold,
      recruitFood: u.recruitFood,
      recruitManpower: u.recruitManpower,
      upkeepGold: u.upkeepGold,
      upkeepFood: u.upkeepFood,
      counters: { ...(u.counters ?? {}) },
    }));
  const rulesHelp = {
    morale: {
      coefficient: world.combat.moraleCoefficient,
      collapseThreshold: world.combat.moraleCollapseThreshold,
      capturePowerRatio: world.combat.capturePowerRatio,
      min: world.economy.moraleMin,
      max: world.economy.moraleMax,
      regenPerTurn: world.economy.moraleRegenPerTurn,
    },
    lowMorale: governance
      ? {
          threshold: governance.lowMoraleUnrest.threshold,
          maxUnrestBonus: governance.lowMoraleUnrest.maxUnrestBonus,
          recruitBase: governance.lowMoraleUnrest.recruitBase,
          battleBase: governance.lowMoraleUnrest.battleBase,
          captureBase: governance.lowMoraleUnrest.captureBase,
          warDeclarationBase: governance.lowMoraleUnrest.warDeclarationBase,
        }
      : null,
    infrastructure: governance
      ? {
          maxLevel: governance.infrastructure.maxLevel,
          levels: governance.infrastructure.levels.map((l) => ({ ...l })),
          moralePointsPerTurnPoint: governance.infrastructure.moralePointsPerTurnPoint,
          moraleOnBuild: governance.infrastructure.moraleOnBuild,
        }
      : null,
    unrestEffects: governance ? { ...governance.unrestEffects } : null,
  };
  const terrainHelp = Object.keys(world.combat.terrainModifier).sort().map((id) => {
    const traits = terrainTraits(id);
    const combat = world.combat.terrainModifier[id]!;
    return {
      id,
      food: traits.food,
      gold: traits.gold,
      popGrowth: traits.popGrowth,
      intelCost: traits.intelCost,
      infantryDefense: traits.infantryDefense,
      moveCost: combat.mov,
      defenderBonus: combat.def,
    };
  });
  const mapLayout = MapLayoutSchema.parse({
    ...(generatedLayout ?? loadMapLayout(layoutPath!, regions, fac, waterRoutes)),
    laws: lawHelp,
    units: unitHelp,
    terrain: terrainHelp,
    rules: rulesHelp,
  });

  return { meta, world, initialState, rootSeed: seed, contentHash, mapLayout };
}
