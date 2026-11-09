/**
 * 自我复盘与策略迭代 —— 纯确定性，不调 LLM。
 *
 * 输入：上回合战报（事件/拒绝/资源增量）+ 当前状态 + 势力人格。
 * 输出：可解释的 lessons + 下一回合策略参数（AiPolicy）。
 *
 * ★关键取舍：
 *   · 不让模型"反思"出数值——复盘指标与策略参数由代码算，模型只消费；
 *   · 策略参数是**连续小步调整**，不是每回合推翻重来；
 *   · 全部输入来自状态与战报，同序列必得同策略，重放不受影响。
 */
import type { FactionId, GameState, WorldConfig } from '../core/state.ts';
import { getGrudge, getRelation, INTEL_VALID_TURNS, regionsOf, unitsIn } from '../core/state.ts';
import { TAX_MORALE_NEUTRAL_RATE } from '../core/modules/economy.ts';
import { AI_ARCHETYPE_INFO } from './archetypes.ts';
import type { AiArchetype, AiPolicy, SelfReview } from '../protocol/snapshot.ts';

interface LooseEvent {
  type?: string;
  regionId?: string;
  to?: string | null;
  from?: string | null;
  evidence?: {
    attacker?: { factionId?: string };
    defender?: { factionId?: string };
    outcome?: string;
  };
}

export interface TurnFacts {
  readonly turn: number;
  readonly events: readonly unknown[];
  readonly baseline: ReadonlyArray<{ scope: string; field: string; delta: number }>;
  /** 本席位（不是整个房间）被拒的命令数 */
  readonly rejectedForSeat: number;
}

