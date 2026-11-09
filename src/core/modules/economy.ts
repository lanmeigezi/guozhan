/**
 * 经济模块 —— 资源生产、税收、军费、征兵、开发、法令。
 *
 * 结算顺序（★顺序即语义，改动会改变游戏平衡，必须显式）：
 *   收入 → 命令执行 → 军费/治理费 → 惩罚（粮尽/金尽）→ 人口增长 → 动乱与士气
 * 收入先于命令，否则本回合的税收无法用于本回合的征兵。
 *
 * 防滚雪球三件套（平移自 Histrategy EconomyParams，它有 459 测试 + 9 个真实用户背书）：
 *   · 动态征兵比例：人口越多可征比例越低（<5万 12%，>60万 4%）
 *   · 军费渐进：每超 10 万兵维护率 +50%
 *   · 占领治理费：首都以外每区域 200 金/回合
 * 外加连续征兵疲劳。
 *
 * ★单位约定：unitTypes 里的 recruitGold/recruitFood/recruitManpower 与 upkeepGold/upkeepFood
 *   均为「每 1000 兵」的单价。兵力在本游戏是万级，用"每千兵单价"避免出现 0.0x 的碎数。
 */
import type { FactionId, RegionId, UnitTypeId, WorldConfig } from '../state.ts';
import { civilianPopulation, regionPopulation, regionsOf, terrainTraits, totalPopulation, unitsIn } from '../state.ts';
import { amplifiedUnrest, unrestOutputFactor } from '../unrest.ts';
import type { AcceptedOrder, ResolveContext, RuleModule, StateSlice } from '../module.ts';

interface RecruitCmd { kind: 'recruit'; regionId: RegionId; unitType: UnitTypeId; count: number }
interface DisbandCmd { kind: 'disband'; unitId: string; count: number }
interface SetTaxCmd { kind: 'set_tax'; rate: number }
interface SetLawCmd { kind: 'set_law'; lawId: string; enabled: boolean }
interface DevelopCmd { kind: 'develop'; regionId: RegionId }
interface FortifyCmd { kind: 'fortify'; regionId: RegionId; toLevel: number }

type EconCmd = RecruitCmd | DisbandCmd | SetTaxCmd | SetLawCmd | DevelopCmd | FortifyCmd;

const PER_THOUSAND = 1000;

/** 国策颁布成本：基础价 + 人口规模附加（每 10 万人口）。单一真源，UI 预估/实际扣款共用。 */
export function lawEnactCost(world: WorldConfig, law: { enactGold: number }, population: number): number {
  const per100k = Number(world.economy.lawEnactGoldPer100k ?? 600);
  const popFee = Math.max(0, population) / 100000 * per100k;
  return Math.max(0, Math.round(law.enactGold + popFee));
}

/** 变法必然生乱：每次新颁布国策立刻 -5 全国民心（不可逆的一次性代价） */
export const LAW_ENACT_MORALE_COST = 5;

/** 轻税回民心的基准：税率低于 20% 时，每低 10 个百分点 +2 民心/回合 */
export const LIGHT_TAX_MORALE_BONUS_PER_10PCT = 2;
/** 税率的民心中性点：正好 20% 不加不减 */
export const TAX_MORALE_NEUTRAL_RATE = 0.2;

/**
 * 税率对全国民心的每回合影响（单一真源：economy 结算与 legal 预估共用）。
 * 20% 中性；10% 轻税 +2；30% 起每高 10 个百分点按配置扣民心：
 * 30% -4、40% -8、50% -12、60% -16（配置 taxMoralePenaltyPerPointAbove02 = 4）。
 * 连续税率（如 25%）按比例取整，避免只有离散档位才生效。
 */
export function taxMoralePerTurn(world: WorldConfig, rate: number): number {
  const tenPctSteps = (rate - TAX_MORALE_NEUTRAL_RATE) * 10;
  if (tenPctSteps < 0) return Math.round(-tenPctSteps * LIGHT_TAX_MORALE_BONUS_PER_10PCT);
  const penalty = Math.round(tenPctSteps * world.economy.taxMoralePenaltyPerPointAbove02);
  return penalty === 0 ? 0 : -penalty;
}

