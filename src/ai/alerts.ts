/**
 * 规则告警 —— 用确定性代码替 LLM 盯盘（P13 告警层）。
 *
 * ★设计由来（OpenRA-RL 的"只种田不打仗"事故）：
 *   Qwen3-32B 打红警 5 局，economy 0.58-0.80，**combat 与 disruption 全 0**，零次交锋。
 *   它的告警系统有 `IDLE ARMY` 想纠偏，但该告警**只统计已存在的部队** ——
 *   AI 根本没造兵，于是告警无从触发。
 *
 *   教训：告警条件必须覆盖「**该做而没做**」。所以这里有两类：
 *     · 状态型：UNDER_ATTACK / FOOD_SHORTAGE / BANKRUPT / MORALE_LOW ...
 *     · 缺席型：NO_RECRUITMENT / NO_OFFENSIVE / MILESTONE_MISSED  ← 关键
 *
 * ★不用字符串表达式求值（无 eval）。config/rules/alerts.json 里是 `kind` + `params`，
 *   由本文件的白名单 switch 解释；未知 kind 直接忽略并在启动校验时报错。
 */
import type { FactionId, GameState, RegionId, WorldConfig } from '../core/state.ts';
import { getRelation, regionsOf } from '../core/state.ts';
import { isAlertKind, type AlertKind } from './alert-kinds.ts';

export interface AlertConfigEntry {
  readonly id: string;
  readonly priority: number;
  readonly kind: AlertKind;
  readonly params: Readonly<Record<string, number | string | boolean>>;
  readonly message: string;
}

export interface Alert {
  readonly id: string;
  readonly priority: number;
  readonly message: string;
}

/** 里程碑达成情况（硬性约束，防"只种田"） */
export interface MilestoneStatus {
  readonly message: string;
  readonly met: boolean;
  readonly deadline: number;
  readonly require: Readonly<Record<string, number>>;
  readonly actual: Readonly<Record<string, number>>;
}

export interface AlertFacts {
  /** 本回合被进攻的区域 */
  readonly attackedRegions: readonly RegionId[];
  /** 连续多少回合没征兵 */
  readonly turnsSinceRecruit: number;
  /** 连续多少回合没发起进攻 */
  readonly turnsSinceAttack: number;
  /** 本回合未行动的部队占比 */
  readonly idleTroopRatio: number;
  /** 已发起的进攻总数 */
  readonly attacksLaunched: number;
  /** 已夺取的区域总数 */
  readonly regionsCaptured: number;
  /** 当前可进攻的"野战军"数量（兵力 ≥ garrison 阈值且未行动） */
  readonly offensiveArmies: number;
}

export const EMPTY_FACTS: AlertFacts = {
  attackedRegions: [],
  turnsSinceRecruit: 0,
  turnsSinceAttack: 0,
  idleTroopRatio: 0,
  attacksLaunched: 0,
  regionsCaptured: 0,
  offensiveArmies: 0,
};

function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));
}

function troopsOf(state: GameState, fid: FactionId): number {
  let sum = 0;
  for (const u of Object.values(state.units)) if (u.ownerId === fid) sum += u.troops;
  return sum;
}

function foodUpkeep(state: GameState, world: WorldConfig, fid: FactionId): number {
  let sum = 0;
  for (const u of Object.values(state.units)) {
    if (u.ownerId !== fid) continue;
    const t = world.unitTypes[u.typeId];
    if (t) sum += (t.upkeepFood * u.troops) / 1000;
  }
  return Math.max(0, Math.round(sum));
}

