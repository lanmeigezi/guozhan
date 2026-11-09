/**
 * 随机数 AI：无常型。
 *
 * 从合法动作空间里按 `(rootSeed, turn, factionId)` 确定性抽取命令，
 * 不读战力比、不做经济规划、也不复用上一回合套路。
 * 它仍是“合法动作内的随机”，不是绕过闸门的作弊 AI。
 */
import type { FactionId, GameState, WorldConfig } from '../core/state.ts';
import { regionsOf } from '../core/state.ts';
import { enumerateLegalActions, type LegalAction } from '../core/legal.ts';
import { DeterministicRng } from '../core/rng.ts';
import { decideHeuristic, PROFILES, type HeuristicDecision } from './heuristic.ts';

export function decideRandom(
  state: GameState,
  world: WorldConfig,
  factionId: FactionId,
  rootSeed: string,
  maxCommands = 5,
  legal?: readonly LegalAction[],
): HeuristicDecision {
  const actions = legal ?? enumerateLegalActions(state, world, factionId, { maxActions: 200 });
  const f = state.factions[factionId];
  if (!f || f.eliminated) return { commands: [], rationale: '势力已灭亡', profileId: 'random' };
  if (actions.length === 0) return { commands: [], rationale: '无常策略：没有合法动作', profileId: 'random' };

  const rng = DeterministicRng.forAi(rootSeed, state.turn, factionId);
  // 开荒模式：纯随机动作很难完成“先扩张再决战”，会长期停在 1 城。
  // 这里让无常先按均衡方略出一个可执行计划，再确定性地丢掉最多一条命令，
  // 既保留不可预测性，又不至于完全不会开荒。
  if (world.frontier !== undefined) {
    const planned = decideHeuristic(state, world, factionId, PROFILES['balanced']!, [], actions, null);
    const commands = [...planned.commands];
    if (commands.length > 1 && rng.chance(0.35)) commands.pop();
    if (commands.length > 0) {
      return {
        commands,
        rationale: `无常策略（开荒）：随机化均衡计划 ${commands.length} 条`,
        profileId: 'random',
      };
    }
  }
  const shouldExpand = world.frontier !== undefined && regionsOf(state, factionId).length < 6;
  const pool = [...actions];
  const isExpansionAction = (a: LegalAction): boolean => {
    if (a.kind === 'settle_region' || a.kind === 'recruit') return true;
    if (a.kind === 'move_units') {
      const to = String((a.command as { toRegion?: unknown }).toRegion ?? '');
      return state.regions[to]?.owner === null;
    }
    return false;
  };
  const picked: Array<{ legalActionId: string; command: unknown }> = [];
  const usedUnits = new Set<string>();
  // 最多尝试 2×动作数，避免同一部队被抽中后无限重试
  for (let attempts = 0; attempts < actions.length * 2 && picked.length < maxCommands && pool.length > 0; attempts++) {
    // 开荒模式：无常也要先有地可站；否则会随机到税率/法令上，60 回合还在 1 城。
    const preferred = world.frontier && pool.some(isExpansionAction)
      ? pool.filter(isExpansionAction)
      : pool;
    const military = pool.filter((a) => a.kind === 'attack' || a.kind === 'recruit' || a.kind === 'move_units');
    const candidates = shouldExpand
      ? (rng.chance(0.8) ? preferred : pool)
      : (military.length > 0 && rng.chance(0.55) ? military : pool);
    const action = candidates[rng.nextInt(0, candidates.length - 1)]!;
    const poolIndex = pool.indexOf(action);
    if (poolIndex >= 0) pool.splice(poolIndex, 1);
    const unitId = (action.command as { unitId?: unknown }).unitId;
    if (typeof unitId === 'string') {
      if (usedUnits.has(unitId)) continue;
      usedUnits.add(unitId);
    }
    picked.push({ legalActionId: action.id, command: action.command });
  }

  return {
    commands: picked,
    rationale: `无常策略：从 ${actions.length} 条合法动作中随机抽 ${picked.length} 条`,
    profileId: 'random',
  };
}
