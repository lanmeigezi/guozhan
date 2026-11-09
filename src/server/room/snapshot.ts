/**
 * 按接收者投影战场快照（战争迷雾）。
 *
 * ★分层（P13）：
 *   静态层 = 地形/邻接/战术描述（预计算，人人可见）
 *   动态层 = 归属/部队/资源档位（按可见性裁剪，别人只给分层标签）
 *   告警层 = 规则代码替 LLM 盯盘的结果（只给本人）
 *   历史层 = sinceLastTurn（只讲变化，不复述全部）
 *
 * ★三条硬约束：
 *   1. 别人的国库/粮草/兵力只给**档位**，绝不给精确值（Histrategy：LLM 精确算术会漂）。
 *      唯一例外是 `exact`，且只对 isSelf 的势力填充。
 *   2. 合法动作空间随快照下发，LLM 只能引用其中的 id（P10 锚定）。
 *   3. 观战端拿全知视图，但**没有 legalActions 也没有 budget** —— 观战不能下命令。
 */
import type { FactionId, GameState, RegionId, SeatId, WorldConfig } from '../../core/state.ts';
import { getGrudge, rebelTroopsInRegion, regionCivilianPopulation, regionPopulation, relationKey, totalTroops, tradePolicyBetween, unitsIn } from '../../core/state.ts';
import {
  armyTier,
  buildMapText,
  canSeeStacks,
  developmentLabel,
  foodTier,
  foodUpkeepPerTurn,
  goldTier,
  relationFromViewer,
  visibleRegions,
  type Recipient,
} from '../../core/projection.ts';
import { enumerateLegalActions } from '../../core/legal.ts';
import { taxMoralePerTurn } from '../../core/modules/economy.ts';
import type { Alert, ProjectedFaction, ProjectedRegion, SelfReview, Snapshot } from '../../protocol/snapshot.ts';
import type { AiArchetype } from '../../protocol/snapshot.ts';

export interface SnapshotOptions {
  readonly state: GameState;
  readonly world: WorldConfig;
  readonly recipient: SeatId;
  readonly viewer: FactionId | null;
  readonly digest: string;
  readonly alerts: readonly Alert[];
  readonly tokenUsed: number;
  readonly tokenCap: number;
  readonly sinceLastTurn?: Snapshot['sinceLastTurn'];
  /** 引擎生成的自我复盘；只传给自己席位 */
  readonly selfReview?: SelfReview;
  /** AI 席位原型（人类席位不传；观战端可见 AI 性格） */
  readonly aiArchetypes?: Readonly<Record<FactionId, AiArchetype>>;
  /** 合法动作上限；小上下文模型可调到 20（OpenRA-RL 的 config-minimal 同款取舍） */
  readonly maxLegalActions?: number;
}

function stacksOf(
  state: GameState,
  world: WorldConfig,
  viewer: Recipient,
  regionId: RegionId,
): ProjectedRegion['stacks'] {
  if (!canSeeStacks(state, world, viewer, regionId)) return undefined;
  const groups = new Map<string, { ownerId: string; typeName: string; troops: number; title?: 'bandit_conscript' | 'rebel_militia' | 'rebel_garrison' }>();
  for (const u of Object.values(state.units)) {
    if (u.regionId !== regionId || u.troops <= 0) continue;
    const key = `${u.ownerId}\u0000${u.typeId}\u0000${u.title ?? ''}`;
    const g = groups.get(key);
    if (g) g.troops += u.troops;
    else {
      groups.set(key, {
        ownerId: u.ownerId,
        typeName: world.unitTypes[u.typeId]?.name ?? u.typeId,
        troops: u.troops,
        ...(u.title !== undefined ? { title: u.title } : {}),
      });
    }
  }
  if (groups.size === 0) return undefined;
  return [...groups.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([, g]) => ({
      ownerId: g.ownerId,
      typeName: g.typeName,
      troops: g.troops,
      tier: armyTier(g.troops),
      ...(g.title ? { title: g.title } : {}),
      seenTurnsAgo: 0,
    }));
}

