/**
 * 全国民心 / 地区动乱 / 基建的纯计算。
 *
 * ★语义边界（写死在类型与函数名里）：
 *   · 民心是全国性的（FactionState.morale），只影响战力、溃败线与动乱放大；
 *   · 动乱是地区性的（RegionState.unrest），只影响本区产出与守备；
 *   · 基建是地区性的（RegionState.infrastructure），降低本区动乱、提高本区人口增长，
 *     并以「基建点」汇总后小幅提升全国民心。
 *
 * 本文件不得 import 任何 IO/框架/随机源；arch-check 会静态扫描。
 */
import type {
  GovernanceParams,
  InfrastructureLevel,
  InfrastructureLevelDef,
  LowMoraleUnrestParams,
} from './state.ts';

/** 低民心放大系数：民心 ≥ 阈值时恒为 1；越低越大，最低民心时为 1 + maxUnrestBonus */
export function lowMoraleUnrestFactor(morale: number, params: LowMoraleUnrestParams): number {
  const threshold = params.threshold;
  if (!(threshold > 0)) return 1;
  const gap = Math.max(0, threshold - morale);
  return 1 + (gap / threshold) * params.maxUnrestBonus;
}

/** 某条会制造地区动乱的行为，实际动乱值 + 当时的放大系数（供事件/UI 展示与复算） */
export function amplifiedUnrest(
  base: number,
  morale: number,
  params: LowMoraleUnrestParams,
): { amount: number; factor: number } {
  const factor = lowMoraleUnrestFactor(morale, params);
  return { amount: Math.round(base * factor), factor: Math.round(factor * 100) / 100 };
}

export function infrastructureLevelDef(
  governance: GovernanceParams | undefined,
  level: InfrastructureLevel,
): InfrastructureLevelDef | null {
  if (!governance || level <= 0) return null;
  return governance.infrastructure.levels.find((l) => l.level === level) ?? null;
}

export function nextInfrastructureLevelDef(
  governance: GovernanceParams | undefined,
  current: InfrastructureLevel,
): InfrastructureLevelDef | null {
  if (!governance || current >= governance.infrastructure.maxLevel) return null;
  return governance.infrastructure.levels.find((l) => l.level === current + 1) ?? null;
}

/** 地区动乱对本区金/粮产出的乘数 */
export function unrestOutputFactor(governance: GovernanceParams | undefined, unrest: number): number {
  if (!governance) return 1;
  const penalty = Math.max(0, unrest) * governance.unrestEffects.outputPenaltyPerPoint;
  return Math.max(0, 1 - penalty);
}

/** 地区动乱对本区守备战力的乘数 */
export function unrestDefenseFactor(governance: GovernanceParams | undefined, unrest: number): number {
  if (!governance) return 1;
  const penalty = Math.max(0, unrest) * governance.unrestEffects.defensePenaltyPerPoint;
  return Math.max(0, 1 - penalty);
}
