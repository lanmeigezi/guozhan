/**
 * 战斗模块 —— 确定性结算 + 完整掷骰证据（P6 ExecutionEvidence）。
 *
 * ★三条从调研里换来的铁律：
 *
 * 1. **"LLM narrates, code decides"**（Histrategy state_applier）。
 *    城池易手由 `兵力比 + 守方士气 + 邻接` 三个确定性条件裁决，
 *    LLM 的 result 字符串**根本不是门**。Histrategy 曾因为拿 LLM 的词表
 *    (decisive_victory/crushing_defeat) 去匹配硬编码的 ("attack_win","rout")
 *    而**静默否决了每一次夺城**，把地图冻成永久僵局。
 *
 * 2. **掷骰证据随事件下发，客户端只播放不 roll**（aonw ExecutionEvidence）。
 *    tavern-battle-mcp 实战用 CryptoRng 导致战报无法复核、争议无法仲裁 —— 我们不重蹈。
 *    种子 = f(rootSeed, turn, attacker, defender, region)，任何人拿证据都能复算。
 *
 * 3. **确定性真相回写记录**（Histrategy P0-1）。
 *    证据里的 captured / outcome 就是最终事实，不允许叙事层另说一套，
 *    否则会出现"战报说僵持、城池却易手"的记录/状态永久脱节。
 */
import type { FactionId, GameState, RegionId, UnitId, UnitTypeDef, WorldConfig } from '../state.ts';
import { getRelation, isAttackAdjacent, isInfantryType, terrainTraits, unitsIn, waterRouteNeighbors, waterRoutePath } from '../state.ts';
import { amplifiedUnrest, unrestDefenseFactor } from '../unrest.ts';
import type { AcceptedOrder, ResolveContext, RuleModule, StateSlice } from '../module.ts';
import { rollDice, type DeterministicRng } from '../rng.ts';
import { GRUDGE_BATTLE, GRUDGE_CAPTURE, GRUDGE_WAR_DECLARATION } from './grudge.ts';

interface AttackCmd {
  kind: 'attack';
  unitId: UnitId;
  targetRegion: RegionId;
  /** movement 模块先把部队机动到这里，再执行本场进攻 */
  moveTo?: RegionId;
  commitment?: number;
}

const NEUTRAL = 'neutral';

/** 守方地形对步兵的额外乘数（只作用于 defense；旧剧本无 traits 时恒为 1） */
function infantryTerrainMultiplier(world: WorldConfig, regionId: RegionId): number {
  return terrainTraits(world.regions[regionId]?.terrain ?? 'plains').infantryDefense;
}

interface Side {
  factionId: FactionId;
  unitIds: UnitId[];
  troops: number;
  power: number;
}

/** 克制加成：攻击方兵种对被击方兵种的 counters 取最大值（多兵种混编时取最有利的） */
function counterBonus(world: WorldConfig, attackerType: string, defenderTypes: readonly string[]): number {
  const t = world.unitTypes[attackerType];
  if (!t?.counters) return 1;
  let best = 0;
  for (const dt of defenderTypes) {
    const b = t.counters[dt];
    if (b !== undefined && b > best) best = b;
  }
  return 1 + best;
}

function moraleFactor(morale: number, coefficient: number): number {
  return 0.5 + morale / coefficient;
}

/** 攻城器械削弱要塞加成（见 units.json 的 siege 注释） */
function fortMultiplier(world: WorldConfig, fortLevel: number, attackerTypes: readonly string[]): number {
  const base = 1 + fortLevel * world.combat.fortBonusPerLevel;
  if (fortLevel === 0) return 1;
  const hasSiege = attackerTypes.includes('siege');
  if (!hasSiege) return base;
  const negation = world.combat.siegeNegatesFort;
  return 1 + (base - 1) * (1 - negation);
}

function lawCombatMultiplier(world: WorldConfig, laws: readonly string[]): number {
  let m = 1;
  for (const id of [...laws].sort()) {
    const v = world.laws[id]?.effects.combatPowerMultiplier;
    if (v !== undefined) m *= v;
  }
  return m;
}

