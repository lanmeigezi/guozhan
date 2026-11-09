/**
 * 领域标签 —— 把精确数值压成离散档位给 LLM 看。
 *
 * 为什么标签放在 core 而不是 protocol：它是**领域概念**（发展度分档、兵力分档），
 * 由核心计算；protocol 只声明字段是 string，不持有取值清单，
 * 避免 protocol → core 的反向依赖。
 *
 * 依据（Histrategy docs/design/state-complexity-vs-llm-hallucination.md 调研 CK3/Total War/Civ VI 的三条规律）：
 *   1. 越成功的策略游戏，数值变量的独立维度越少
 *   2. 离散 > 连续 ——「3 级城池」比「人口 183,421」更稳健
 *   3. LLM 调参数，代码算结果
 * 它们的 V1 让 LLM 直接看精确数值，结果孙权人口被推演成 18.3 万（史实约 200 万）。
 */

export const DEVELOPMENT_LABELS = ['凋敝', '稀少', '中等', '殷实', '富庶'] as const;

export const ARMY_TIERS = ['none', 'token', 'garrison', 'field_army', 'grand_army'] as const;
export type ArmyTier = (typeof ARMY_TIERS)[number];

export const ARMY_TIER_LABELS: Readonly<Record<ArmyTier, string>> = Object.freeze({
  none: '無兵',
  token: '少量守備',
  garrison: '衛戍之師',
  field_army: '野戰軍',
  grand_army: '大軍',
});

export const GOLD_TIERS = ['bankrupt', 'poor', 'moderate', 'rich', 'overflowing'] as const;
export type GoldTier = (typeof GOLD_TIERS)[number];

export const GOLD_TIER_LABELS: Readonly<Record<GoldTier, string>> = Object.freeze({
  bankrupt: '國庫枯竭',
  poor: '拮据',
  moderate: '尚可',
  rich: '充裕',
  overflowing: '府庫充盈',
});

export const FOOD_TIERS = ['starving', 'low', 'adequate', 'surplus', 'abundant'] as const;
export type FoodTier = (typeof FOOD_TIERS)[number];

export const FOOD_TIER_LABELS: Readonly<Record<FoodTier, string>> = Object.freeze({
  starving: '缺糧',
  low: '糧緊',
  adequate: '夠用',
  surplus: '有餘',
  abundant: '糧山',
});

/** 兵力分档阈值（与 projection.armyTier 保持一致，改这里必须同步改那里并由测试钉住） */
export const ARMY_TIER_THRESHOLDS: readonly number[] = Object.freeze([2000, 10000, 30000]);
export const GOLD_TIER_THRESHOLDS: readonly number[] = Object.freeze([0, 1000, 3000, 6000]);
/** 粮草按"够撑几回合军需"分档 */
export const FOOD_TIER_TURNS: readonly number[] = Object.freeze([0, 2, 5, 12]);
