/**
 * 治理模块 —— 地区基建与「基建 → 全国民心」的汇总。
 *
 * ★职责边界：
 *   · 基建是地区性的：降低本区动乱、提高本区人口增长；
 *   · 全国民心只通过「基建点」汇总获得小幅每回合提升，不按地区拆分成多份民心；
 *   · 征兵/战火造成的地区动乱放大在 economy/combat 里，按**全国民心**计算 ——
 *     本模块不重复收税、不改战斗，只做基建与被动治理。
 *
 * ★旧剧本不注册本模块，也没有 world.governance ⇒ 行为与旧版本完全一致。
 */
import type { FactionId, RegionId } from '../state.ts';
import { regionPopulation, regionsOf } from '../state.ts';
import type { AcceptedOrder, ResolveContext, RuleModule, StateSlice } from '../module.ts';

interface BuildInfrastructureCmd { kind: 'build_infrastructure'; regionId: RegionId }

export const governanceModule: RuleModule = {
  id: 'governance',
  version: 1,
  reads: [
    'regions.owner', 'regions.infrastructure', 'regions.unrest',
    'factions.gold', 'factions.morale', 'factions.manpower',
  ] as readonly StateSlice[],
  writes: [
    'regions.infrastructure', 'regions.unrest',
    'factions.gold', 'factions.morale', 'factions.manpower',
  ] as readonly StateSlice[],
  commands: ['build_infrastructure'],

  resolve(ctx: ResolveContext): void {
    const governance = ctx.world.governance;
    if (!governance) return;

    // ── 1. 基建命令（按 seatId 排序，保证同时提交下顺序确定）──
    const builds = [...ctx.orders]
      .filter((o) => o.kind === 'build_infrastructure')
      .sort((a, b) => (a.seatId === b.seatId ? 0 : a.seatId < b.seatId ? -1 : 1));
    for (const order of builds) {
      handleBuild(ctx, order, order.command as BuildInfrastructureCmd);
    }

    // ── 2. 被动治理：逐区动乱下降 + 逐区人口增长 + 全国基建点汇总 ──
    for (const fid of Object.keys(ctx.state.factions).sort()) {
      const faction = ctx.state.factions[fid];
      if (!faction || faction.eliminated) continue;
      let moralePoints = 0;
      let growth = 0;
      for (const rid of regionsOf(ctx.state, fid)) {
        const st = ctx.state.regions[rid];
        if (!st) continue;
        const def = governance.infrastructure.levels.find((l) => l.level === st.infrastructure);
        if (!def) continue;
        moralePoints += def.moralePoints;
        if (def.unrestReductionPerTurn > 0 && st.unrest > 0) {
          ctx.mutate({
            op: 'add_region_unrest',
            regionId: rid,
            delta: -def.unrestReductionPerTurn,
            reason: `基建安民（Lv${def.level} ${def.name}）`,
          });
        }
        const regionDef = ctx.world.regions[rid];
        if (regionDef) growth += regionPopulation(regionDef.baseManpower, st.development) * def.populationGrowthBonus;
      }
      const moraleBonus = Math.floor(moralePoints / governance.infrastructure.moralePointsPerTurnPoint);
      if (moraleBonus > 0) {
        ctx.mutate({
          op: 'add_faction_morale',
          factionId: fid,
          delta: moraleBonus,
          reason: `基建安民（${moralePoints} 基建点）`,
        });
      }
      const growthGain = Math.round(growth);
      if (growthGain > 0) {
        ctx.mutate({
          op: 'add_faction_manpower',
          factionId: fid,
          delta: growthGain,
          reason: '基建兴农（地区人口增长）',
        });
      }
    }
  },
};

function handleBuild(ctx: ResolveContext, order: AcceptedOrder, cmd: BuildInfrastructureCmd): void {
  const governance = ctx.world.governance;
  if (!governance) {
    ctx.reject(order, 'INFRASTRUCTURE_UNAVAILABLE', '本剧本未启用基建规则');
    return;
  }
  const fid: FactionId = order.factionId;
  const faction = ctx.state.factions[fid];
  if (!faction || faction.eliminated) {
    ctx.reject(order, 'UNKNOWN_FACTION', '势力不存在或已灭亡');
    return;
  }
  const st = ctx.state.regions[cmd.regionId];
  if (!st) {
    ctx.reject(order, 'UNKNOWN_REGION', `区域 ${cmd.regionId} 不存在`);
    return;
  }
  if (st.owner !== fid) {
    ctx.reject(order, 'REGION_NOT_OWNED', `${cmd.regionId} 不属于 ${fid}`);
    return;
  }
  const next = governance.infrastructure.levels.find((l) => l.level === st.infrastructure + 1);
  if (!next) {
    ctx.reject(order, 'INFRASTRUCTURE_MAXED', `${cmd.regionId} 基建已满（Lv${st.infrastructure}）`);
    return;
  }
  if (faction.gold < next.costGold) {
    ctx.reject(order, 'INSUFFICIENT_GOLD', `修建 ${cmd.regionId} 基建 Lv${next.level} 需 ${next.costGold} 金，现有 ${faction.gold}`);
    return;
  }
  ctx.mutate({ op: 'add_faction_gold', factionId: fid, delta: -next.costGold, reason: `修建基建 ${cmd.regionId} Lv${next.level}` });
  ctx.mutate({ op: 'set_region_infrastructure', regionId: cmd.regionId, infrastructure: next.level });
  if (next.unrestRelief > 0) {
    ctx.mutate({
      op: 'add_region_unrest',
      regionId: cmd.regionId,
      delta: -next.unrestRelief,
      reason: `基建落成（Lv${next.level} ${next.name}）`,
    });
  }
  if (governance.infrastructure.moraleOnBuild > 0) {
    ctx.mutate({
      op: 'add_faction_morale',
      factionId: fid,
      delta: governance.infrastructure.moraleOnBuild,
      reason: `基建落成（Lv${next.level} ${next.name}）`,
    });
  }
  ctx.emit({
    type: 'infrastructure_completed',
    turn: ctx.turn,
    regionId: cmd.regionId,
    factionId: fid,
    fromLevel: st.infrastructure,
    toLevel: next.level,
    goldSpent: next.costGold,
    unrestRelief: next.unrestRelief,
    moraleGained: governance.infrastructure.moraleOnBuild,
  });
}