/** 发展度带来的产出乘数（离散等级 ⇒ 稳健，Histrategy: 离散 > 连续） */
function devMultiplier(development: number, perLevel: number): number {
  return 1 + (development - 1) * perLevel;
}

/** 法令乘数聚合。laws 已排序，故结果与顺序无关 */
function lawEffects(world: WorldConfig, laws: readonly string[]) {
  let food = 1;
  let gold = 1;
  let upkeep = 1;
  let recruitCost = 1;
  let moralePerTurn = 0;
  let unrestPerTurn = 0;
  for (const id of [...laws].sort()) {
    const law = world.laws[id];
    if (!law) continue; // 未知法令静默跳过：配置校验已在启动时把关，运行时不再报错
    const e = law.effects;
    if (e.foodMultiplier !== undefined) food *= e.foodMultiplier;
    if (e.goldMultiplier !== undefined) gold *= e.goldMultiplier;
    if (e.upkeepMultiplier !== undefined) upkeep *= e.upkeepMultiplier;
    if (e.recruitCostMultiplier !== undefined) recruitCost *= e.recruitCostMultiplier;
    if (e.moralePerTurn !== undefined) moralePerTurn += e.moralePerTurn;
    if (e.unrestPerTurn !== undefined) unrestPerTurn += e.unrestPerTurn;
  }
  return { food, gold, upkeep, recruitCost, moralePerTurn, unrestPerTurn };
}

/** 动态征兵比例：按人口规模递减 */
function conscriptRatio(world: WorldConfig, population: number): number {
  for (const tier of world.economy.conscriptTiers) {
    if (tier.popBelow === null || population < tier.popBelow) return tier.ratio;
  }
  return world.economy.conscriptTiers[world.economy.conscriptTiers.length - 1]?.ratio ?? 0.04;
}

/** 连续征兵疲劳：streak 越长可征越少，有下限 */
function fatigueMultiplier(world: WorldConfig, streak: number): number {
  if (streak <= 1) return 1;
  return Math.max(world.economy.fatigueFloor, 1 - (streak - 1) * world.economy.fatiguePerStreak);
}

/** 军费渐进：每超 escalateEvery 兵，维护率 +escalateBy */
function upkeepEscalation(world: WorldConfig, totalTroops: number): number {
  const steps = Math.floor(totalTroops / world.economy.upkeepEscalateEvery);
  return 1 + steps * world.economy.upkeepEscalateBy;
}

export function troopsOfFaction(ctx: ResolveContext, factionId: FactionId): number {
  let sum = 0;
  for (const u of Object.values(ctx.state.units)) {
    if (u.ownerId === factionId) sum += u.troops;
  }
  return sum;
}

