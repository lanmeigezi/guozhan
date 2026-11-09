/**
 * 启发式决策 —— 次级国家的 AI，**完全不调 LLM**（P14 分级策略）。
 *
 * 为什么要它：Histrategy 对次要势力（刘表/刘璋）走启发式，理由写在 docstring 里 ——
 * "reduce token cost and prevent behavior from deviating from history"。
 * 在 1-2 核小机上，这是控成本的关键：7 个势力里 3 个走 LLM、4 个走这里，token 直接省一半以上。
 *
 * ★另一层意义：它也是 LLM 彻底不可用时的**全局降级路径**。
 *   确定性引擎永远是 fallback —— 没有 key、超时、预算耗尽，游戏都能继续。
 *
 * ★刻意把"该进攻就进攻"写进代码而不是提示词。
 *   OpenRA-RL 的教训：软性"先经济后军事"被 Qwen3-32B 执行成"永远经济"，5 局零交锋；
 *   局后反思只能修好建造顺序，改不了战略倾向。规则代码不会有这个毛病。
 */
import type { FactionId, GameState, WorldConfig } from '../core/state.ts';
import { getGrudge, regionsOf } from '../core/state.ts';
import { enumerateLegalActions, type LegalAction } from '../core/legal.ts';
import type { MilestoneStatus } from './alerts.ts';
import type { AiArchetype, AiPolicy } from '../protocol/snapshot.ts';

export interface HeuristicProfile {
  readonly id: string;
  /** 进攻的战力比门槛。低于此值不主动进攻（除非里程碑逼迫） */
  readonly attackRatio: number;
  /** 国库高于此值才考虑开发 */
  readonly developAboveGold: number;
  /** 兵力低于此值优先征兵 */
  readonly recruitBelowTroops: number;
  /** 单次最多下几条命令（对应核心的 1-8 步限制） */
  readonly maxCommands: number;
  readonly aggression: number;
}

export const PROFILES: Readonly<Record<string, HeuristicProfile>> = Object.freeze({
  /** 谨慎：只在明显优势时进攻 */
  cautious: { id: 'cautious', attackRatio: 1.6, developAboveGold: 1500, recruitBelowTroops: 25000, maxCommands: 4, aggression: 0.3 },
  /** 均衡（默认） */
  balanced: { id: 'balanced', attackRatio: 1.3, developAboveGold: 2000, recruitBelowTroops: 20000, maxCommands: 5, aggression: 0.5 },
  /**  aggressive：接近夺城线就打 */
  aggressive: { id: 'aggressive', attackRatio: 1.05, developAboveGold: 2500, recruitBelowTroops: 15000, maxCommands: 6, aggression: 0.85 },
  /** 绝望：濒死势力，孤注一掷 */
  desperate: { id: 'desperate', attackRatio: 0.85, developAboveGold: 99999, recruitBelowTroops: 99999, maxCommands: 6, aggression: 1.0 },
});

export function profileFor(aggression: number, regionCount: number): HeuristicProfile {
  if (regionCount <= 1) return PROFILES['desperate']!;
  if (aggression >= 0.75) return PROFILES['aggressive']!;
  if (aggression <= 0.35) return PROFILES['cautious']!;
  return PROFILES['balanced']!;
}

/** 原型覆盖默认人格：疾攻用 aggressive 档，守成用 cautious 档，无常用 balanced。 */
export function profileForArchetype(
  archetype: AiArchetype | undefined,
  aggression: number,
  regionCount: number,
): HeuristicProfile {
  if (archetype === 'rush') return PROFILES['aggressive']!;
  if (archetype === 'turtle') return PROFILES['cautious']!;
  if (archetype === 'random') return PROFILES['balanced']!;
  return profileFor(aggression, regionCount);
}

export interface HeuristicDecision {
  readonly commands: ReadonlyArray<{ legalActionId: string; command: unknown }>;
  readonly rationale: string;
  readonly profileId: string;
}

function num(a: LegalAction, key: string): number {
  const v = a.estimate?.[key];
  return typeof v === 'number' ? v : 0;
}

/**
 * 产出一组命令。★命令一律取自 `enumerateLegalActions` 的结果，
 *   与人类、LLM 走完全相同的合法动作空间 —— 不存在"AI 后门"。
 */
