/**
 * 玩法模块注册表。
 *
 * 顺序由 scenario.json 的 engine.moduleOrder 决定 —— 因为顺序即语义
 * （先移动还是先生产会影响结算结果），必须显式声明而非隐式依赖 import 顺序。
 *
 * ★加外交系统 = 新增 diplomacy.ts + `registerRuleModules()` 注册 + 在剧本 moduleOrder 里插入。
 *   apply.ts 一行不改，这就是"玩法模块可插拔"的落点。
 *   注册是**运行期 API**，不是改这行代码：宿主（main.ts / 测试 / 未来的插件加载器）都能加。
 */
import type { RuleModule } from '../module.ts';
import { economyModule } from './economy.ts';
import { movementModule } from './movement.ts';
import { combatModule } from './combat.ts';
import { governanceModule } from './governance.ts';
import { statecraftModule } from './statecraft.ts';
import { formationModule } from './formation.ts';
import { grudgeModule } from './grudge.ts';
import { slaveTradeModule } from './slavetrade.ts';
import { rebellionModule } from './rebellion.ts';
import { frontierModule } from './frontier.ts';

const REGISTRY = new Map<string, RuleModule>([
  ['economy', economyModule],
  ['movement', movementModule],
  ['combat', combatModule],
  ['governance', governanceModule],
  ['statecraft', statecraftModule],
  ['formation', formationModule],
  ['grudge', grudgeModule],
  ['slavetrade', slaveTradeModule],
  ['rebellion', rebellionModule],
  ['frontier', frontierModule],
]);

/** 内置模块 id（注册表会被插件扩展，这个常量只是"出厂自带"的快照） */
export const KNOWN_MODULE_IDS: readonly string[] = Object.freeze([...REGISTRY.keys()].sort());

/** 当前进程内**全部**已注册模块 id（含运行期注册的插件） */
export function knownModuleIds(): string[] {
  return [...REGISTRY.keys()].sort();
}

/**
 * 运行期注册玩法模块。
 *
 * ★三条硬约束：
 *   1. **不许覆盖**已注册 id（否则插件能悄悄替换经济/战斗规则，确定性就没了）
 *   2. 形状必须完整（id/version/reads/writes/commands/resolve）
 *   3. 能力必须显式声明（writes 是"我要改哪些状态"的合同，供重叠检查与审计）
 *
 * 注册后 behaviorFingerprint 会随之变化 ⇒ 旧存档在新模块集下 fail-closed（不静默续跑）。
 */
export function registerRuleModules(mods: Readonly<Record<string, RuleModule>> | readonly RuleModule[]): void {
  const entries: ReadonlyArray<readonly [string, RuleModule]> = Array.isArray(mods)
    ? (mods as readonly RuleModule[]).map((m) => [m.id, m] as const)
    : Object.entries(mods as Readonly<Record<string, RuleModule>>);
  for (const [key, mod] of entries) {
    if (typeof key !== 'string' || key.length === 0) throw new Error('模块 id 不能为空');
    if (!mod || typeof mod !== 'object') throw new Error(`模块 '${key}' 不是对象`);
    if (mod.id !== key) throw new Error(`注册键 '${key}' 与模块自报 id '${String(mod.id)}' 不一致`);
    if (REGISTRY.has(key)) {
      throw new Error(`模块 id '${key}' 已注册，不允许覆盖（插件不得替换内建规则）`);
    }
    if (typeof mod.version !== 'number' || !Number.isInteger(mod.version) || mod.version < 1) {
      throw new Error(`模块 '${key}' 的 version 必须是 ≥1 的整数`);
    }
    if (typeof mod.resolve !== 'function') throw new Error(`模块 '${key}' 缺少 resolve()`);
    if (!Array.isArray(mod.reads) || !Array.isArray(mod.writes) || !Array.isArray(mod.commands)) {
      throw new Error(`模块 '${key}' 的 reads/writes/commands 必须是数组（能力必须显式声明）`);
    }
    REGISTRY.set(key, mod);
  }
}