export const economyModule: RuleModule = {
  id: 'economy',
  version: 1,
  reads: [
    'regions.development', 'regions.foodStock', 'regions.unrest', 'regions.owner',
    'factions.gold', 'factions.food', 'factions.morale', 'factions.manpower',
    'factions.taxRate', 'factions.laws', 'factions.conscriptStreak', 'units.troops', 'units.regionId',
  ] as readonly StateSlice[],
  writes: [
    'regions.development', 'regions.fortLevel', 'regions.unrest',
    'factions.gold', 'factions.food', 'factions.morale', 'factions.manpower',
    'factions.taxRate', 'factions.laws', 'factions.conscriptStreak', 'factions.eliminated',
    'units.troops',
  ] as readonly StateSlice[],
  commands: ['recruit', 'disband', 'set_tax', 'set_law', 'develop', 'fortify'],

  resolve(ctx: ResolveContext): void {
    const { world } = ctx;
    const e = world.economy;
    const frontierLaborPenalty = world.frontier?.civilianLaborPenalty ?? 0;
    const factionIds = Object.keys(ctx.state.factions).sort();

    // ── 1. 收入：区域产出 + 税收 ──
    for (const fid of factionIds) {
      const f = ctx.state.factions[fid]!;
      if (f.eliminated) continue;
      const laws = lawEffects(world, f.laws);
      const owned = regionsOf(ctx.state, fid);
      let foodIncome = 0;
      let goldIncome = 0;
      for (const rid of owned) {
        const def = world.regions[rid];
        const st = ctx.state.regions[rid];
        if (!def || !st) continue;
        const dm = devMultiplier(st.development, e.developmentFoodMultiplierPerLevel);
        // ★地区动乱只惩罚本区产出（旧剧本 governance 缺失 ⇒ 乘数恒为 1）
        const stability = unrestOutputFactor(world.governance, st.unrest);
        // 地形产出倾向：平地/林地多产，山地贫瘠（规则常量，旧剧本 contentHash 不变）
        const traits = terrainTraits(def.terrain);
        // ★本区非军队人口对粮/金产出的影响（只在 frontier 配置开启时生效；旧剧本 penalty=0 保持原值）
        let labor = 1;
        if (frontierLaborPenalty > 0) {
          const pop = regionPopulation(def.baseManpower, st.development);
          if (pop > 0) {
            const garrison = unitsIn(ctx.state, rid).reduce((sum, u) => sum + Math.max(0, u.troops), 0);
            const civilianShare = Math.max(0, Math.min(1, (pop - garrison) / pop));
            labor = 1 - frontierLaborPenalty * (1 - civilianShare);
          }
        }
        foodIncome += def.baseFood * dm * laws.food * stability * traits.food * labor;
        goldIncome += def.baseGold * dm * laws.gold * stability * traits.gold * labor;
      }
      // ★税基只算平民（总人口 − 兵力）：兵越多，能纳税的人越少
      const pop = totalPopulation(ctx.state, world, fid);
      const civilians = civilianPopulation(ctx.state, world, fid);
      const taxRevenue = civilians * e.taxPerPop * f.taxRate;
      const total = Math.round(goldIncome + taxRevenue);
      if (total !== 0) {
        ctx.mutate({ op: 'add_faction_gold', factionId: fid, delta: total, reason: `产出+税收（税率 ${(f.taxRate * 100).toFixed(0)}%）` });
      }
      const foodTotal = Math.round(foodIncome);
      if (foodTotal !== 0) {
        ctx.mutate({ op: 'add_faction_food', factionId: fid, delta: foodTotal, reason: '粮草产出' });
      }
      // 人口增长 → 兵源池：按区地形倾向加权，且只有平民人口会自然增殖
      const civilianShare = pop > 0 ? civilians / pop : 0;
      let growthRaw = 0;
      for (const rid of owned) {
        const def = world.regions[rid];
        const st = ctx.state.regions[rid];
        if (!def || !st) continue;
        growthRaw += regionPopulation(def.baseManpower, st.development)
          * terrainTraits(def.terrain).popGrowth * civilianShare * e.populationGrowthPerTurn;
      }
      const growth = Math.round(growthRaw);
      if (growth > 0) {
        ctx.mutate({ op: 'add_faction_manpower', factionId: fid, delta: growth, reason: '人口自然增长' });
      }
    }

    // ── 2. 命令执行（★按 seatId 排序，保证同时提交下的结算顺序确定）──
    const sorted = [...ctx.orders].sort((a, b) =>
      a.seatId === b.seatId ? 0 : a.seatId < b.seatId ? -1 : 1,
    );
    let anyRecruit = new Set<FactionId>();
    // ★本回合按地块累计征兵；地块人口决定本区上限，避免小地块凭空爆兵。
    const recruitedByRegion = new Map<RegionId, number>();
    const recruitedByFaction = new Map<FactionId, number>();
    for (const order of sorted) {
      if (!economyModule.commands.includes(order.kind)) continue;
      handleCommand(ctx, order, order.command as EconCmd, anyRecruit, recruitedByRegion, recruitedByFaction);
    }

    // ── 3. 军费与占领治理费 ──
    for (const fid of factionIds) {
      const f = ctx.state.factions[fid]!;
      if (f.eliminated) continue;
      const laws = lawEffects(world, f.laws);
      const troops = troopsOfFaction(ctx, fid);
      const escalate = upkeepEscalation(world, troops);
      let upkeepGold = 0;
      let upkeepFood = 0;
      for (const u of Object.values(ctx.state.units)) {
        if (u.ownerId !== fid) continue;
        const t = world.unitTypes[u.typeId];
        if (!t) continue;
        upkeepGold += (t.upkeepGold * u.troops) / PER_THOUSAND;
        upkeepFood += (t.upkeepFood * u.troops) / PER_THOUSAND;
      }
      upkeepGold *= escalate * laws.upkeep;
      upkeepFood *= escalate;
      const regionCount = regionsOf(ctx.state, fid).length;
      const occupation = Math.max(0, regionCount - 1) * e.occupationCostPerRegionBeyondCapital;
      const goldCost = Math.round(upkeepGold + occupation);
      const foodCost = Math.round(upkeepFood + troops * e.foodPerSoldier);
      if (goldCost !== 0) {
        ctx.mutate({ op: 'add_faction_gold', factionId: fid, delta: -goldCost, reason: `军费${escalate > 1 ? `（渐进×${escalate.toFixed(2)}）` : ''}+治理费` });
      }
      if (foodCost !== 0) {
        ctx.mutate({ op: 'add_faction_food', factionId: fid, delta: -foodCost, reason: '军粮消耗' });
      }
    }

    // ── 4. 惩罚：粮尽 / 金尽（Histrategy H35z3：国库枯竭必须有后果，否则 AI 无限暴兵）──
    for (const fid of factionIds) {
      const f = ctx.state.factions[fid]!;
      if (f.eliminated) continue;
      const troops = troopsOfFaction(ctx, fid);
      if (f.food < 0) {
        ctx.mutate({ op: 'add_faction_morale', factionId: fid, delta: -e.starvationMoraleLossPerTurn, reason: '缺粮' });
        const desertion = Math.round(troops * e.starvationDesertionRate);
        if (desertion > 0) applyDesertion(ctx, fid, desertion);
      }
      if (f.gold < 0) {
        ctx.mutate({ op: 'add_faction_morale', factionId: fid, delta: -e.bankruptMoraleLossPerTurn, reason: '国库枯竭' });
      }
    }

    // ── 5. 动乱与士气回归 ──
    for (const fid of factionIds) {
      const f = ctx.state.factions[fid]!;
      if (f.eliminated) continue;
      const laws = lawEffects(world, f.laws);
      // 高税引发民怨（地区动乱）
      const excessTax = Math.max(0, f.taxRate - 0.4);
      const taxUnrest = excessTax * e.unrestFromHighTaxAbove04 * 100;
      // ★税率直接改全国民心：轻税回民、重税伤民（20% 中性）
      const taxMorale = taxMoralePerTurn(world, f.taxRate);
      if (taxMorale !== 0) {
        ctx.mutate({
          op: 'add_faction_morale',
          factionId: fid,
          delta: taxMorale,
          reason: taxMorale > 0
            ? `轻徭薄赋（税率 ${Math.round(f.taxRate * 100)}%）`
            : `加税伤民（税率 ${Math.round(f.taxRate * 100)}%）`,
        });
      }
      // 征兵会掉士气（不征兵则回升）
      const moraleDelta = laws.moralePerTurn + (anyRecruit.has(fid) ? -2 : e.moraleRegenPerTurn);
      if (moraleDelta !== 0) {
        ctx.mutate({ op: 'add_faction_morale', factionId: fid, delta: moraleDelta, reason: anyRecruit.has(fid) ? '征兵劳民' : '休养生息' });
      }
      if (!anyRecruit.has(fid) && f.conscriptStreak !== 0) {
        ctx.mutate({ op: 'set_conscript_streak', factionId: fid, streak: 0 });
      }
      for (const rid of regionsOf(ctx.state, fid)) {
        const st = ctx.state.regions[rid];
        if (!st) continue;
        // ★启用起义的剧本：普通区域一旦到 100 就不再自然衰减，保证同一回合末能触发起义；
        //   已归附的起义区仍正常衰减，才能靠治理把动乱降到恢复线。
        const rawDelta = taxUnrest + laws.unrestPerTurn - e.unrestDecayPerTurn;
        const delta = world.rebellion && !st.rebellion && st.unrest >= 100
          ? Math.max(0, taxUnrest + laws.unrestPerTurn)
          : rawDelta;
        if (delta !== 0) ctx.mutate({ op: 'add_region_unrest', regionId: rid, delta });
      }
    }

    // ── 6. 灭亡判定：无区域即出局 ──
    for (const fid of factionIds) {
      const f = ctx.state.factions[fid]!;
      if (f.eliminated) continue;
      if (regionsOf(ctx.state, fid).length === 0) {
        ctx.mutate({ op: 'eliminate_faction', factionId: fid, reason: '尽失疆土' });
      }
    }
  },
};

