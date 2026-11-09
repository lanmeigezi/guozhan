/**
 * 自动起义模块（可选，当前仅 grand-front）。
 *
 * 状态机：
 *   动乱 100 → 原主失去区域（owner=null），本区人口化为低战力 rebel_militia；
 *   原主只能进攻杀光全部民兵后重占；
 *   民兵未死光前，民心更高的相邻势力可 claim_rebellion → 区域归附，
 *   unrest=90，最多保留 claimedGarrisonCap 守城民兵（garrisonOnly）；
 *   claim 后 claimedConscriptionTurns 回合内征兵 → 再次起义；
 *   claimedBy 区域动乱 ≤ normalizeUnrest → 恢复正常，解除守城锁定。
 *
 * ★旧剧本没有 world.rebellion 且 moduleOrder 不注册本模块 ⇒ 行为完全不变。
 */
import type { FactionId, GameState, RebellionState, RegionId, UnitId, WorldConfig } from '../state.ts';
import { rebelTroopsInRegion, regionPopulation, unitsIn } from '../state.ts';
import type { AcceptedOrder, ResolveContext, RuleModule, StateSlice } from '../module.ts';
import { nearestOwnedRegion } from './combat.ts';

interface ClaimRebellionCmd { kind: 'claim_rebellion'; regionId: RegionId }

export const rebelUnitId = (turn: number, regionId: RegionId): UnitId => `u_rebels_${turn}_${regionId}`;
export const rebelGarrisonUnitId = (factionId: FactionId, turn: number, regionId: RegionId): UnitId =>
  `u_${factionId}_${turn}_${regionId}_rebel_garrison`;

export const rebellionModule: RuleModule = {
  id: 'rebellion',
  version: 1,
  reads: [
    'regions.owner',
    'regions.unrest',
    'regions.rebellion',
    'factions.morale',
    'factions.eliminated',
    'units.regionId',
    'units.troops',
  ] as readonly StateSlice[],
  writes: [
    'regions.owner',
    'regions.unrest',
    'regions.rebellion',
    'units.regionId',
    'units.troops',
  ] as readonly StateSlice[],
  commands: ['claim_rebellion'],

  resolve(ctx: ResolveContext): void {
    const cfg = ctx.world.rebellion;
    if (!cfg) return;

    // 1. 已归附区域：动乱降到阈值 → 恢复正常（先于宣称，避免“低动乱还能被宣称”）
    for (const rid of Object.keys(ctx.state.regions).sort()) {
      const st = ctx.state.regions[rid]!;
      const reb = st.rebellion;
      if (!reb?.claimedBy) continue;
      if (st.owner !== reb.claimedBy) continue;
      if (st.unrest > cfg.normalizeUnrest) continue;
      for (const u of unitsIn(ctx.state, rid)) {
        if (u.title === 'rebel_garrison' || u.title === 'rebel_militia') {
          ctx.mutate({ op: 'set_unit_garrison', unitId: u.id, garrisonOnly: false, title: null });
        }
      }
      ctx.mutate({ op: 'set_region_rebellion', regionId: rid, rebellion: null });
      ctx.emit({
        type: 'rebellion_ended',
        turn: ctx.turn,
        regionId: rid,
        faction: reb.claimedBy,
        reason: 'unrest_recovered',
      });
    }

    // 2. 外交宣称
    const claims = [...ctx.orders]
      .filter((o) => o.kind === 'claim_rebellion')
      .sort((a, b) => (a.seatId === b.seatId ? 0 : a.seatId < b.seatId ? -1 : 1));
    for (const order of claims) handleClaim(ctx, order, order.command as ClaimRebellionCmd);

    // 3. 归附后窗口期内征兵 → 再次起义
    const triggered = new Set<RegionId>();
    for (const order of ctx.orders) {
      if (order.kind !== 'recruit') continue;
      const rid = String((order.command as { regionId?: unknown }).regionId ?? '');
      if (triggered.has(rid)) continue;
      const st = ctx.state.regions[rid];
      const reb = st?.rebellion;
      if (!st || !reb?.claimedBy) continue;
      if (st.owner !== reb.claimedBy || order.factionId !== reb.claimedBy) continue;
      const claimedTurn = reb.claimedTurn ?? ctx.turn;
      // 宣称当回合不触发；从下一回合起 claimedConscriptionTurns 个回合内有效
      if (ctx.turn <= claimedTurn) continue;
      if (ctx.turn - claimedTurn > cfg.claimedConscriptionTurns) continue;
      triggered.add(rid);
      triggerUprising(ctx, rid, reb.claimedBy, 'claimed_conscription');
    }

    // 4. 动乱达到 100 的新起义
    for (const rid of Object.keys(ctx.state.regions).sort()) {
      const st = ctx.state.regions[rid]!;
      if (st.rebellion || st.owner === null) continue;
      if (st.unrest < 100) continue;
      triggerUprising(ctx, rid, st.owner, 'unrest');
    }
  },
};