function sumPower(
  world: WorldConfig,
  ctx: ResolveContext,
  unitIds: readonly UnitId[],
  stat: 'attack' | 'defense',
  factionId: FactionId,
  opts: { terrainDef?: number; fort?: number; enemyTypes?: readonly string[] } = {},
): number {
  const faction = ctx.state.factions[factionId];
  const morale = faction ? moraleFactor(faction.morale, world.combat.moraleCoefficient) : 1;
  const laws = faction ? lawCombatMultiplier(world, faction.laws) : 1;
  let total = 0;
  for (const uid of unitIds) {
    const u = ctx.state.units[uid];
    if (!u) continue;
    const t = world.unitTypes[u.typeId];
    if (!t) continue;
    const bonus = opts.enemyTypes ? counterBonus(world, u.typeId, opts.enemyTypes) : 1;
    total += u.troops * t[stat] * bonus;
  }
  const terrain = opts.terrainDef ?? 1;
  const fort = opts.fort ?? 1;
  return total * morale * laws * terrain * fort;
}

/** 从某区域出发，BFS 找最近的己方区域（溃败撤退用）。距离上限内找不到则返回 null */
export function nearestOwnedRegion(
  ctx: ResolveContext,
  world: WorldConfig,
  from: RegionId,
  owner: FactionId,
  maxDistance: number,
  unitType?: UnitTypeDef,
): RegionId | null {
  const domain = unitType?.domain ?? 'land';
  const queue: Array<{ id: RegionId; d: number }> = [{ id: from, d: 0 }];
  const seen = new Set<RegionId>([from]);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur.d > 0 && ctx.state.regions[cur.id]?.owner === owner) {
      // 水师只能撤到港口，不能因为溃败被拖上岸后永久搁浅
      if (domain !== 'water' || world.regions[cur.id]?.port === true) return cur.id;
    }
    if (cur.d >= maxDistance) continue;
    const neighbors = domain === 'water'
      ? waterRouteNeighbors(world, cur.id)
      : domain === 'amphibious'
        ? [...new Set([...(world.regions[cur.id]?.adjacency ?? []), ...waterRouteNeighbors(world, cur.id)])].sort()
        : (world.regions[cur.id]?.adjacency ?? []);
    for (const n of neighbors) {
      if (seen.has(n)) continue;
      seen.add(n);
      queue.push({ id: n, d: cur.d + 1 });
    }
  }
  return null;
}

/**
 * 战力对比预估 —— **供 legal.ts 生成"给 LLM 看的数字"用**。
 *
 * ★这是 P13 的关键落点：数值由代码算，LLM 只消费结果。
 * 绝不让 LLM 自己估战力（它算不准，且会被话术影响）。
 * 返回的 powerRatio > 1 表示攻方占优。
 */
export function estimateBattle(
  ctx: { state: GameState; world: WorldConfig },
  attackerId: FactionId,
  attackerUnitIds: readonly UnitId[],
  targetRegion: RegionId,
): {
  attackerPower: number;
  defenderPower: number;
  powerRatio: number;
  defenderTroops: number;
  attackerType: string;
  defenderTypes: readonly string[];
  /** 攻方对守军的兵种克制乘数（1.5 = +50%） */
  attackerCounterBonus: number;
  /** 守军对攻方的兵种克制乘数 */
  defenderCounterBonus: number;
  /** 守方地形对步兵的额外乘数（1.15 = 林地步兵 +15%） */
  terrainInfantryDefense: number;
} {
  const { state, world } = ctx;
  const region = state.regions[targetRegion];
  const def = world.regions[targetRegion];
  const defenderId = region?.owner ?? NEUTRAL;
  const defenderUnits = unitsIn(state, targetRegion).map((u) => u.id);
  const attackerTypes = attackerUnitIds.map((id) => state.units[id]?.typeId ?? '').filter(Boolean);
  const defenderTypes = defenderUnits.map((id) => state.units[id]?.typeId ?? '').filter(Boolean);
  const terrainMod = def ? (world.combat.terrainModifier[def.terrain]?.def ?? 1) : 1;
  const fortMod = fortMultiplier(world, region?.fortLevel ?? 0, attackerTypes);
  const atkMorale = moraleFactor(state.factions[attackerId]?.morale ?? 60, world.combat.moraleCoefficient);
  const defMorale = moraleFactor(state.factions[defenderId]?.morale ?? 60, world.combat.moraleCoefficient);
  // ★地区动乱削弱本区守备；旧剧本无 governance ⇒ 乘数恒为 1
  const defUnrest = unrestDefenseFactor(world.governance, region?.unrest ?? 0);
  const terrainInfantry = infantryTerrainMultiplier(world, targetRegion);

  const atkTroops = attackerUnitIds.reduce((s, id) => s + (state.units[id]?.troops ?? 0), 0);
  const defTroops = defenderUnits.reduce((s, id) => s + (state.units[id]?.troops ?? 0), 0);

  const attackerPower = computePower(world, { state } as ResolveContext, attackerUnitIds, 'attack', attackerId, atkTroops, Math.max(1, atkTroops), {
    enemyTypes: defenderTypes, moraleF: atkMorale,
  });
  const defenderPower = computePower(world, { state } as ResolveContext, defenderUnits, 'defense', defenderId, defTroops, Math.max(1, defTroops), {
    enemyTypes: attackerTypes, moraleF: defMorale, terrainDef: terrainMod, fort: fortMod, unrestDef: defUnrest,
    infantryTerrain: terrainInfantry,
  });
  const attackerType = attackerTypes[0] ?? '';
  const attackerCounterBonus = attackerType ? counterBonus(world, attackerType, defenderTypes) : 1;
  const defenderCounterBonus = defenderTypes.length > 0
    ? Math.max(...defenderTypes.map((dt) => counterBonus(world, dt, attackerTypes)))
    : 1;
  return {
    attackerPower: Math.round(attackerPower),
    defenderPower: Math.round(defenderPower),
    powerRatio: defenderPower > 0 ? Math.round((attackerPower / defenderPower) * 1000) / 1000 : 999,
    defenderTroops: defTroops,
    attackerType,
    defenderTypes,
    attackerCounterBonus,
    defenderCounterBonus,
    terrainInfantryDefense: terrainInfantry,
  };
}