export function buildSnapshot(opts: SnapshotOptions): Snapshot {
  const { state, world, viewer, digest } = opts;
  const viewerRecipient: Recipient = viewer ?? 'spectator';
  const visibility = visibleRegions(state, world, viewerRecipient);

  const regions: ProjectedRegion[] = [...Object.keys(state.regions)]
    .sort()
    .map((regionId) => {
      const rs = state.regions[regionId]!;
      const def = world.regions[regionId];
      const vis = visibility.get(regionId) ?? 'unknown';
      const ownerName = rs.owner === null ? null : (state.factions[rs.owner]?.name ?? rs.owner);
      const base: ProjectedRegion = {
        id: regionId,
        name: def?.name ?? regionId,
        owner: vis === 'unknown' ? null : rs.owner,
        ownerName: vis === 'unknown' ? null : ownerName,
        visibility: vis,
        adjacency: [...(def?.adjacency ?? [])].sort(),
      };
      if (vis === 'unknown') return base;
      const out: ProjectedRegion = { ...base };
      if (def) out.terrain = def.terrain;
      if (rs.rebellion) {
        const reb = rs.rebellion;
        out.rebellion = {
          original: reb.from,
          ...(state.factions[reb.from]?.name ? { originalName: state.factions[reb.from]!.name } : {}),
          ...(reb.claimedBy
            ? {
                claimedBy: reb.claimedBy,
                ...(state.factions[reb.claimedBy]?.name ? { claimedByName: state.factions[reb.claimedBy]!.name } : {}),
                ...(reb.claimedTurn !== undefined ? { claimedTurn: reb.claimedTurn } : {}),
              }
            : {}),
          rebelTroops: rebelTroopsInRegion(state, regionId),
          ...(world.rebellion ? { conscriptionTurns: world.rebellion.claimedConscriptionTurns } : {}),
        };
      }
      if (!rs.rebellion && rs.owner === null && world.frontier && def) {
        const natives = unitsIn(state, regionId, 'neutral').reduce((sum, u) => sum + u.troops, 0);
        out.frontier = {
          natives,
          requiredTroops: Math.ceil(natives * world.frontier.nativeTroopRatio),
          lootGold: Math.round(def.baseGold * world.frontier.lootGoldRatio),
          goldCost: world.frontier.settleGoldCost,
          foodCost: world.frontier.settleFoodCost,
          infrastructure: world.frontier.settledInfrastructure,
        };
      }
      if (vis === 'full') {
        out.developmentLabel = developmentLabel(rs.development);
        out.fortLevel = rs.fortLevel;
        out.infrastructure = rs.infrastructure ?? 0;
        out.unrest = rs.unrest;
        if (def) {
          const total = Math.round(regionPopulation(def.baseManpower, rs.development));
          const civilians = regionCivilianPopulation(state, world, regionId);
          out.population = total;
          out.civilianPopulation = civilians;
          const penalty = world.frontier?.civilianLaborPenalty ?? 0;
          if (penalty > 0 && total > 0) {
            out.civilianOutputFactor = Math.round((1 - penalty * (1 - civilians / total)) * 100) / 100;
          }
        }
        out.tacticalNote = def
          ? `${def.name}：${def.terrain}${def.strategic ? '，兵家必争' : ''}`
          : undefined;
      } else if (vis === 'partial') {
        out.developmentLabel = developmentLabel(rs.development);
      }
      const stacks = stacksOf(state, world, viewerRecipient, regionId);
      if (stacks) out.stacks = stacks;
      return out;
    });

  const factions: ProjectedFaction[] = Object.keys(state.factions)
    .sort()
    .map((fid) => {
      const f = state.factions[fid]!;
      const isSelf = viewer !== null && fid === viewer;
      const upkeep = foodUpkeepPerTurn(state, world, fid);
      const out: ProjectedFaction = {
        id: fid,
        name: f.name,
        isSelf,
        relation: (isSelf ? 'self' : relationFromViewer(state, viewerRecipient, fid)) as ProjectedFaction['relation'],
        regionCount: Object.values(state.regions).filter((r) => r.owner === fid).length,
        goldTier: goldTier(f.gold),
        foodTier: foodTier(f.food, upkeep),
        morale: f.morale,
        moraleFactor: Math.round((0.5 + f.morale / world.combat.moraleCoefficient) * 100) / 100,
        armyTier: armyTier(totalTroops(state, fid)),
        eliminated: f.eliminated,
      };
      if (!isSelf) {
        const archetype = opts.aiArchetypes?.[fid];
        if (archetype) out.aiArchetype = archetype;
        if (world.capabilities?.grudge === true && viewer !== null) {
          out.grudge = getGrudge(state, viewer, fid);
          out.wars = state.relations[relationKey(viewer, fid)]?.wars ?? 0;
          out.tradePolicy = tradePolicyBetween(state, viewer, fid, world.slaveTrade?.grudgeBlock);
        }
      }
      if (isSelf) {
        out.capital = f.capital;
        out.exact = {
          gold: f.gold,
          food: f.food,
          manpower: f.manpower,
          troops: Math.round(totalTroops(state, fid)),
          taxRate: f.taxRate,
          taxMoralePerTurn: taxMoralePerTurn(world, f.taxRate),
          laws: [...f.laws].sort(),
        };
      }
      return out;
    });

  const legalActions =
    viewer === null
      ? []
      : enumerateLegalActions(state, world, viewer, { maxActions: opts.maxLegalActions ?? 24 }).map((a) => ({
          id: a.id,
          kind: a.kind,
          label: a.label,
          ...(a.estimate ? { estimate: { ...a.estimate } } : {}),
        }));

  return {
    recipient: opts.recipient,
    turn: state.turn,
    phase: state.phase,
    winner: state.winner,
    endReason: state.endReason,
    stateId: digest,
    regions,
    factions,
    alerts: [...opts.alerts],
    legalActions,
    mapText: buildMapText(state, world, viewerRecipient, visibility),
    budget: { tokenUsed: opts.tokenUsed, tokenCap: opts.tokenCap },
    ...(opts.sinceLastTurn ? { sinceLastTurn: opts.sinceLastTurn } : {}),
    ...(opts.selfReview ? { selfReview: opts.selfReview } : {}),
  };
}