/** 测试/插件卸载用：清掉非内置模块与插件声明的重叠（不碰出厂三件套） */
export function unregisterPluginModules(): void {
  for (const id of [...REGISTRY.keys()]) {
    if (!KNOWN_MODULE_IDS.includes(id)) REGISTRY.delete(id);
  }
  EXTRA_WRITE_OVERLAPS.length = 0;
}

/**
 * 运行期声明一个**有意的** writes 重叠（例如外交模块与战斗模块都改 relations）。
 *
 * ★为什么允许插件自己声明而不是自动放行：
 *   重叠本身不是错误（顺序即语义），但必须是**显式**的、可在评审里看见的。
 *   自动放行等于把"顺序依赖"藏起来；显式声明才逼作者回答"谁先谁后、为什么"。
 */
export function declareWriteOverlap(slice: string, modules: readonly string[]): void {
  if (!slice || modules.length < 2) throw new Error('重叠声明需要 slice 与至少两个模块 id');
  const sorted = [...modules].sort();
  const exists = [...KNOWN_WRITE_OVERLAPS, ...EXTRA_WRITE_OVERLAPS].some(
    (k) => k.slice === slice && [...k.modules].sort().join(',') === sorted.join(','),
  );
  if (exists) return;
  EXTRA_WRITE_OVERLAPS.push({ slice, modules: sorted });
}

export function buildModules(order: readonly string[]): RuleModule[] {
  const out: RuleModule[] = [];
  for (const id of order) {
    const mod = REGISTRY.get(id);
    if (!mod) throw new Error(`未知的玩法模块 '${id}'（已注册：${knownModuleIds().join(', ')}）`);
    out.push(mod);
  }
  if (out.length === 0) throw new Error('moduleOrder 不能为空');
  return out;
}

/** behavior_fingerprint = 各模块版本的组合。改了模块逻辑必须升 version，否则旧档 fail-closed */
export function computeBehaviorFingerprint(modules: readonly RuleModule[], declared: number): number {
  let h = declared;
  for (const m of [...modules].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    h = (Math.imul(h, 31) + m.id.length + m.version) >>> 0;
  }
  return h;
}

/**
 * 已知的、**有意为之**的 writes 重叠白名单。
 *
 * 为什么不是"禁止一切重叠"：economy 与 combat 都合法地修改 units.troops
 * （前者是裁军/逃散，后者是战斗伤亡），二者的先后由 moduleOrder 显式决定。
 * 一刀切禁止会逼着模块去写变通字段，反而更糟。
 *
 * 所以规则是：**重叠必须在此登记**。新增一个未登记的重叠 ⇒ 测试红，
 * 强迫你要么改设计、要么显式承认这个顺序依赖。
 */
const EXTRA_WRITE_OVERLAPS: Array<{ slice: string; modules: readonly string[] }> = [];