export const combatModule: RuleModule = {
  id: 'combat',
  version: 1,
  reads: ['units.troops', 'units.regionId', 'regions.owner', 'regions.fortLevel', 'regions.unrest', 'regions.rebellion', 'factions.morale', 'factions.laws', 'relations'] as readonly StateSlice[],
  writes: ['units.troops', 'units.regionId', 'regions.owner', 'regions.unrest', 'regions.rebellion', 'factions.morale', 'relations'] as readonly StateSlice[],
  commands: ['attack'],

  resolve(ctx: ResolveContext): void {
    const { world } = ctx;
    const c = world.combat;
    const attacks = [...ctx.orders]
      .filter((o) => o.kind === 'attack')
      .sort((a, b) => (a.seatId === b.seatId ? 0 : a.seatId < b.seatId ? -1 : 1));

    // 一支部队每回合只能发起一次进攻（移动模块负责“移动一次”，这里负责“进攻一次”；
    // 同一回合仍允许先移动再进攻）。UI/启发式虽然会去重，但 core 必须自己兜底。
    const attackedUnits = new Set<UnitId>();
    for (const order of attacks) {
      const cmd = order.command as AttackCmd;
      if (attackedUnits.has(cmd.unitId)) {
        ctx.reject(order, 'MALFORMED_PAYLOAD', `部队 ${cmd.unitId} 本回合已经发起过进攻`);
        continue;
      }
      attackedUnits.add(cmd.unitId);
      resolveOneAttack(ctx, order, cmd);
    }
    void c;
  },
};

