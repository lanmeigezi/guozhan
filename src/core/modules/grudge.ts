/**
 * 潜在恨意模块（可选）。
 *
 * 设计意图：关系（war/peace/alliance）只是一张当下的纸，恨意是纸背后的记忆。
 * 频繁开战、毁约、交战夺城都会让双方社会互相记仇；停战后恨意缓慢冷却，
 * 但不会因为一纸和约立刻归零。
 *
 * 本模块只做**每回合的缓慢变化**；宣战/毁约/战斗/夺城的即时冲击由
 * statecraft / combat 在事件发生点写入，避免把"历史事件"压进一个读不到
 * 事件的被动模块。
 *
 * ★未在 moduleOrder 注册本模块的旧剧本：capabilities.grudge 为 false，
 *   statecraft/combat 不会写 grudge，本模块也不运行 ⇒ 旧行为与旧哈希不变。
 */
import { getRelation, GRUDGE_MAX, relationKey } from '../state.ts';
import type { ResolveContext, RuleModule, StateSlice } from '../module.ts';

/** 每回合仍在交战：继续添柴 */
export const GRUDGE_WAR_PER_TURN = 1;
/** 每回合和平/中立：缓慢冷却 */
export const GRUDGE_COOL_PER_TURN = 1;
/** 同盟每回合冷却更快 */
export const GRUDGE_ALLIANCE_COOL_PER_TURN = 2;

/** 即时冲击（statecraft / combat 共用，文档与测试引用同一组常量） */
export const GRUDGE_WAR_DECLARATION = 18;
export const GRUDGE_BREAK_ALLIANCE = 12;
export const GRUDGE_BATTLE = 2;
export const GRUDGE_CAPTURE = 5;

export const grudgeModule: RuleModule = {
  id: 'grudge',
  version: 1,
  reads: ['relations', 'factions.eliminated'] as readonly StateSlice[],
  writes: ['relations'] as readonly StateSlice[],
  commands: [],

  resolve(ctx: ResolveContext): void {
    const ids = Object.keys(ctx.state.factions).sort();
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i]!;
        const b = ids[j]!;
        if (ctx.state.factions[a]?.eliminated || ctx.state.factions[b]?.eliminated) continue;
        const key = relationKey(a, b);
        const entry = ctx.state.relations[key];
        const relation = getRelation(ctx.state, a, b);
        const current = entry?.grudge ?? 0;
        const delta = relation === 'war'
          ? GRUDGE_WAR_PER_TURN
          : relation === 'alliance'
            ? -GRUDGE_ALLIANCE_COOL_PER_TURN
            : -GRUDGE_COOL_PER_TURN;
        const next = Math.max(0, Math.min(GRUDGE_MAX, current + delta));
        if (next === current) continue;
        ctx.mutate({
          op: 'add_relation_grudge',
          a,
          b,
          delta: next - current,
          reason: relation === 'war' ? '战事未息，仇恨累积' : '和平日久，仇恨渐消',
        });
      }
    }
  },
};

/** 便于 UI/AI 复用：当前恨意等级（纯展示，不改规则） */
export type GrudgeBand = 'none' | 'wary' | 'hostile' | 'vendetta';

export function grudgeBand(value: number): GrudgeBand {
  if (value >= 70) return 'vendetta';
  if (value >= 45) return 'hostile';
  if (value >= 20) return 'wary';
  return 'none';
}