function handleClaim(ctx: ResolveContext, order: AcceptedOrder, cmd: ClaimRebellionCmd): void {
  const cfg = ctx.world.rebellion!;
  const st = ctx.state.regions[cmd.regionId];
  if (!st) {
    ctx.reject(order, 'UNKNOWN_REGION', `区域 ${cmd.regionId} 不存在`);
    return;
  }
  const reb = st.rebellion;
  if (!reb || st.owner !== null || reb.claimedBy !== undefined) {
    ctx.reject(order, 'REBELLION_NOT_ACTIVE', `${cmd.regionId} 当前没有可宣称的起义政权`);
    return;
  }
  const claimant = ctx.state.factions[order.factionId];
  if (!claimant || claimant.eliminated) {
    ctx.reject(order, 'UNKNOWN_FACTION', '宣称势力不存在或已灭亡');
    return;
  }
  if (order.factionId === reb.from) {
    ctx.reject(order, 'SELF_TARGET_NOT_ALLOWED', '原属国不能宣称自己的起义区；请用进攻杀光民兵后重占');
    return;
  }
  const original = ctx.state.factions[reb.from];
  const originalMorale = original?.morale ?? 0;
  if (claimant.morale <= originalMorale + cfg.claimMoraleLead) {
    ctx.reject(
      order,
      'CLAIM_MORALE_TOO_LOW',
      `宣称需要民心高于原属国 ${reb.from}（${originalMorale}）：当前 ${claimant.morale}`,
    );
    return;
  }
  if (cfg.claimRequiresAdjacency && !hasAdjacentOwned(ctx.state, ctx.world, order.factionId, cmd.regionId)) {
    ctx.reject(order, 'REGION_NOT_ADJACENT', `宣称国必须与 ${cmd.regionId} 相邻`);
    return;
  }
  const rebelTroops = rebelTroopsInRegion(ctx.state, cmd.regionId);
  if (rebelTroops <= 0) {
    ctx.reject(order, 'REBELLION_ALREADY_ENDED', '起义民兵已全部阵亡，无法宣称；请由原属国重新占领');
    return;
  }

  // 解散起义军，建立归附政权
  for (const u of unitsIn(ctx.state, cmd.regionId)) {
    ctx.mutate({ op: 'destroy_unit', unitId: u.id, reason: '起义区归附，旧起义军解散' });
  }
  ctx.mutate({ op: 'set_region_owner', regionId: cmd.regionId, owner: order.factionId });
  ctx.mutate({
    op: 'set_region_rebellion',
    regionId: cmd.regionId,
    rebellion: { from: reb.from, sinceTurn: reb.sinceTurn, claimedBy: order.factionId, claimedTurn: ctx.turn },
  });
  setUnrest(ctx, cmd.regionId, cfg.claimedUnrest);
  const garrison = Math.min(cfg.claimedGarrisonCap, rebelTroops);
  if (garrison > 0) {
    ctx.mutate({
      op: 'spawn_unit',
      unitId: uniqueUnitId(ctx.state, rebelGarrisonUnitId(order.factionId, ctx.turn, cmd.regionId)),
      ownerId: order.factionId,
      regionId: cmd.regionId,
      typeId: cfg.rebelUnitType,
      troops: garrison,
      title: 'rebel_garrison',
      garrisonOnly: true,
    });
  }
  ctx.emit({
    type: 'rebellion_claimed',
    turn: ctx.turn,
    regionId: cmd.regionId,
    claimant: order.factionId,
    original: reb.from,
    garrison,
    unrest: cfg.claimedUnrest,
    conscriptionTurns: cfg.claimedConscriptionTurns,
  });
}