function resolveOneAttack(ctx: ResolveContext, order: AcceptedOrder, cmd: AttackCmd): void {
  const { world } = ctx;
  const c = world.combat;
  const attackerId = order.factionId;

  const unit = ctx.state.units[cmd.unitId];
  if (!unit || unit.ownerId !== attackerId) {
    ctx.reject(order, 'UNIT_NOT_OWNED', `部队 ${cmd.unitId} 不属于 ${attackerId}`);
    return;
  }
  if (unit.garrisonOnly) {
    ctx.reject(order, 'GARRISON_LOCKED', `部队 ${cmd.unitId} 是守城民兵，不能出击`);
    return;
  }
  const target = ctx.state.regions[cmd.targetRegion];
  const targetDef = world.regions[cmd.targetRegion];
  if (!target || !targetDef) {
    ctx.reject(order, 'UNKNOWN_REGION', `区域 ${cmd.targetRegion} 不存在`);
    return;
  }
  if (cmd.moveTo && unit.regionId !== cmd.moveTo) {
    ctx.reject(order, 'MOVE_NOT_RESOLVED', `部队 ${cmd.unitId} 未能先机动到 ${cmd.moveTo}，取消进攻`);
    return;
  }
  const attackerType = world.unitTypes[unit.typeId];
  if (c.requireAdjacency && !isAttackAdjacent(world, attackerType, unit.regionId, cmd.targetRegion)) {
    ctx.reject(order, 'REGION_NOT_ADJACENT', `${unit.regionId} 与 ${cmd.targetRegion} 不相邻，无法进攻`);
    return;
  }
  if (target.owner === attackerId) {
    ctx.reject(order, 'SELF_TARGET_NOT_ALLOWED', '不能进攻自己的领土');
    return;
  }
  // 未归附的起义区只允许原属国进攻；其他国家只能走 claim_rebellion
  const rebellion = target.rebellion;
  if (target.owner === null && rebellion && attackerId !== rebellion.from) {
    ctx.reject(order, 'REBELLION_NOT_YOURS', `起义区 ${cmd.targetRegion} 只允许原属国 ${rebellion.from} 进攻；其他国家请使用宣称`);
    return;
  }

  const defenderId: FactionId = target.owner ?? NEUTRAL;
  const originRegion = unit.regionId;
  // 水师/两栖沿水路打 1-2 格时，夺城进驻要走完整航线，不能瞬移穿过中间港口
  const waterPath = (attackerType?.domain === 'water' || attackerType?.domain === 'amphibious')
    ? waterRoutePath(world, originRegion, cmd.targetRegion, 2)
    : null;
  const attackPath = waterPath ?? [originRegion, cmd.targetRegion];

  // 进攻非中立势力 ⇒ 自动进入战争状态（Diplomacy 式：行动即宣战，免去"忘了宣战"的挫败）
  const startedWar = target.owner !== null && getRelation(ctx.state, attackerId, target.owner) !== 'war';
  if (startedWar && target.owner !== null) {
    ctx.mutate({ op: 'set_relation', a: attackerId, b: target.owner, kind: 'war' });
    if (ctx.world.capabilities?.grudge === true) {
      ctx.mutate({
        op: 'add_relation_grudge',
        a: attackerId,
        b: target.owner,
        delta: GRUDGE_WAR_DECLARATION,
        reason: '兵戎相见',
      });
    }
  }
  if (defenderId !== NEUTRAL && defenderId !== attackerId && ctx.world.capabilities?.grudge === true) {
    ctx.mutate({
      op: 'add_relation_grudge',
      a: attackerId,
      b: defenderId,
      delta: GRUDGE_BATTLE,
      reason: '交战结仇',
    });
  }

  // ── 集结双方兵力 ──
  // 线协议已把 commitment 限在 0.1-1；这里再钳一次，保证直接调用 core 的
  // 测试/插件也不会出现 0、负数、NaN 或超过全部兵力。
  const rawCommitment = typeof cmd.commitment === 'number' && Number.isFinite(cmd.commitment)
    ? cmd.commitment
    : 1;
  const commitment = Math.min(1, Math.max(0.1, rawCommitment));
  const attackerUnits = [cmd.unitId];
  const attackerTroopsTotal = unit.troops;
  const committed = Math.max(1, Math.round(attackerTroopsTotal * commitment));

  const defenderUnits = unitsIn(ctx.state, cmd.targetRegion).map((u) => u.id);
  const defenderTroopsTotal = defenderUnits.reduce((s, id) => s + (ctx.state.units[id]?.troops ?? 0), 0);

  const attackerTypes = attackerUnits.map((id) => ctx.state.units[id]?.typeId ?? '').filter(Boolean);
  const defenderTypes = defenderUnits.map((id) => ctx.state.units[id]?.typeId ?? '').filter(Boolean);

  const terrainMod = c.terrainModifier[targetDef.terrain]?.def ?? 1;
  const fortMod = fortMultiplier(world, target.fortLevel, attackerTypes);
  const defenderMorale = ctx.state.factions[defenderId]?.morale ?? 60;
  const attackerMorale = ctx.state.factions[attackerId]?.morale ?? 60;

  const atkMoraleF = moraleFactor(attackerMorale, c.moraleCoefficient);
  const defMoraleF = moraleFactor(defenderMorale, c.moraleCoefficient);
  // ★地区动乱削弱本区守备（地区性后果；旧剧本乘数恒为 1）
  const defUnrestF = unrestDefenseFactor(world.governance, target.unrest);
  const terrainInfantryF = infantryTerrainMultiplier(world, cmd.targetRegion);

  // ── 确定性掷骰 ──
  const rng: DeterministicRng = ctx.rng('combat', attackerId, defenderId, cmd.targetRegion);
  const seed = rng.seed;

  let atkTroops = committed;
  let defTroops = defenderTroopsTotal;
  const atkStart = committed;
  const defStart = defenderTroopsTotal;
  const rounds: Array<{
    round: number; attackRoll: number; defenseRoll: number;
    modifiers: { terrain: number; fort: number; moraleAttacker: number; moraleDefender: number; unrestDefender: number; infantryDefender: number };
    attackerLosses: number; defenderLosses: number;
  }> = [];

  let atkPower = 0;
  let defPower = 0;
  let outcome: 'attacker_win' | 'defender_win' | 'stalemate' | 'attacker_rout' | 'defender_rout' = 'stalemate';

  for (let round = 1; round <= c.maxRounds; round++) {
    atkPower = computePower(world, ctx, attackerUnits, 'attack', attackerId, atkTroops, attackerTroopsTotal, {
      enemyTypes: defenderTypes, moraleF: atkMoraleF,
    });
    defPower = computePower(world, ctx, defenderUnits, 'defense', defenderId, defTroops, defenderTroopsTotal, {
      enemyTypes: attackerTypes, moraleF: defMoraleF, terrainDef: terrainMod, fort: fortMod, unrestDef: defUnrestF,
      infantryTerrain: terrainInfantryF,
    });
    if (atkPower <= 0 || defPower <= 0) break;

    const ratio = atkPower / defPower;
    const atkDice = rollDice(rng, c.dicePerRound, c.diceSides);
    const defDice = rollDice(rng, c.dicePerRound, c.diceSides);
    const meanRoll = (c.dicePerRound * (c.diceSides + 1)) / 2;
    const atkLuck = atkDice.total / meanRoll;
    const defLuck = defDice.total / meanRoll;

    const defLoss = Math.min(
      defTroops,
      Math.round(defTroops * c.casualtyBaseRate * clampRatio(ratio) * atkLuck * c.attackerExposure),
    );
    const atkLoss = Math.min(
      atkTroops,
      Math.round(atkTroops * c.casualtyBaseRate * clampRatio(1 / ratio) * defLuck * c.defenderExposure),
    );

    defTroops -= defLoss;
    atkTroops -= atkLoss;

    rounds.push({
      round,
      attackRoll: atkDice.total,
      defenseRoll: defDice.total,
      modifiers: {
        terrain: terrainMod,
        fort: fortMod,
        moraleAttacker: round2(atkMoraleF),
        moraleDefender: round2(defMoraleF),
        unrestDefender: round2(defUnrestF),
        infantryDefender: round2(terrainInfantryF),
      },
      attackerLosses: atkLoss,
      defenderLosses: defLoss,
    });

    if (defTroops <= 0) { outcome = 'attacker_win'; break; }
    if (atkTroops <= 0) { outcome = 'defender_win'; break; }
    if (defStart > 0 && defTroops < defStart * c.routThresholdRatio) { outcome = 'defender_rout'; break; }
    if (atkStart > 0 && atkTroops < atkStart * c.routThresholdRatio) { outcome = 'attacker_rout'; break; }
  }
  if (atkTroops <= 0) outcome = 'defender_win';
  else if (defTroops <= 0) outcome = 'attacker_win';

  // 溃败方额外伤亡
  if (outcome === 'defender_rout') {
    defTroops = Math.max(0, Math.round(defTroops / c.routMultiplier));
  } else if (outcome === 'attacker_rout') {
    atkTroops = Math.max(0, Math.round(atkTroops / c.routMultiplier));
  }

  // ── 夺城裁决：★确定性三条件，LLM 的意见在此毫无话语权 ──
  const powerRatio = defPower > 0 ? atkPower / defPower : atkPower > 0 ? Number.POSITIVE_INFINITY : 1;
  const adjacencyOk = !c.requireAdjacency || isAttackAdjacent(world, attackerType, originRegion, cmd.targetRegion);
  const forcePermits = defTroops === 0 || atkPower > defPower * c.capturePowerRatio;
  const moraleCollapse = defenderMorale < c.moraleCollapseThreshold;
  const defeated = outcome === 'attacker_win' || outcome === 'defender_rout';
  let captureReason: 'force_ratio' | 'morale_collapse' | 'not_authorized' | 'not_adjacent' = 'not_authorized';
  let captured = false;
  if (defeated && atkTroops > 0) {
    if (!adjacencyOk) captureReason = 'not_adjacent';
    else if (defTroops === 0 || forcePermits) { captured = true; captureReason = 'force_ratio'; }
    else if (moraleCollapse) { captured = true; captureReason = 'morale_collapse'; }
  }
  // ★未归附的起义区必须先杀光全部民兵才能占领，不能因战力比/低民心提前夺城；
  //   已归附区域是正常势力领土，按普通夺城规则结算。
  if (captured && rebellion && target.owner === null && defTroops > 0) {
    captured = false;
    captureReason = 'not_authorized';
  }
  // ★开荒地块只能通过“派兵进入 + 完成基建”占领；普通进攻只能驱散原住民
  if (captured && target.owner === null && ctx.world.frontier && !rebellion) {
    captured = false;
    captureReason = 'not_authorized';
  }

  // ── 施加损失 ──
  applyAttackerLosses(ctx, attackerUnits, attackerTroopsTotal, atkTroops, committed);
  applyDefenderLosses(ctx, defenderUnits, defenderTroopsTotal, defTroops);

  // ★收复故土：该区上一任领主就是攻方（先被夺走、现在打回来）
  const recaptured = captured && target.owner !== null && target.lastOwner === attackerId;
  // ── 夺城 / 溃退 ──
  if (captured) {
    // 守城民兵是本地人，城破即覆灭；不能带着 garrisonOnly 头衔撤到别处
    for (const uid of defenderUnits) {
      const u = ctx.state.units[uid];
      if (u?.title === 'rebel_garrison') {
        ctx.mutate({ op: 'destroy_unit', unitId: uid, reason: '城破，守城民兵覆灭' });
      }
    }
    ctx.mutate({ op: 'set_region_owner', regionId: cmd.targetRegion, owner: attackerId });
    // 守军残部撤退或消散（按各自作战域找撤离点：水师只撤到己方港口）
    for (const uid of defenderUnits) {
      const u = ctx.state.units[uid];
      if (!u || u.troops <= 0) continue;
      const retreatTo = target.owner
        ? nearestOwnedRegion(
            ctx, world, cmd.targetRegion, target.owner, world.movement.routRetreatMaxDistance,
            world.unitTypes[u.typeId],
          )
        : null;
      if (retreatTo) ctx.mutate({ op: 'move_unit', unitId: uid, toRegion: retreatTo, path: [cmd.targetRegion, retreatTo], movementSpent: 0 });
      else ctx.mutate({ op: 'destroy_unit', unitId: uid, reason: '城破，残部溃散' });
    }
    // 攻方投入的部队进驻；未投入部分留在原区
    ctx.mutate({ op: 'move_unit', unitId: cmd.unitId, toRegion: cmd.targetRegion, path: attackPath, movementSpent: 0 });
    ctx.emit({ type: 'region_captured', turn: ctx.turn, regionId: cmd.targetRegion, from: target.owner, to: attackerId, reason: captureReason === 'morale_collapse' ? 'morale_collapse' : 'force_ratio' });
    ctx.mutate({ op: 'add_faction_morale', factionId: attackerId, delta: 5, reason: `攻取 ${targetDef.name}` });
    // ★收复失地：夺回自己的旧土，额外民心加成（只在启用治理模块的剧本生效）
    if (recaptured && ctx.world.governance) {
      ctx.mutate({ op: 'add_faction_morale', factionId: attackerId, delta: 6, reason: `收复故土 ${targetDef.name}（民心大振）` });
    }
    if (target.owner) ctx.mutate({ op: 'add_faction_morale', factionId: target.owner, delta: -8, reason: `失守 ${targetDef.name}` });
    if (target.owner && ctx.world.capabilities?.grudge === true) {
      ctx.mutate({
        op: 'add_relation_grudge',
        a: attackerId,
        b: target.owner,
        delta: GRUDGE_CAPTURE,
        reason: `夺城结仇（${targetDef.name}）`,
      });
    }
  } else if (outcome === 'defender_rout' || outcome === 'attacker_rout') {
    const routed = outcome === 'defender_rout' ? defenderId : attackerId;
    if (routed === defenderId && target.owner) {
      for (const uid of defenderUnits) {
        const u = ctx.state.units[uid];
        if (!u || u.troops <= 0) continue;
        // 守城民兵不离开本区；即使野战溃败也留在城内
        if (u.garrisonOnly) continue;
        const retreatTo = nearestOwnedRegion(
          ctx, world, cmd.targetRegion, target.owner, world.movement.routRetreatMaxDistance,
          world.unitTypes[u.typeId],
        );
        if (retreatTo) ctx.mutate({ op: 'move_unit', unitId: uid, toRegion: retreatTo, path: [cmd.targetRegion, retreatTo], movementSpent: 0 });
      }
    }
  }

  // ── 守城成功：挡住了进攻（击退/守住），守方士气加成 ──
  //   ★只在启用治理模块的剧本生效；旧剧本（无 governance）保持原行为。
  if (!captured && target.owner && outcome !== 'defender_rout' && ctx.world.governance) {
    ctx.mutate({ op: 'add_faction_morale', factionId: target.owner, delta: 3, reason: `守住 ${targetDef.name}（士气大振）` });
  }

  // ── 地区动乱：战火 + 夺城 + 开战动员，均受**全国民心**放大 ──
  //   ★旧剧本没有 governance ⇒ 沿用原值（战火 5 / 夺城 25 / 无开战动乱）。
  const low = world.governance?.lowMoraleUnrest;
  const battleUnrest = low ? amplifiedUnrest(low.battleBase, attackerMorale, low) : { amount: 5, factor: 1 };
  const captureUnrest = captured
    ? low ? amplifiedUnrest(low.captureBase, attackerMorale, low) : { amount: 25, factor: 1 }
    : { amount: 0, factor: 1 };
  const warUnrest = startedWar && low
    ? amplifiedUnrest(low.warDeclarationBase, attackerMorale, low)
    : { amount: 0, factor: 1 };

  const unrestReason = (label: string, factor: number): string | undefined =>
    world.governance ? `${label}（全国民心 ${attackerMorale}，动乱×${factor.toFixed(2)}）` : undefined;
  if (battleUnrest.amount > 0) {
    const reason = unrestReason('战火波及', battleUnrest.factor);
    ctx.mutate({
      op: 'add_region_unrest',
      regionId: cmd.targetRegion,
      delta: battleUnrest.amount,
      ...(reason !== undefined ? { reason } : {}),
    });
  }
  if (captureUnrest.amount > 0) {
    const reason = unrestReason('占领动荡', captureUnrest.factor);
    ctx.mutate({
      op: 'add_region_unrest',
      regionId: cmd.targetRegion,
      delta: captureUnrest.amount,
      ...(reason !== undefined ? { reason } : {}),
    });
  }
  if (warUnrest.amount > 0) {
    const reason = unrestReason('开战动员', warUnrest.factor);
    ctx.mutate({
      op: 'add_region_unrest',
      regionId: originRegion,
      delta: warUnrest.amount,
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  // ★起义区被攻占：结束起义，并把战后动乱钳到“重占后的残破值”，避免同回合再次起义。
  if (captured && rebellion) {
    ctx.mutate({ op: 'set_region_rebellion', regionId: cmd.targetRegion, rebellion: null });
    const desired = ctx.world.rebellion?.originalReoccupyUnrest ?? 90;
    const current = ctx.state.regions[cmd.targetRegion]?.unrest ?? 0;
    if (current !== desired) {
      ctx.mutate({
        op: 'add_region_unrest',
        regionId: cmd.targetRegion,
        delta: desired - current,
        reason: '重占起义区后的残破动乱',
      });
    }
    ctx.emit({
      type: 'rebellion_ended',
      turn: ctx.turn,
      regionId: cmd.targetRegion,
      faction: attackerId,
      reason: 'reoccupied',
    });
  }

  const attackerCounter = attackerTypes[0] ? counterBonus(world, attackerTypes[0], defenderTypes) : 1;
  const defenderCounter = defenderTypes.length > 0
    ? Math.max(...defenderTypes.map((dt) => counterBonus(world, dt, attackerTypes)))
    : 1;

  // ── 完整掷骰证据（客户端只播放，不自己 roll）──
  ctx.emit({
    type: 'combat_resolved',
    turn: ctx.turn,
    regionId: cmd.targetRegion,
    evidence: {
      seed,
      originRegion,
      attackPath,
      startedWar,
      attacker: {
        factionId: attackerId,
        unitId: cmd.unitId,
        troopsBefore: committed,
        troopsAfter: atkTroops,
        effectivePower: round2(atkPower),
      },
      defender: {
        factionId: defenderId,
        regionId: cmd.targetRegion,
        troopsBefore: defenderTroopsTotal,
        troopsAfter: defTroops,
        effectivePower: round2(defPower),
      },
      attackerMorale,
      defenderMorale,
      moraleFactorAttacker: round2(atkMoraleF),
      moraleFactorDefender: round2(defMoraleF),
      attackerType: attackerTypes[0] ?? '',
      defenderTypes: [...defenderTypes],
      counters: {
        attackerBonus: round2(attackerCounter),
        defenderBonus: round2(defenderCounter),
      },
      unrest: {
        battle: battleUnrest.amount,
        capture: captureUnrest.amount,
        warDeclaration: warUnrest.amount,
        lowMoraleFactor: battleUnrest.factor,
        defenderUnrestFactor: round2(defUnrestF),
      },
      rounds,
      outcome,
      captured,
      captureReason,
      powerRatio: Number.isFinite(powerRatio) ? round3(powerRatio) : 999,
    },
  });
}

/** 按当前存活比例缩放战力（兵越少战力越低，兰彻斯特的核心） */
function computePower(
  world: WorldConfig,
  ctx: ResolveContext,
  unitIds: readonly UnitId[],
  stat: 'attack' | 'defense',
  factionId: FactionId,
  currentTroops: number,
  startTroops: number,
  opts: { enemyTypes: readonly string[]; moraleF: number; terrainDef?: number; fort?: number; unrestDef?: number; infantryTerrain?: number },
): number {
  if (startTroops <= 0 || currentTroops <= 0) return 0;
  const faction = ctx.state.factions[factionId];
  const laws = faction ? lawCombatMultiplier(world, faction.laws) : 1;
  let base = 0;
  for (const uid of unitIds) {
    const u = ctx.state.units[uid];
    if (!u) continue;
    const t = world.unitTypes[u.typeId];
    if (!t) continue;
    const bonus = counterBonus(world, u.typeId, opts.enemyTypes);
    const terrainUnit = opts.infantryTerrain !== undefined && isInfantryType(u.typeId)
      ? opts.infantryTerrain
      : 1;
    const titleMult = u.title === 'rebel_militia' || u.title === 'rebel_garrison'
      ? (world.rebellion?.rebelCombatMultiplier ?? 0.25)
      : 1;
    base += (u.troops / startTroops) * t[stat] * bonus * terrainUnit * titleMult;
  }
  const scaled = base * currentTroops;
  const exponent = Math.pow(currentTroops / startTroops, world.combat.lanchesterExponent - 1);
  return scaled * exponent * opts.moraleF * laws * (opts.terrainDef ?? 1) * (opts.fort ?? 1) * (opts.unrestDef ?? 1);
}

function applyAttackerLosses(ctx: ResolveContext, unitIds: readonly UnitId[], startTotal: number, remain: number, committed: number): void {
  // 只有被投入的部队承受损失
  const loss = committed - remain;
  if (loss <= 0) return;
  const uid = unitIds[0];
  if (!uid) return;
  const u = ctx.state.units[uid];
  if (!u) return;
  void startTotal;
  ctx.mutate({ op: 'add_unit_troops', unitId: uid, delta: -loss, reason: '战斗伤亡' });
}

function applyDefenderLosses(ctx: ResolveContext, unitIds: readonly UnitId[], startTotal: number, remain: number): void {
  const loss = startTotal - remain;
  if (loss <= 0 || unitIds.length === 0) return;
  // ★按 id 排序后按比例分摊，最后一支吃掉取整余数，保证分配确定
  const sorted = [...unitIds].sort();
  let assigned = 0;
  for (let i = 0; i < sorted.length; i++) {
    const uid = sorted[i] as UnitId;
    const u = ctx.state.units[uid];
    if (!u) continue;
    const isLast = i === sorted.length - 1;
    const share = isLast ? loss - assigned : Math.round((u.troops / startTotal) * loss);
    assigned += share;
    if (share > 0) ctx.mutate({ op: 'add_unit_troops', unitId: uid, delta: -share, reason: '战斗伤亡' });
  }
}

function clampRatio(r: number): number {
  if (!Number.isFinite(r)) return 4;
  return r < 0.25 ? 0.25 : r > 4 ? 4 : r;
}
function round2(v: number): number {
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
}
function round3(v: number): number {
  return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : 0;
}