export function decideHeuristic(
  state: GameState,
  world: WorldConfig,
  fid: FactionId,
  profile: HeuristicProfile,
  milestones: readonly MilestoneStatus[] = [],
  legal?: readonly LegalAction[],
  policy?: AiPolicy | null,
): HeuristicDecision {
  const actions = legal ?? enumerateLegalActions(state, world, fid, { maxActions: 60 });
  const f = state.factions[fid];
  if (!f || f.eliminated) return { commands: [], rationale: '势力已灭亡', profileId: profile.id };

  const baseMaxCommands = policy?.maxCommands ?? profile.maxCommands;
  const maxCommands = world.frontier && profile.id === 'aggressive' ? Math.min(6, baseMaxCommands + 1) : baseMaxCommands;
  const picked: Array<{ legalActionId: string; command: unknown }> = [];
  const usedUnits = new Set<string>();
  const take = (a: LegalAction): boolean => {
    if (picked.length >= maxCommands) return false;
    if (picked.some((p) => p.legalActionId === a.id)) return false;
    const unitId = (a.command as { unitId?: unknown }).unitId;
    if (typeof unitId === 'string') {
      if (usedUnits.has(unitId)) return false;
      usedUnits.add(unitId);
    }
    picked.push({ legalActionId: a.id, command: a.command });
    return true;
  };

  const attacks = actions
    .filter((a) => a.kind === 'attack')
    // 开荒剧本：无主荒地只能开荒占领，普通进攻打不下来；AI 不应把命令位浪费在这里
    .filter((a) => {
      if (!world.frontier) return true;
      const target = state.regions[String((a.command as { targetRegion?: unknown }).targetRegion ?? '')];
      return target?.owner !== null;
    })
    .sort((x, y) => num(y, 'powerRatio') - num(x, 'powerRatio'));
  const recruits = actions.filter((a) => a.kind === 'recruit').sort((x, y) => num(y, 'count') - num(x, 'count'));
  const develops = actions.filter((a) => a.kind === 'develop');
  const forts = actions.filter((a) => a.kind === 'fortify');
  const moves = actions.filter((a) => a.kind === 'move_units');
  const infras = actions.filter((a) => a.kind === 'build_infrastructure');
  const spies = actions.filter((a) => a.kind === 'send_spy');
  const taxes = actions.filter((a) => a.kind === 'set_tax');
  const laws = actions.filter((a) => a.kind === 'set_law');
  const disbands = actions.filter((a) => a.kind === 'disband');
  const merges = actions.filter((a) => a.kind === 'merge_units');
  const diplomacy = actions.filter((a) => a.kind === 'diplomacy');
  const slaveTrades = actions.filter((a) => a.kind === 'trade_slaves');
  const claims = actions.filter((a) => a.kind === 'claim_rebellion');
  const settles = actions.filter((a) => a.kind === 'settle_region');
  const grudgeEnabled = world.capabilities?.grudge === true;

  const targetGrudge = (a: LegalAction): number => {
    if (!grudgeEnabled) return 0;
    const target = state.regions[String((a.command as { targetRegion?: unknown }).targetRegion ?? '')]?.owner;
    return target ? getGrudge(state, fid, target) : 0;
  };

  // ★里程碑逼迫：期限将至仍未达成进攻目标 ⇒ 降低门槛强行出击
  const overdueAttack = milestones.some(
    (m) => !m.met && Object.keys(m.require).some((k) => k === 'attacksLaunched' || k === 'regionsCaptured') && state.turn >= m.deadline - 2,
  );
  const baseAttackThreshold = overdueAttack
    ? Math.min(0.9, policy?.attackRatio ?? profile.attackRatio)
    : (policy?.attackRatio ?? profile.attackRatio);
  // 开荒图开局四家都只有 1 城：疾攻若按常规门槛直接开打，会把守成/无常压在摇篮里。
  // 这里只对 frontier 的 aggressive 档加 0.3 门槛，让它先扩张再决战。
  const attackThreshold = baseAttackThreshold;

  const reasons: string[] = [];
  // ★里程碑压力要显式写进理由，即使这次出击是靠战力比达标触发的。
  //   否则玩家在酒馆里看到"进攻（战力比 1.2）"，看不出这是被期限逼的，
  //   也就无法判断 AI 是不是在乱打 —— 可观测性缺陷和逻辑缺陷一样要修。
  if (overdueAttack) reasons.push('里程碑期限将至');

  const frontierExpansion = world.frontier !== undefined && regionsOf(state, fid).length < 3;
  const defensePriority = (policy?.defenseBias ?? 0) >= 0.55;
  const infraPriority = (policy?.infraBias ?? 0) >= 0.4;
  const spyPriority = (policy?.spyBias ?? 0) >= 0.5;
  const lawPriority = (policy?.lawBias ?? 0) >= 0.5;
  // 国库很富时强制留一个内政位：否则 AI 会把 5 个命令全砸在进攻上，
  // 金币长期堆积而民心/基建/发展不动（实战里出现的“富国穷兵”）。
  const richReserve = f.gold > 4000 ? 1 : 0;
  const reserved = (defensePriority ? 1 : 0) + (infraPriority ? 1 : 0) + (spyPriority ? 1 : 0) + (lawPriority ? 1 : 0) + richReserve;
  // 自迭代策略会为内政/防守/谍报预留少量命令位，避免全被进攻占满
  const attackQuota = Math.max(1, maxCommands - Math.min(3, reserved));

  // 1. 进攻（优势足够，或被里程碑逼迫）
  for (const a of attacks) {
    if (picked.length >= maxCommands || picked.length >= attackQuota) break;
    // ★世仇：对潜在恨意 ≥60 的目标降低出击门槛（双方外交政策已转冷）
    const threshold = targetGrudge(a) >= 60 ? Math.max(0.9, attackThreshold - 0.12) : attackThreshold;
    if (num(a, 'powerRatio') >= threshold) {
      if (take(a)) reasons.push(`进攻（战力比 ${num(a, 'powerRatio')}${threshold < attackThreshold ? '·世仇' : ''}）`);
    }
  }
  if (overdueAttack && picked.length === 0 && attacks.length > 0) {
    // 门槛内一个都没有 ⇒ 打最强的那个，宁可败也不能继续"只种田"
    take(attacks[0]!);
    reasons.push('里程碑逼迫出击');
  }

  // 1a. 开荒：已有部队进入的空白地块优先完成基建占领
  if (settles.length > 0 && picked.length < maxCommands) {
    const ranked = [...settles].sort((a, b) => num(b, 'lootGold') - num(a, 'lootGold') || (a.id < b.id ? -1 : 1));
    for (const best of ranked.slice(0, world.frontier ? 2 : 1)) {
      if (take(best)) reasons.push('开荒拓土');
    }
  }

  // 1a2. 开荒模式：还没有可开荒的部队时，先派兵进入相邻空白地
  if (world.frontier && settles.length === 0 && picked.length < maxCommands) {
    let moved = 0;
    for (const move of moves) {
      const target = state.regions[String((move.command as { toRegion?: unknown }).toRegion ?? '')];
      if (target?.owner !== null || target?.rebellion) continue;
      if (take(move)) {
        reasons.push('派兵进入荒地');
        moved++;
        if (moved >= 2) break;
      }
    }
  }

  // 1b. 宣称高民心优势下的起义区（无需出兵，直接归附）
  if (claims.length > 0 && picked.length < maxCommands) {
    const claim = [...claims].sort((a, b) => {
      const av = Number(a.estimate?.['rebelTroops'] ?? 0);
      const bv = Number(b.estimate?.['rebelTroops'] ?? 0);
      return bv - av || (a.id < b.id ? -1 : 1);
    })[0];
    if (claim && take(claim)) reasons.push('宣称起义区');
  }

  // 2. 征兵（兵力不足且付得起）
  const troops = Object.values(state.units).filter((u) => u.ownerId === fid).reduce((s, u) => s + u.troops, 0);
  if (troops < profile.recruitBelowTroops && f.gold > 500 && f.food > 500) {
    for (const r of recruits.slice(0, 2)) if (take(r)) reasons.push('补充兵员');
  }

  // 2a. 外交：潜在恨意低才求和；恨意高时宁可不谈
  if (grudgeEnabled && diplomacy.length > 0) {
    const peaceOffers = diplomacy
      .filter((a) => String((a.command as { action?: unknown }).action) === 'propose_peace')
      .map((a) => {
        const to = String((a.command as { to?: unknown }).to ?? '');
        return { a, to, grudge: getGrudge(state, fid, to) };
      })
      .filter((x) => x.grudge < 55)
      .sort((x, y) => x.grudge - y.grudge || (x.to < y.to ? -1 : 1));
    const losing = f.morale < 40 || troops < profile.recruitBelowTroops * 0.6;
    if (losing && peaceOffers.length > 0) {
      const offer = peaceOffers[0]!;
      if (take(offer.a)) reasons.push(`向 ${state.factions[offer.to]?.name ?? offer.to} 求和（恨意 ${offer.grudge}）`);
    }
  }

  // 2c. 鬻奴令：兵少、钱多、民心尚可时，用奴隶补兵（代价是长期动乱）
  if (slaveTrades.length > 0 && troops < profile.recruitBelowTroops && f.gold > 2000 && f.morale > 55) {
    const best = [...slaveTrades].sort((a, b) => num(a, 'goldCost') - num(b, 'goldCost'))[0];
    if (best && take(best)) reasons.push('买入贼配军补员');
  }

  // 2b. 自迭代策略：税率/法令/基建/谍报/防守
  if (policy) {
    if (Math.abs(policy.taxTarget - f.taxRate) >= 0.05 && taxes.length > 0) {
      const best = [...taxes].sort((a, b) =>
        Math.abs(Number(a.command['rate']) - policy.taxTarget) - Math.abs(Number(b.command['rate']) - policy.taxTarget),
      )[0];
      if (best && take(best)) reasons.push(`调整税率至 ${Math.round(Number(best.command['rate']) * 100)}%`);
    }
    if (lawPriority && !frontierExpansion && laws.length > 0 && f.gold > 600 && f.morale > 55) {
      if (take(laws[0]!)) reasons.push('颁布法令');
    }
    if (infraPriority && !frontierExpansion && infras.length > 0 && f.gold > 600) {
      const ranked = [...infras].sort((a, b) => {
        const ra = state.regions[String(a.command['regionId'])]?.unrest ?? 0;
        const rb = state.regions[String(b.command['regionId'])]?.unrest ?? 0;
        return rb - ra || (a.id < b.id ? -1 : 1);
      });
      for (const infra of ranked.slice(0, 2)) if (take(infra)) reasons.push('修建基建');
    }
    if (spyPriority && !frontierExpansion && spies.length > 0 && f.gold > 500) {
      if (take(spies[0]!)) reasons.push('派间谍侦察');
    }
    if (defensePriority && !frontierExpansion && forts.length > 0 && f.gold > 500) {
      if (take(forts[0]!)) reasons.push('加固边境');
    }
    if (f.food < 0 && disbands.length > 0) {
      if (take(disbands[0]!)) reasons.push('缺粮裁军');
    }
    if (picked.length < maxCommands && merges.length > 0) {
      if (take(merges[0]!)) reasons.push('合兵整编');
    }
  }

  // 3. 开发（有余钱且后方安全）
  if (f.gold > profile.developAboveGold && picked.length < maxCommands) {
    for (const d of develops.slice(0, 2)) if (take(d)) reasons.push('开发内政');
  }

  // 4. 边境要塞
  if (!policy && f.gold > profile.developAboveGold * 1.5 && picked.length < maxCommands) {
    for (const fo of forts.slice(0, 1)) if (take(fo)) reasons.push('加固边境');
  }

  // 5. 若什么都没做且有可调动的部队，向边境集中（避免"大军闲置"告警）
  if (picked.length === 0 && moves.length > 0) {
    const frontier = moves.find((m) => {
      const target = (m.command as { toRegion?: string }).toRegion;
      return target ? isFrontier(state, world, fid, target) : false;
    });
    if (frontier && take(frontier)) reasons.push('向边境集中');
  }

  if (reasons.length === 0) reasons.push('本回合无有利可图之举，休整');

  return {
    commands: picked,
    rationale: `${profile.id} 策略${policy ? '（自迭代）' : ''}：${reasons.join('、')}`,
    profileId: profile.id,
  };
}

function isFrontier(state: GameState, world: WorldConfig, fid: FactionId, rid: string): boolean {
  for (const n of world.regions[rid]?.adjacency ?? []) {
    const o = state.regions[n]?.owner;
    if (o && o !== fid) return true;
  }
  return regionsOf(state, fid).includes(rid);
}