export const KNOWN_WRITE_OVERLAPS: ReadonlyArray<{ slice: string; modules: readonly string[] }> = Object.freeze([
  { slice: 'units.troops', modules: ['combat', 'economy'] },
  { slice: 'units.regionId', modules: ['combat', 'movement'] },
  { slice: 'factions.morale', modules: ['combat', 'economy'] },
  { slice: 'regions.unrest', modules: ['combat', 'economy'] },
  // 启用 governance 的剧本会多一个治理模块写动乱/民心/兵源；
  // 同一切片允许多套已登记的模块组合，但组合本身仍必须显式列出。
  { slice: 'factions.morale', modules: ['combat', 'economy', 'governance'] },
  { slice: 'factions.manpower', modules: ['economy', 'governance'] },
  { slice: 'regions.unrest', modules: ['combat', 'economy', 'governance'] },
  // 外交/谍报模块：花金（与 economy 同写 gold）、改关系（与 combat 自动宣战同写 relations）
  { slice: 'factions.gold', modules: ['economy', 'statecraft'] },
  // 治理模块的基建命令也花金；启用全部三个模块时是一次三方重叠
  { slice: 'factions.gold', modules: ['economy', 'governance'] },
  { slice: 'factions.gold', modules: ['economy', 'governance', 'statecraft'] },
  { slice: 'relations', modules: ['combat', 'statecraft'] },
  // 编成模块：分兵/合兵也改兵力
  { slice: 'units.troops', modules: ['combat', 'economy', 'formation'] },
  // 潜在恨意：statecraft/combat 即时记仇，grudge 每回合缓慢累积/冷却
  { slice: 'relations', modules: ['combat', 'statecraft', 'grudge'] },
  // 鬻奴令：买方付金、双方掉民心、卖方掉兵源、贼配军改兵力/动乱
  { slice: 'factions.gold', modules: ['economy', 'governance', 'statecraft', 'slavetrade'] },
  { slice: 'factions.morale', modules: ['combat', 'economy', 'governance', 'slavetrade'] },
  { slice: 'factions.manpower', modules: ['economy', 'governance', 'slavetrade'] },
  { slice: 'regions.unrest', modules: ['combat', 'economy', 'governance', 'slavetrade'] },
  { slice: 'units.troops', modules: ['combat', 'economy', 'formation', 'slavetrade'] },
  // 起义模块：改归属/动乱、驱逐/解散驻军、生成起义民兵和守城民兵
  { slice: 'regions.owner', modules: ['combat', 'rebellion'] },
  { slice: 'regions.rebellion', modules: ['combat', 'rebellion'] },
  { slice: 'regions.unrest', modules: ['combat', 'economy', 'governance', 'slavetrade', 'rebellion'] },
  { slice: 'units.troops', modules: ['combat', 'economy', 'formation', 'slavetrade', 'rebellion'] },
  { slice: 'units.regionId', modules: ['combat', 'movement', 'rebellion'] },
  // 开荒：开垦改归属/基建/金粮/兵源，并移除原住民守军
  { slice: 'regions.owner', modules: ['combat', 'frontier', 'rebellion'] },
  { slice: 'regions.owner', modules: ['combat', 'frontier'] },
  { slice: 'regions.infrastructure', modules: ['frontier', 'governance'] },
  { slice: 'factions.gold', modules: ['economy', 'frontier', 'governance'] },
  { slice: 'factions.food', modules: ['economy', 'frontier'] },
  { slice: 'factions.manpower', modules: ['economy', 'frontier', 'governance'] },
  { slice: 'units.troops', modules: ['combat', 'economy', 'formation', 'frontier'] },
]);

/** 返回**未登记**的重叠 —— 这些才是真问题 */
export function findUndeclaredWriteConflicts(
  modules: readonly RuleModule[],
): Array<{ slice: string; modules: string[] }> {
  const byOwner = new Map<string, string[]>();
  for (const m of modules) {
    for (const w of m.writes) {
      byOwner.set(w, [...(byOwner.get(w) ?? []), m.id]);
    }
  }
  const conflicts = [...byOwner.entries()]
    .filter(([, owners]) => owners.length > 1)
    .map(([slice, owners]) => ({ slice, modules: [...owners].sort() }))
    .sort((a, b) => (a.slice < b.slice ? -1 : 1));

  const declaredList = [...KNOWN_WRITE_OVERLAPS, ...EXTRA_WRITE_OVERLAPS];
  return conflicts.filter((c) => {
    const declarations = declaredList.filter((k) => k.slice === c.slice);
    if (declarations.length === 0) return true;
    return !declarations.some((declared) => {
      const dk = [...declared.modules].sort();
      return dk.length === c.modules.length && dk.every((v, i) => v === c.modules[i]);
    });
  });
}

/** @deprecated 用 findUndeclaredWriteConflicts；本函数保留用于查看**全部**重叠 */
export function findWriteConflicts(modules: readonly RuleModule[]): Array<{ slice: string; modules: string[] }> {
  const byOwner = new Map<string, string[]>();
  for (const m of modules) {
    for (const w of m.writes) {
      byOwner.set(w, [...(byOwner.get(w) ?? []), m.id]);
    }
  }
  return [...byOwner.entries()]
    .filter(([, owners]) => owners.length > 1)
    .map(([slice, owners]) => ({ slice, modules: [...owners].sort() }))
    .sort((a, b) => (a.slice < b.slice ? -1 : 1));
}