function applyDesertion(ctx: ResolveContext, fid: FactionId, total: number): void {
  // ★按 unit id 排序后分摊，保证取整误差落点确定
  const units = Object.values(ctx.state.units)
    .filter((u) => u.ownerId === fid)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (units.length === 0) return;
  const pool = units.reduce((s, u) => s + u.troops, 0);
  if (pool <= 0) return;
  let assigned = 0;
  for (let i = 0; i < units.length; i++) {
    const u = units[i]!;
    const share = i === units.length - 1 ? total - assigned : Math.round((u.troops / pool) * total);
    assigned += share;
    if (share > 0) ctx.mutate({ op: 'add_unit_troops', unitId: u.id, delta: -share, reason: '缺粮逃散' });
  }
}

function handleCommand(
  ctx: ResolveContext,
  order: AcceptedOrder,
  cmd: EconCmd,
  anyRecruit: Set<FactionId>,
  recruitedByRegion: Map<RegionId, number>,
  recruitedByFaction: Map<FactionId, number>,
): void {
  const { world } = ctx;
  const e = world.economy;
  const fid = order.factionId;
  const f = ctx.state.factions[fid];
  if (!f || f.eliminated) {
    ctx.reject(order, 'UNKNOWN_FACTION', '势力不存在或已灭亡');
    return;
  }

  switch (cmd.kind) {
    case 'set_tax': {
      if (cmd.rate < e.taxMinRate || cmd.rate > e.taxMaxRate) {
        ctx.reject(order, 'TAX_RATE_OUT_OF_RANGE', `税率必须在 [${e.taxMinRate}, ${e.taxMaxRate}]，收到 ${cmd.rate}`);
        return;
      }
      ctx.mutate({ op: 'set_faction_tax_rate', factionId: fid, rate: cmd.rate });
      return;
    }

    case 'set_law': {
      const law = world.laws[cmd.lawId];
      if (!law) {
        ctx.reject(order, 'UNKNOWN_LAW', `未知法令 ${cmd.lawId}`);
        return;
      }
      const current = [...f.laws].sort();
      const next = cmd.enabled
        ? current.includes(cmd.lawId) ? current : [...current, cmd.lawId].sort()
        : current.filter((x) => x !== cmd.lawId);
      if (cmd.enabled && !current.includes(cmd.lawId)) {
        const cost = lawEnactCost(world, law, totalPopulation(ctx.state, world, fid));
        if (f.gold < cost) {
          ctx.reject(order, 'INSUFFICIENT_GOLD', `颁布「${law.name}」需 ${cost} 金（含人口附加），现有 ${f.gold}`);
          return;
        }
        ctx.mutate({ op: 'add_faction_gold', factionId: fid, delta: -cost, reason: `颁布「${law.name}」` });
        // ★变法必生乱：颁布瞬间全国民心一次性 -5（废法不返还）
        ctx.mutate({
          op: 'add_faction_morale',
          factionId: fid,
          delta: -LAW_ENACT_MORALE_COST,
          reason: `变法「${law.name}」`,
        });
      }
      ctx.mutate({ op: 'set_faction_laws', factionId: fid, laws: next });
      return;
    }

    case 'develop': {
      const st = ctx.state.regions[cmd.regionId];
      if (!st || st.owner !== fid) {
        ctx.reject(order, 'REGION_NOT_OWNED', `${cmd.regionId} 不属于 ${fid}`);
        return;
      }
      if (st.development >= 5) {
        ctx.reject(order, 'DEVELOPMENT_MAXED', `${cmd.regionId} 发展度已满（5）`);
        return;
      }
      const pop = totalPopulation(ctx.state, world, fid);
      // 公式形态取自 Histrategy：150 × level × √(pop/1000)
      const cost = Math.round(
        e.developmentCostBase * e.developmentCostPerLevel * st.development * Math.sqrt(Math.max(1, pop) / e.developmentPopulationDivisor),
      );
      if (f.gold < cost) {
        ctx.reject(order, 'INSUFFICIENT_GOLD', `开发 ${cmd.regionId} 需 ${cost} 金，现有 ${f.gold}`);
        return;
      }
      ctx.mutate({ op: 'add_faction_gold', factionId: fid, delta: -cost, reason: `开发 ${cmd.regionId}` });
      ctx.mutate({
        op: 'set_region_development',
        regionId: cmd.regionId,
        development: (st.development + 1) as 2 | 3 | 4 | 5,
      });
      ctx.emit({ type: 'development_completed', turn: ctx.turn, regionId: cmd.regionId, fromLevel: st.development, toLevel: st.development + 1, goldSpent: cost });
      return;
    }

    case 'fortify': {
      const st = ctx.state.regions[cmd.regionId];
      if (!st || st.owner !== fid) {
        ctx.reject(order, 'REGION_NOT_OWNED', `${cmd.regionId} 不属于 ${fid}`);
        return;
      }
      if (cmd.toLevel !== st.fortLevel + 1 || cmd.toLevel > 3) {
        ctx.reject(order, 'MALFORMED_PAYLOAD', `要塞等级只能逐级提升，当前 ${st.fortLevel}，请求 ${cmd.toLevel}`);
        return;
      }
      const cost = e.fortCostPerLevel * cmd.toLevel;
      if (f.gold < cost) {
        ctx.reject(order, 'INSUFFICIENT_GOLD', `修建 ${cmd.regionId} 要塞 Lv${cmd.toLevel} 需 ${cost} 金，现有 ${f.gold}`);
        return;
      }
      ctx.mutate({ op: 'add_faction_gold', factionId: fid, delta: -cost, reason: `修建要塞 ${cmd.regionId} Lv${cmd.toLevel}` });
      ctx.mutate({ op: 'set_region_fort', regionId: cmd.regionId, fortLevel: cmd.toLevel as 1 | 2 | 3 });
      return;
    }

    case 'recruit': {
      const st = ctx.state.regions[cmd.regionId];
      if (!st || st.owner !== fid) {
        ctx.reject(order, 'REGION_NOT_OWNED', `${cmd.regionId} 不属于 ${fid}`);
        return;
      }
      const t = world.unitTypes[cmd.unitType];
      if (!t) {
        ctx.reject(order, 'UNKNOWN_UNIT_TYPE', `未知兵种 ${cmd.unitType}`);
        return;
      }
      if (t.domain === 'water' && world.regions[cmd.regionId]?.port !== true) {
        ctx.reject(order, 'UNIT_DOMAIN_MISMATCH', `水师只能在港口征募，${cmd.regionId} 不是港口`);
        return;
      }
      const laws = lawEffects(world, f.laws);
      const scale = cmd.count / PER_THOUSAND;
      const goldCost = Math.round(t.recruitGold * scale * laws.recruitCost);
      const foodCost = Math.round(t.recruitFood * scale * laws.recruitCost);
      const manpowerCost = Math.round(t.recruitManpower * scale);

      const pop = totalPopulation(ctx.state, world, fid);
      const ratio = conscriptRatio(world, pop);
      const fatigue = fatigueMultiplier(world, f.conscriptStreak + 1);
      const factionCap = Math.floor(pop * ratio * fatigue);
      const factionUsed = recruitedByFaction.get(fid) ?? 0;
      const factionRemaining = Math.max(0, factionCap - factionUsed);
      const def = world.regions[cmd.regionId];
      const regionPop = def ? Math.floor(regionPopulation(def.baseManpower, st.development)) : 0;
      const regionCap = Math.floor(regionPop * ratio * fatigue);
      const regionUsed = recruitedByRegion.get(cmd.regionId) ?? 0;
      const regionRemaining = Math.max(0, regionCap - regionUsed);
      if (manpowerCost > regionRemaining || manpowerCost > factionRemaining) {
        ctx.reject(
          order,
          'CONSCRIPT_ABOVE_CAP',
          `征兵 ${manpowerCost} 超出上限：本区 ${cmd.regionId} 人口 ${regionPop}，本区剩余 ${regionRemaining}；全国剩余 ${factionRemaining}（总人口 ${pop}、比例 ${ratio}、疲劳 ${fatigue.toFixed(2)}）`,
        );
        return;
      }
      if (manpowerCost > f.manpower) {
        ctx.reject(order, 'INSUFFICIENT_MANPOWER', `兵源不足：需 ${manpowerCost}，现有 ${f.manpower}`);
        return;
      }
      if (goldCost > f.gold) {
        ctx.reject(order, 'INSUFFICIENT_GOLD', `征兵需 ${goldCost} 金，现有 ${f.gold}`);
        return;
      }
      if (foodCost > f.food) {
        ctx.reject(order, 'INSUFFICIENT_FOOD', `征兵需 ${foodCost} 粮，现有 ${f.food}`);
        return;
      }

      recruitedByRegion.set(cmd.regionId, regionUsed + manpowerCost);
      recruitedByFaction.set(fid, factionUsed + manpowerCost);
      ctx.mutate({ op: 'add_faction_gold', factionId: fid, delta: -goldCost, reason: `征${t.name} ${cmd.count}` });
      ctx.mutate({ op: 'add_faction_food', factionId: fid, delta: -foodCost, reason: `征${t.name} ${cmd.count}` });
      ctx.mutate({ op: 'add_faction_manpower', factionId: fid, delta: -manpowerCost, reason: `征${t.name} ${cmd.count}` });
      ctx.mutate({ op: 'set_conscript_streak', factionId: fid, streak: f.conscriptStreak + 1 });
      // ★全国民心越低，征兵在本区制造的动乱越大（地区性后果，不直接改全国民心）
      if (world.governance) {
        const { amount, factor } = amplifiedUnrest(
          world.governance.lowMoraleUnrest.recruitBase,
          f.morale,
          world.governance.lowMoraleUnrest,
        );
        if (amount > 0) {
          ctx.mutate({
            op: 'add_region_unrest',
            regionId: cmd.regionId,
            delta: amount,
            reason: `征兵扰民（全国民心 ${f.morale}，动乱×${factor.toFixed(2)}）`,
          });
        }
      }
      // ★unit id 必须确定性派生，不能用计数器或随机后缀，否则重放会生成不同 id
      const unitId = `u_${fid}_${ctx.turn}_${cmd.regionId}_${cmd.unitType}`;
      const existing = ctx.state.units[unitId];
      if (existing) {
        ctx.mutate({ op: 'add_unit_troops', unitId, delta: cmd.count, reason: `补充${t.name}` });
      } else {
        ctx.mutate({ op: 'spawn_unit', unitId, ownerId: fid, regionId: cmd.regionId, typeId: cmd.unitType, troops: cmd.count });
      }
      ctx.emit({ type: 'recruitment_completed', turn: ctx.turn, regionId: cmd.regionId, factionId: fid, unitType: cmd.unitType, count: cmd.count });
      anyRecruit.add(fid);
      return;
    }

    case 'disband': {
      const u = ctx.state.units[cmd.unitId];
      if (!u || u.ownerId !== fid) {
        ctx.reject(order, 'UNIT_NOT_OWNED', `部队 ${cmd.unitId} 不属于 ${fid}`);
        return;
      }
      if (cmd.count > u.troops) {
        ctx.reject(order, 'MALFORMED_PAYLOAD', `裁军 ${cmd.count} 超过现有兵力 ${u.troops}`);
        return;
      }
      if (u.garrisonOnly) {
        ctx.reject(order, 'GARRISON_LOCKED', '守城民兵不可裁撤或调动');
        return;
      }
      const t = world.unitTypes[u.typeId];
      const refund = t ? Math.round((t.recruitGold * cmd.count) / PER_THOUSAND * 0.5) : 0;
      ctx.mutate({ op: 'add_unit_troops', unitId: cmd.unitId, delta: -cmd.count, reason: '裁军' });
      // ★贼配军是买来的奴隶，不是本国平民：裁掉也不回兵源，防止“买奴→裁军”洗人口。
      if (u.title !== 'bandit_conscript') {
        ctx.mutate({ op: 'add_faction_manpower', factionId: fid, delta: cmd.count, reason: '裁军归农' });
      }
      if (refund > 0) ctx.mutate({ op: 'add_faction_gold', factionId: fid, delta: refund, reason: '裁军变卖装备' });
      return;
    }
  }
}
