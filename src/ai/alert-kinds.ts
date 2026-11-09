/**
 * 告警类型白名单 —— config/rules/alerts.json 的 kind 字段只能取这里的值。
 *
 * 单独成文件是为了让 config.test.ts 与 src/ai/alerts.ts **共用同一份真源**，
 * 避免"白名单在两处各写一份、日久漂移"（Histrategy 的剧本 ID 白名单就是散在两处）。
 */
export const ALERT_KINDS = [
  /** 本回合有区域被进攻 */
  'region_attacked_this_turn',
  /** 剧本里程碑未达成（防"只种田"） */
  'milestone_missed',
  /** 存粮 < 每回合军需 × multiple */
  'food_below_upkeep_multiple',
  /** 国库 < 0 */
  'gold_below_zero',
  /** 边境区守军 < 邻国兵力 × ratio */
  'border_garrison_below_ratio',
  /** 民心 < value */
  'morale_below',
  /** 未行动部队占比 > ratio */
  'idle_troops_ratio_above',
  /** 某区域动乱 > value */
  'region_unrest_above',
  /** 连续 N 回合未征兵（★"该做没做"型） */
  'turns_since_recruit_at_least',
  /** 连续 N 回合未发起进攻（★"该做没做"型） */
  'turns_since_attack_at_least',
] as const;

export type AlertKind = (typeof ALERT_KINDS)[number];

export function isAlertKind(v: unknown): v is AlertKind {
  return typeof v === 'string' && (ALERT_KINDS as readonly string[]).includes(v);
}
