/**
 * 外交与谍报模块。
 *
 * ★为什么必须单独存在：协议里早就有 `diplomacy`/`send_message` 命令，
 *   但没有模块认领它们 ⇒ 提交后被静默忽略。这里把它们变成真的状态变更：
 *   · 宣战/求和/结盟/毁约 → 改 relations（movement 的通行权与 combat 的自动宣战都会读到）；
 *   · 派间谍 → 花金，把目标区写入本势力的 intel 表，投影层在有效期内给 exact 视图。
 *
 * 本模块是单方面宣告（AI 暂不讨价还价），不是完整提案-答复流程；
 * 这样人类点一下就能看到关系变化，不会被“AI 不回复”卡住。
 */
import type { FactionId, RegionId, WorldConfig } from '../state.ts';
import { getRelation, INTEL_VALID_TURNS, regionsOf, terrainTraits } from '../state.ts';
import type { AcceptedOrder, ResolveContext, RuleModule, StateSlice } from '../module.ts';
import { GRUDGE_BREAK_ALLIANCE, GRUDGE_WAR_DECLARATION } from './grudge.ts';

interface DiplomacyCmd {
  kind: 'diplomacy';
  to: FactionId;
  action:
    | 'propose_alliance'
    | 'accept_alliance'
    | 'reject_alliance'
    | 'propose_peace'
    | 'accept_peace'
    | 'reject_peace'
    | 'declare_war'
    | 'break_alliance';
  inReplyTo?: string;
}
interface SendMessageCmd {
  kind: 'send_message';
  to: FactionId | null;
  publicity: 'public' | 'non-public';
  requireResponse: boolean;
  body: string;
}
interface SendSpyCmd { kind: 'send_spy'; regionId: RegionId }

export const SPY_GOLD_COST = 150;

/** 情报成本随地形变化：山地/林地更贵，城市更便宜。UI 预估与实际扣款共用此函数。 */
export function spyGoldCost(world: WorldConfig, regionId: RegionId): number {
  const mult = terrainTraits(world.regions[regionId]?.terrain ?? 'plains').intelCost;
  return Math.round(SPY_GOLD_COST * mult);
}

export const statecraftModule: RuleModule = {
  id: 'statecraft',
  version: 1,
  reads: ['regions.owner', 'factions.gold', 'factions.intel', 'relations'] as readonly StateSlice[],
  writes: ['factions.gold', 'factions.intel', 'relations'] as readonly StateSlice[],
  commands: ['diplomacy', 'send_message', 'send_spy'],

  resolve(ctx: ResolveContext): void {
    const sorted = [...ctx.orders]
      .filter((o) => statecraftModule.commands.includes(o.kind))
      .sort((a, b) => (a.seatId === b.seatId ? 0 : a.seatId < b.seatId ? -1 : 1));

    for (const order of sorted) {
      if (order.kind === 'diplomacy') handleDiplomacy(ctx, order, order.command as DiplomacyCmd);
      else if (order.kind === 'send_message') handleMessage(ctx, order, order.command as SendMessageCmd);
      else if (order.kind === 'send_spy') handleSpy(ctx, order, order.command as SendSpyCmd);
    }
  },
};

