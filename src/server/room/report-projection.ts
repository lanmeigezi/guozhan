/**
 * 战报 / 事件按接收者的投影（战争迷雾在"读历史"通道上的落点）。
 *
 * ★为什么需要第三个投影点：快照（core/projection.ts）和事件流（event-audience.ts）
 *   都裁过一遍，但战报一直走 store.loadTurn() 原样外发 —— 玩家只要读 /turns/1
 *   或 MCP get_turn_report，就能拿到全势力精确国库/兵力/敌军命令。修快照不修战报
 *   等于门上了锁、窗户全开。
 *
 * ★三条硬约束：
 *   1. full（管理/观战）是**显式的全知分支**，其余一律按 viewer 裁剪，没有默认放行。
 *   2. 推导不出 viewer 身份 ⇒ fail-closed（空数据），不因"取不到"而回退全量。
 *   3. 事件里夹带的全势力精确数值（turn_recap / turn_resolved）必须二次裁剪，
 *      否则 EVENT_VISIBILITY='all' 会把敌国数字顺着公开事件送出去。
 */
import type { FactionId, SeatId } from '../../core/state.ts';
import type { DomainEvent } from '../../protocol/events.ts';
import type { TurnReport } from './types.ts';

export interface ReportViewer {
  /** true = 管理令牌 / 观战席位，拿全知版本 */
  readonly full: boolean;
  readonly factionId: FactionId | null;
  readonly seatId: SeatId | null;
}

type Loose = Record<string, unknown>;

/**
 * 单个事件对玩家席位的投影。返回 null = 该事件对该接收者不可见（fail-closed）。
 *
 * 保留战斗结果（combat_resolved / region_captured）——这是剧本里约定的公开战果；
 * 但 turn_recap 的「各方 goldDelta / troopsBefore / troopsAfter」与 turn_resolved
 * 的「全 scope 逐字段增量」是精确敌国数据，必须裁到本势力。
 */
export function projectEventForViewer(event: DomainEvent, viewer: ReportViewer): DomainEvent | null {
  if (viewer.full) return event;
  // 推导不出势力 ⇒ 一条事件都不给（绝不回退全量）
  if (viewer.factionId === null) return null;
  const e = event as unknown as Loose;
  if (e['type'] === 'turn_recap') {
    const factions = Array.isArray(e['factions'])
      ? (e['factions'] as Loose[]).filter((f) => f['id'] === viewer.factionId)
      : [];
    return { ...e, factions } as unknown as DomainEvent;
  }
  if (e['type'] === 'turn_resolved') {
    const ownScope = `faction:${viewer.factionId}`;
    const deltas = Array.isArray(e['deltas'])
      ? (e['deltas'] as Loose[]).filter((d) => d['scope'] === ownScope)
      : [];
    const clamps = Array.isArray(e['clamps'])
      ? (e['clamps'] as Loose[]).filter((c) => c['scope'] === ownScope)
      : [];
    return { ...e, deltas, clamps } as unknown as DomainEvent;
  }
  return event;
}

/**
 * 战报投影。visibleEventKeys 由调用方按 event_log 写库时算好的 audience 生成，
 * 只有命中的事件才进入玩家版战报（取不到 audience ⇒ 不出现在集合里 ⇒ 丢弃）。
 */
export function projectTurnReportForViewer(
  report: TurnReport,
  viewer: ReportViewer,
  visibleEventKeys: ReadonlySet<string>,
  keyOf: (event: DomainEvent) => string,
): TurnReport {
  if (viewer.full) return report;
  const ownScope = `faction:${viewer.factionId}`;
  const ownSeat = viewer.seatId;
  if (viewer.factionId === null || ownSeat === null) {
    // fail-closed：身份不明只给骨架，不给任何明细
    return {
      ...report,
      orders: [],
      baseline: [],
      clamps: [],
      events: [],
      narratives: {},
      rejected: [],
      violations: [],
      llmDelta: null,
    };
  }
  const ownNarrative = report.narratives[ownSeat];
  return {
    ...report,
    orders: report.orders.filter((o) => o.seatId === ownSeat),
    baseline: report.baseline.filter((d) => d.scope === ownScope),
    clamps: report.clamps.filter((c) => c.scope === ownScope),
    rejected: report.rejected.filter((r) => r.seatId === ownSeat),
    narratives: ownNarrative !== undefined ? { [ownSeat]: ownNarrative } : {},
    // 闸门违规清单 / LLM delta 含他席命令与他国精确士气调整，玩家不给
    violations: [],
    llmDelta: null,
    events: report.events
      .filter((e) => visibleEventKeys.has(keyOf(e)))
      .map((e) => projectEventForViewer(e, viewer))
      .filter((e): e is DomainEvent => e !== null),
  };
}