function triggerUprising(
  ctx: ResolveContext,
  regionId: RegionId,
  from: FactionId,
  cause: 'unrest' | 'claimed_conscription',
): void {
  const cfg = ctx.world.rebellion!;
  const st = ctx.state.regions[regionId];
  const def = ctx.world.regions[regionId];
  if (!st || !def) return;
  const existing = st.rebellion;

  // 原主军队：普通起义时撤往最近己方区域；归附后征兵再叛乱时，征兵军被起义吞没。
  for (const u of unitsIn(ctx.state, regionId)) {
    if (u.ownerId === from && cause === 'unrest') {
      const retreat = nearestOwnedRegion(
        ctx,
        ctx.world,
        regionId,
        from,
        ctx.world.movement.routRetreatMaxDistance,
        ctx.world.unitTypes[u.typeId],
      );
      if (retreat && retreat !== regionId) {
        ctx.mutate({ op: 'move_unit', unitId: u.id, toRegion: retreat, path: [regionId, retreat], movementSpent: 0 });
      } else {
        ctx.mutate({ op: 'destroy_unit', unitId: u.id, reason: '起义爆发，驻军溃散' });
      }
    } else {
      ctx.mutate({ op: 'destroy_unit', unitId: u.id, reason: cause === 'unrest' ? '起义爆发，外来驻军被逐' : '征兵激起再叛乱，征兵军哗变' });
    }
  }

  ctx.mutate({ op: 'set_region_owner', regionId, owner: null });
  const rebellion: RebellionState = { from, sinceTurn: ctx.turn };
  ctx.mutate({ op: 'set_region_rebellion', regionId, rebellion });
  setUnrest(ctx, regionId, 100);

  const pop = Math.floor(regionPopulation(def.baseManpower, st.development));
  const troops = Math.max(1, Math.floor(pop * cfg.levyRatio));
  ctx.mutate({
    op: 'spawn_unit',
    unitId: uniqueUnitId(ctx.state, rebelUnitId(ctx.turn, regionId)),
    ownerId: 'neutral',
    regionId,
    typeId: cfg.rebelUnitType,
    troops,
    title: 'rebel_militia',
    garrisonOnly: true,
  });
  ctx.emit({
    type: 'rebellion_started',
    turn: ctx.turn,
    regionId,
    original: from,
    cause,
    rebelTroops: troops,
    ...(existing?.claimedBy ? { claimedBy: existing.claimedBy } : {}),
  });
}

function hasAdjacentOwned(
  state: GameState,
  world: WorldConfig,
  factionId: FactionId,
  regionId: RegionId,
): boolean {
  for (const n of world.regions[regionId]?.adjacency ?? []) {
    if (state.regions[n]?.owner === factionId) return true;
  }
  return false;
}

function setUnrest(ctx: ResolveContext, regionId: RegionId, target: number): void {
  const current = ctx.state.regions[regionId]?.unrest ?? 0;
  const delta = Math.max(0, Math.min(100, target)) - current;
  if (delta !== 0) {
    ctx.mutate({ op: 'add_region_unrest', regionId, delta, reason: '起义/归附改变动乱' });
  }
}

function uniqueUnitId(state: GameState, base: UnitId): UnitId {
  if (!state.units[base]) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}_${i}`;
    if (!state.units[candidate]) return candidate;
  }
  return `${base}_x`;
}