function handleDiplomacy(ctx: ResolveContext, order: AcceptedOrder, cmd: DiplomacyCmd): void {
  const fid = order.factionId;
  const faction = ctx.state.factions[fid];
  const target = ctx.state.factions[cmd.to];
  if (!faction || faction.eliminated) {
    ctx.reject(order, 'UNKNOWN_FACTION', '势力不存在或已灭亡');
    return;
  }
  if (!target || target.eliminated) {
    ctx.reject(order, 'UNKNOWN_FACTION', `目标势力 ${cmd.to} 不存在或已灭亡`);
    return;
  }
  if (cmd.to === fid) {
    ctx.reject(order, 'SELF_TARGET_NOT_ALLOWED', '不能对自己做外交动作');
    return;
  }
  if (cmd.action === 'accept_alliance' || cmd.action === 'reject_alliance' ||
      cmd.action === 'accept_peace' || cmd.action === 'reject_peace') {
    // 当前没有“待答复提案”状态；直接宣告即可，不要把 accept 悄悄当成 propose
    ctx.reject(order, 'MALFORMED_PAYLOAD', '当前没有待答复的外交提案；请直接使用 propose_peace / propose_alliance');
    return;
  }
  const current = getRelation(ctx.state, fid, cmd.to);
  const next: 'war' | 'alliance' | 'peace' | 'neutral' =
    cmd.action === 'declare_war' ? 'war'
      : cmd.action === 'propose_peace' ? 'peace'
        : cmd.action === 'propose_alliance' ? 'alliance'
          : 'neutral';
  if (current === next) {
    ctx.reject(order, 'MALFORMED_PAYLOAD', `与 ${target.name} 的关系已经是 ${next}`);
    return;
  }
  ctx.mutate({ op: 'set_relation', a: fid, b: cmd.to, kind: next });
  // ★潜在恨意：宣战与毁约是会被记住的。双方外交政策一起转冷。
  if (ctx.world.capabilities?.grudge === true) {
    const delta = cmd.action === 'declare_war'
      ? GRUDGE_WAR_DECLARATION
      : cmd.action === 'break_alliance'
        ? GRUDGE_BREAK_ALLIANCE
        : 0;
    if (delta > 0) {
      const reason = cmd.action === 'declare_war' ? '宣战结仇' : '背盟结仇';
      ctx.mutate({ op: 'add_relation_grudge', a: fid, b: cmd.to, delta, reason });
    }
  }
}

function handleMessage(ctx: ResolveContext, order: AcceptedOrder, cmd: SendMessageCmd): void {
  const target = cmd.to === null ? null : ctx.state.factions[cmd.to];
  if (cmd.to !== null && (!target || target.eliminated)) {
    ctx.reject(order, 'UNKNOWN_FACTION', `目标势力 ${cmd.to} 不存在或已灭亡`);
    return;
  }
  const index = ctx.orders.indexOf(order);
  ctx.emit({
    type: 'message_delivered',
    turn: ctx.turn,
    messageId: `msg_${ctx.turn}_${order.factionId}_${index}`,
    from: order.factionId,
    to: cmd.to,
    publicity: cmd.publicity,
    requireResponse: cmd.requireResponse,
    body: cmd.body,
  });
}

function handleSpy(ctx: ResolveContext, order: AcceptedOrder, cmd: SendSpyCmd): void {
  const fid = order.factionId;
  const faction = ctx.state.factions[fid];
  if (!faction || faction.eliminated) {
    ctx.reject(order, 'UNKNOWN_FACTION', '势力不存在或已灭亡');
    return;
  }
  const region = ctx.state.regions[cmd.regionId];
  if (!region) {
    ctx.reject(order, 'UNKNOWN_REGION', `区域 ${cmd.regionId} 不存在`);
    return;
  }
  if (region.owner === fid || regionsOf(ctx.state, fid).includes(cmd.regionId)) {
    ctx.reject(order, 'SELF_TARGET_NOT_ALLOWED', '不能对本区派间谍（己方区域本来就完全可见）');
    return;
  }
  const cost = spyGoldCost(ctx.world, cmd.regionId);
  if (faction.gold < cost) {
    ctx.reject(order, 'INSUFFICIENT_GOLD', `派间谍需 ${cost} 金（地形情报难度），现有 ${faction.gold}`);
    return;
  }
  ctx.mutate({ op: 'add_faction_gold', factionId: fid, delta: -cost, reason: `遣间谍侦察 ${cmd.regionId}` });
  ctx.mutate({ op: 'set_faction_intel', factionId: fid, regionId: cmd.regionId, turn: ctx.turn });
  ctx.emit({
    type: 'spy_reported',
    turn: ctx.turn,
    regionId: cmd.regionId,
    factionId: fid,
    targetOwner: region.owner,
    expiresTurn: ctx.turn + INTEL_VALID_TURNS,
    goldSpent: cost,
  });
}
