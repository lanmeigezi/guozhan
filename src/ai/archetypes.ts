/**
 * AI 原型：疾攻 / 守成 / 无常。
 *
 * 原型在开局按 rootSeed 确定性分配；同一局同一种子必然得到同一批 AI 性格，
 * 但换种子会换分布。3 个及以上 AI 席位时保证三种原型各至少一个。
 *
 * ★原型只影响 AI 层的策略与奖励，不进 core 状态、不改 contentHash。
 */
import type { FactionId } from '../core/state.ts';
import { deriveSeed } from '../core/rng.ts';
import type { AiArchetype } from '../protocol/snapshot.ts';

export interface AiArchetypeInfo {
  readonly id: AiArchetype;
  readonly name: string;
  readonly tagline: string;
}

export const AI_ARCHETYPE_INFO: Readonly<Record<AiArchetype, AiArchetypeInfo>> = Object.freeze({
  rush: {
    id: 'rush',
    name: '疾攻',
    tagline: '以最快夺城为奖励：低进攻门槛、多路出击，越早拿地越赚。',
  },
  turtle: {
    id: 'turtle',
    name: '守成',
    tagline: '以存活回合、经济与防守为奖励：高筑垒、重基建、拖到对手先崩。',
  },
  random: {
    id: 'random',
    name: '无常',
    tagline: '从合法动作里随机抽取，不按固定套路，专门制造不可预测性。',
  },
});

/**
 * 给一组 AI 势力分配原型。
 *
 * 排序依据是 `(rootSeed, factionId)` 的确定性哈希，因此：
 *   · 与调用方传入顺序无关；
 *   · 同一局同种子稳定；
 *   · 3 个 AI 必定覆盖三种原型，2 个 AI 必定不重复，1 个 AI 由种子决定是哪一种。
 */
export function assignAiArchetypes(
  rootSeed: string,
  factionIds: readonly FactionId[],
): Readonly<Record<FactionId, AiArchetype>> {
  const ids = [...new Set(factionIds)].sort();
  if (ids.length === 0) return {};
  const order: AiArchetype[] = ['rush', 'turtle', 'random'];
  const offset = deriveSeed([rootSeed, 'ai-archetype-offset']) % order.length;
  const bag = [...order.slice(offset), ...order.slice(0, offset)];
  const ranked = ids
    .map((id) => ({ id, rank: deriveSeed([rootSeed, 'ai-archetype-rank', id]) }))
    .sort((a, b) => a.rank - b.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out: Record<FactionId, AiArchetype> = {};
  for (let i = 0; i < ranked.length; i++) {
    out[ranked[i]!.id] = bag[i % bag.length]!;
  }
  return out;
}

/** 单个势力的原型（用于运行中才转为 AI 的席位） */
export function archetypeForFaction(rootSeed: string, factionId: FactionId): AiArchetype {
  return assignAiArchetypes(rootSeed, [factionId])[factionId] ?? 'random';
}

export function archetypeLabel(archetype: AiArchetype | undefined): string {
  return archetype ? (AI_ARCHETYPE_INFO[archetype]?.name ?? archetype) : '';
}