/** 计算某势力的全部告警，按 priority 升序（数字小=更紧急） */
export function evaluateAlerts(
  state: GameState,
  world: WorldConfig,
  fid: FactionId,
  configs: readonly AlertConfigEntry[],
  facts: AlertFacts,
  milestones: readonly MilestoneStatus[] = [],
  maxAlerts = 8,
): Alert[] {
  const f = state.factions[fid];
  if (!f || f.eliminated) return [];
  const out: Alert[] = [];
  const owned = regionsOf(state, fid);
  const troops = troopsOf(state, fid);

  for (const cfg of configs) {
    if (!isAlertKind(cfg.kind)) continue; // 未知 kind 忽略（启动校验会另行报错）
    const p = cfg.params;
    let hit = false;
    const vars: Record<string, string | number> = {};

    switch (cfg.kind) {
      case 'region_attacked_this_turn': {
        const mine = facts.attackedRegions.filter((r) => owned.includes(r));
        if (mine.length > 0) {
          hit = true;
          const first = mine[0] as RegionId;
          vars['region'] = world.regions[first]?.name ?? first;
          const attacker = Object.values(state.units).find((u) => u.regionId === first && u.ownerId !== fid && u.ownerId !== 'neutral');
          vars['enemy'] = attacker ? (state.factions[attacker.ownerId]?.name ?? attacker.ownerId) : '不明';
        }
        break;
      }
      case 'milestone_missed': {
        const missed = milestones.filter((m) => !m.met && state.turn > m.deadline);
        if (missed.length > 0) {
          hit = true;
          vars['requirement'] = missed.map((m) => m.message).join('；');
        }
        break;
      }
      case 'food_below_upkeep_multiple': {
        const mult = Number(p['multiple'] ?? 2);
        const up = foodUpkeep(state, world, fid);
        if (up > 0 && f.food < up * mult) {
          hit = true;
          vars['turns'] = Math.max(0, Math.floor(f.food / up));
        }
        break;
      }
      case 'gold_below_zero':
        if (f.gold < 0) hit = true;
        break;
      case 'border_garrison_below_ratio': {
        const ratio = Number(p['ratio'] ?? 0.6);
        for (const rid of owned) {
          for (const n of world.regions[rid]?.adjacency ?? []) {
            const nb = state.regions[n]?.owner;
            if (!nb || nb === fid || getRelation(state, fid, nb) !== 'war') continue;
            const mine = Object.values(state.units).filter((u) => u.regionId === rid && u.ownerId === fid).reduce((s, u) => s + u.troops, 0);
            const theirs = troopsOf(state, nb);
            if (theirs > 0 && mine < theirs * ratio) {
              hit = true;
              vars['region'] = world.regions[rid]?.name ?? rid;
              vars['enemy'] = state.factions[nb]?.name ?? nb;
              vars['ratio'] = `${Math.round(ratio * 100)}%`;
              break;
            }
          }
          if (hit) break;
        }
        break;
      }
      case 'morale_below': {
        const v = Number(p['value'] ?? 35);
        if (f.morale < v) {
          hit = true;
          vars['value'] = f.morale;
        }
        break;
      }
      case 'idle_troops_ratio_above': {
        const ratio = Number(p['ratio'] ?? 0.5);
        if (troops > 0 && facts.idleTroopRatio > ratio) {
          hit = true;
          vars['ratio'] = `${Math.round(facts.idleTroopRatio * 100)}%`;
        }
        break;
      }
      case 'region_unrest_above': {
        const v = Number(p['value'] ?? 60);
        const worst = owned
          .map((rid) => ({ rid, unrest: state.regions[rid]?.unrest ?? 0 }))
          .filter((x) => x.unrest >= v)
          .sort((a, b) => b.unrest - a.unrest)[0];
        if (worst) {
          hit = true;
          vars['region'] = world.regions[worst.rid]?.name ?? worst.rid;
          vars['value'] = worst.unrest;
        }
        break;
      }
      // ★缺席型告警：这两条是 OpenRA-RL 事故的直接对策
      case 'turns_since_recruit_at_least': {
        const n = Number(p['turns'] ?? 3);
        if (facts.turnsSinceRecruit >= n) {
          hit = true;
          vars['turns'] = facts.turnsSinceRecruit;
        }
        break;
      }
      case 'turns_since_attack_at_least': {
        const n = Number(p['turns'] ?? 8);
        if (facts.turnsSinceAttack >= n) {
          hit = true;
          vars['turns'] = facts.turnsSinceAttack;
        }
        break;
      }
    }

    if (hit) out.push({ id: cfg.id, priority: cfg.priority, message: fill(cfg.message, vars) });
  }

  return out.sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : 1)).slice(0, maxAlerts);
}

/**
 * 里程碑达成评估。
 *
 * ★必须是**硬性、可校验**的（OpenRA-RL 教训：软性提示"先经济后军事"被小模型执行成"永远经济"）。
 * require 的键由代码解释，不认识的键忽略但返回 actual 里不含它 —— 便于诊断配置错误。
 */
export function evaluateMilestones(
  state: GameState,
  world: WorldConfig,
  fid: FactionId,
  milestones: ReadonlyArray<{ turn: number; require: Record<string, number>; message: string }>,
  facts: AlertFacts,
): MilestoneStatus[] {
  void world;
  return milestones.map((m) => {
    const actual: Record<string, number> = {};
    let met = true;
    for (const [key, need] of Object.entries(m.require)) {
      const have = readMetric(key, state, fid, facts);
      if (have === null) {
        met = false; // 不认识的指标视为未达成，避免"配置写错却静默通过"
        continue;
      }
      actual[key] = have;
      if (have < need) met = false;
    }
    return { message: m.message, met, deadline: m.turn, require: m.require, actual };
  });
}

function readMetric(key: string, state: GameState, fid: FactionId, facts: AlertFacts): number | null {
  switch (key) {
    case 'offensiveArmies': return facts.offensiveArmies;
    case 'attacksLaunched': return facts.attacksLaunched;
    case 'regionsCaptured': return facts.regionsCaptured;
    case 'regionCount': return regionsOf(state, fid).length;
    case 'totalTroops': return troopsOf(state, fid);
    case 'gold': return state.factions[fid]?.gold ?? 0;
    case 'morale': return state.factions[fid]?.morale ?? 0;
    default: return null;
  }
}