export interface SelfReviewInput {
  readonly state: GameState;
  readonly world: WorldConfig;
  readonly factionId: FactionId;
  readonly aggression: number;
  /** AI 原型；人类席位不传，保持旧版通用复盘 */
  readonly archetype?: AiArchetype;
  readonly previous?: TurnFacts;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export function deriveSelfReview(input: SelfReviewInput): SelfReview {
  const { state, world, factionId, aggression, archetype, previous } = input;
  const faction = state.factions[factionId];
  if (!faction) {
    return {
      turn: state.turn,
      metrics: {
        regionsGained: 0, regionsLost: 0, battles: 0, attacksWon: 0, attacksLost: 0,
        rejectedCommands: 0, goldDelta: 0, foodDelta: 0, moraleDelta: 0,
      },
      lessons: ['势力不存在，无法复盘'],
      policy: null,
    };
  }

  let regionsGained = 0;
  let regionsLost = 0;
  let battles = 0;
  let attacksWon = 0;
  let attacksLost = 0;
  let defenseWins = 0;
  let goldDelta = 0;
  let foodDelta = 0;
  let moraleDelta = 0;
  if (previous) {
    for (const raw of previous.events) {
      const ev = (raw ?? {}) as LooseEvent;
      if (ev.type === 'region_captured') {
        if (ev.to === factionId) regionsGained++;
        if (ev.from === factionId) regionsLost++;
      } else if (ev.type === 'combat_resolved' && ev.evidence?.attacker?.factionId === factionId) {
        battles++;
        const outcome = ev.evidence.outcome;
        if (outcome === 'attacker_win' || outcome === 'defender_rout') attacksWon++;
        else if (outcome === 'defender_win' || outcome === 'attacker_rout') attacksLost++;
      } else if (ev.type === 'combat_resolved' && ev.evidence?.defender?.factionId === factionId) {
        const outcome = ev.evidence.outcome;
        if (outcome === 'defender_win' || outcome === 'attacker_rout') defenseWins++;
      }
    }
    for (const d of previous.baseline) {
      if (d.scope !== `faction:${factionId}`) continue;
      if (d.field === 'gold') goldDelta += d.delta;
      else if (d.field === 'food') foodDelta += d.delta;
      else if (d.field === 'morale') moraleDelta += d.delta;
    }
  }

  const owned = regionsOf(state, factionId);
  const avgUnrest = owned.length > 0
    ? owned.reduce((s, rid) => s + (state.regions[rid]?.unrest ?? 0), 0) / owned.length
    : 0;

  let atWar = false;
  let threatened = 0;
  let hasFreshIntel = false;
  for (const t of Object.values(faction.intel ?? {})) {
    if (t >= state.turn - INTEL_VALID_TURNS) {
      hasFreshIntel = true;
    }
  }
  for (const other of Object.keys(state.factions)) {
    if (other !== factionId && !state.factions[other]?.eliminated && getRelation(state, factionId, other) === 'war') {
      atWar = true;
    }
  }
  for (const rid of owned) {
    const ownTroops = unitsIn(state, rid, factionId).reduce((s, u) => s + u.troops, 0);
    let maxEnemy = 0;
    for (const n of world.regions[rid]?.adjacency ?? []) {
      const owner = state.regions[n]?.owner;
      if (!owner || owner === factionId) continue;
      maxEnemy = Math.max(maxEnemy, unitsIn(state, n, owner).reduce((s, u) => s + u.troops, 0));
    }
    if (maxEnemy > ownTroops * 1.15) threatened++;
  }

  const baseAttack = aggression >= 0.75 ? 1.05 : aggression <= 0.35 ? 1.6 : 1.4;
  let attackRatio = round2(clamp(
    baseAttack + regionsLost * 0.12 + attacksLost * 0.06 - regionsGained * 0.04 - attacksWon * 0.02,
    0.9,
    2.2,
  ));
  let defenseBias = round2(clamp(0.25 + regionsLost * 0.25 + threatened * 0.08 + (foodDelta < 0 ? 0.15 : 0), 0, 1));
  let infraBias = round2(clamp(0.15 + avgUnrest / 100 + (faction.morale < 50 ? 0.3 : 0), 0, 1));
  let spyBias = round2(clamp(0.15 + (atWar ? 0.35 : 0) + (atWar && !hasFreshIntel ? 0.25 : 0) + (faction.gold > 500 ? 0.1 : 0), 0, 1));
  // ★20% 是民心中性点：正常按中性收税；国库越紧越加税，但每高 10 个百分点
  //   会持续扣民心（30% -4、40% -8、50% -12）。低民心/高动乱/缺粮时强制回到中性。
  let taxTarget = TAX_MORALE_NEUTRAL_RATE;
  if (faction.gold < 300) taxTarget = 0.5;
  else if (faction.gold < 800) taxTarget = 0.4;
  else if (faction.gold < 1500) taxTarget = 0.3;
  if (faction.morale < 45 || avgUnrest > 50 || faction.food < 0) {
    taxTarget = Math.min(taxTarget, TAX_MORALE_NEUTRAL_RATE);
  }
  let lawBias = round2(clamp(0.15 + (faction.gold > 600 ? 0.35 : 0) + (faction.food < 1000 ? 0.2 : 0), 0, 1));
  let maxCommands = aggression >= 0.75 ? 6 : aggression <= 0.35 ? 4 : 5;

  // ── 原型奖励：疾攻奖励早期夺地，守成奖励存活/经济/防守；奖励再反过来微调策略 ──
  const reviewTurn = previous?.turn ?? Math.max(0, state.turn - 1);
  let reward: number | undefined;
  if (archetype === 'rush') {
    const earlyBonus = regionsGained > 0 ? Math.max(0, 12 - reviewTurn) * 0.5 : 0;
    reward = round2(
      regionsGained * 10 + attacksWon * 4 + defenseWins
      - regionsLost * 6 - attacksLost * 3 + earlyBonus
      + (state.winner === factionId ? 60 : 0),
    );
  } else if (archetype === 'turtle') {
    const survival = Math.min(12, Math.max(0, reviewTurn)) * 0.2;
    reward = round2(
      survival + goldDelta / 800 + foodDelta / 800 + moraleDelta * 0.4
      + defenseWins * 4 + regionsGained - regionsLost * 8 - attacksLost * 2
      + (state.winner === factionId ? 20 : 0),
    );
  } else if (archetype === 'random') {
    reward = 0;
  }
  const rewardBias = reward === undefined ? 0 : clamp(reward / 200, -0.15, 0.15);

  if (archetype === 'rush') {
    attackRatio = round2(clamp(1.2 + regionsLost * 0.1 + attacksLost * 0.05 - regionsGained * 0.03 - rewardBias, 0.95, 1.7));
    defenseBias = round2(clamp(0.05 + regionsLost * 0.12 + threatened * 0.02, 0, 0.4));
    infraBias = 0.05;
    spyBias = round2(clamp(0.45 + (atWar && !hasFreshIntel ? 0.2 : 0), 0, 0.8));
    lawBias = 0.1;
    taxTarget = faction.gold < 500 ? 0.4 : faction.gold < 1200 ? 0.3 : TAX_MORALE_NEUTRAL_RATE;
    if (faction.morale < 45) taxTarget = TAX_MORALE_NEUTRAL_RATE;
    maxCommands = 5;
  } else if (archetype === 'turtle') {
    const latePush = reviewTurn >= 30 ? 0.45 : reviewTurn >= 18 ? 0.25 : 0;
    attackRatio = round2(clamp(1.35 + regionsLost * 0.12 + attacksLost * 0.06 - latePush + rewardBias, 1.0, 2.0));
    defenseBias = round2(clamp(0.85 + threatened * 0.03 + regionsLost * 0.03, 0.7, 1));
    infraBias = round2(clamp(0.8 + avgUnrest / 100 * 0.1 + (faction.morale < 50 ? 0.1 : 0), 0.7, 1));
    spyBias = round2(clamp(0.6 + (atWar && !hasFreshIntel ? 0.15 : 0), 0, 0.85));
    lawBias = round2(clamp(0.65 + (faction.gold > 800 ? 0.2 : 0), 0, 0.9));
    taxTarget = faction.gold < 800 ? 0.3 : TAX_MORALE_NEUTRAL_RATE;
    if (faction.morale < 45) taxTarget = TAX_MORALE_NEUTRAL_RATE;
    maxCommands = reviewTurn >= 18 ? 6 : 5;
  }
  taxTarget = round2(clamp(taxTarget, world.economy.taxMinRate, world.economy.taxMaxRate));

  const lessons: string[] = [];
  if (!previous) {
    lessons.push('首回合：先看合法动作与战力预估，优先补员并抢占 0 守军目标。');
  } else {
    if (regionsLost > 0) lessons.push(`上回合失守 ${regionsLost} 区：提高守备与征兵优先级，优先加固接壤区。`);
    if (attacksLost > 0) lessons.push(`上回合 ${attacksLost} 次进攻失利：提高进攻门槛，先补员再打。`);
    if (attacksWon > 0 || regionsGained > 0) lessons.push(`上回合得手 ${attacksWon + regionsGained} 次：保持攻势，但注意新占区动乱。`);
    if (previous.rejectedForSeat > 0) lessons.push(`上回合 ${previous.rejectedForSeat} 条命令被拒：下回合先 validate_orders，检查资源与合法动作锚定。`);
    if (faction.food < 0 || foodDelta < -1000) lessons.push('粮草转负：减少征兵，必要时裁军或屯田。');
    if (faction.gold < 500) lessons.push('国库偏低：提高税率或减少非必要建设。');
    if (faction.taxRate > 0.3) lessons.push('税率偏高：每回合扣民心；除非急缺军费，建议降到 20% 中性税。');
    if (faction.morale < 50) lessons.push('全国民心偏低：减少征兵、修基建/减税，避免低民心放大地区动乱。');
    if (avgUnrest > 30) lessons.push('地区动乱偏高：优先基建或减税。');
    if (atWar && !hasFreshIntel) lessons.push('对交战方缺少精确情报：派间谍侦察边境。');
  }
  if (world.capabilities?.grudge === true) {
    let worst: { id: string; value: number } | null = null;
    for (const other of Object.keys(state.factions).sort()) {
      if (other === factionId || state.factions[other]?.eliminated) continue;
      const value = getGrudge(state, factionId, other);
      if (!worst || value > worst.value) worst = { id: other, value };
    }
    if (worst && worst.value >= 45) {
      lessons.push(
        `与 ${state.factions[worst.id]?.name ?? worst.id} 的潜在恨意 ${worst.value}：和谈、通商空间收窄，边境需留守军。`,
      );
    }
  }
  if (world.capabilities?.rebellion === true) {
    const rebelling = Object.values(state.regions).filter((r) => r.rebellion?.from === factionId);
    if (rebelling.length > 0) {
      lessons.push(
        `有 ${rebelling.length} 块领地在起义：先杀光起义民兵才能重占；若他国宣称归附，原属国会永久失去该区。`,
      );
    }
  }
  if (lessons.length === 0) lessons.push('上回合无重大失误；维持当前节奏，继续观察边境。');
  if (archetype) {
    const info = AI_ARCHETYPE_INFO[archetype];
    lessons.unshift(`${info.name}型：${info.tagline}`);
    if (archetype === 'rush' && reviewTurn >= 12) {
      lessons.unshift('疾攻窗口在收窄：优先打空城/孤立区，别再和重兵集团换血。');
    }
    if (archetype === 'turtle' && threatened > 0) {
      lessons.unshift('守成型：边境受威胁，先筑垒/修基建/补员，别为一座空城出城决战。');
    }
    if (archetype === 'random') {
      lessons.unshift('无常型：按种子从合法动作中随机抽取，不复用上一回合套路。');
    }
  }

  return {
    turn: previous?.turn ?? Math.max(0, state.turn - 1),
    ...(archetype ? { archetype } : {}),
    ...(reward !== undefined ? { reward } : {}),
    metrics: {
      regionsGained, regionsLost, battles, attacksWon, attacksLost,
      rejectedCommands: previous?.rejectedForSeat ?? 0,
      goldDelta, foodDelta, moraleDelta,
    },
    lessons: lessons.slice(0, 6),
    policy: archetype === 'random'
      ? null
      : {
          attackRatio, defenseBias, infraBias, spyBias, taxTarget, lawBias, maxCommands,
        },
  };
}

export type { AiPolicy };
