/**
 * 事件受众计算 —— 战争迷雾在**事件流**上的落点。
 *
 * P4/ADR 0008：客户端永不拿到规范隐藏状态。快照有投影（core/projection.ts），
 * 事件同样需要：`units_moved` 只能给部队主看，`diplomacy_changed` 的密约只能给缔约双方看。
 *
 * ★受众在**写库时**算好并存进 event_log.audience_json，不是投递时才算：
 *   断线重连补发时状态已经翻过好几回合了，按"当前状态"重新推断受众会既漏发又误发
 *   （部队战死后查不到 ownerId → 主人反而看不见自己那次的移动记录）。
 *   commitTurn 会同时用「回合前状态」与「回合后状态」求并集，把这个边界情况也堵上。
 *
 * ★fail-closed：推不出归属时受众为空数组（只有观战端全知视图能收到），
 *   宁可少发一条也绝不把隐藏信息广播出去。
 */
import type { GameState } from '../../core/state.ts';
import { EVENT_VISIBILITY, type DomainEvent, type DomainEventType } from '../../protocol/events.ts';
import type { Audience } from './room-store-ext.ts';

type LooseEvent = { type?: unknown } & Record<string, unknown>;

const asString = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** 从事件载荷里能直接读出的当事势力（不需要查状态） */
function payloadFactions(event: LooseEvent): string[] {
  const out: string[] = [];
  const push = (v: unknown): void => {
    const s = asString(v);
    if (s !== null && !out.includes(s)) out.push(s);
  };
  push(event['factionId']);
  push(event['seatId']);
  push(event['from']);
  push(event['to']);
  push(event['a']);
  push(event['b']);
  push(event['winner']);
  push(event['buyer']);
  push(event['seller']);
  return out;
}

/** 需要查状态才能定归属的事件：部队 → 主人，区域 → 占领者 */
function stateFactions(event: LooseEvent, state: GameState | undefined): string[] {
  if (state === undefined) return [];
  const out: string[] = [];
  const unitId = asString(event['unitId']);
  if (unitId !== null) {
    const owner = state.units[unitId]?.ownerId;
    if (owner !== undefined && owner !== 'neutral' && !out.includes(owner)) out.push(owner);
  }
  for (const key of ['regionId', 'to', 'from']) {
    const rid = asString(event[key]);
    if (rid === null) continue;
    const owner = state.regions[rid]?.owner;
    if (owner !== null && owner !== undefined && !out.includes(owner)) out.push(owner);
  }
  return out;
}

/**
 * 单个事件的受众。
 * @returns 'all' = 广播；string[] = 只给这些势力（观战端恒定全收，由投递层处理）
 */
export function audienceOfEvent(event: unknown, state?: GameState): Audience {
  const ev = (event ?? {}) as LooseEvent;
  const type = asString(ev['type']) as DomainEventType | null;
  if (type === null) return []; // 不认识的事件：fail-closed，只给观战端
  const visibility = EVENT_VISIBILITY[type];
  if (visibility === undefined) return [];

  if (visibility === 'all') return 'all';

  if (visibility === 'public-only') {
    if (ev['publicity'] === 'public') return 'all';
    const parties = [...payloadFactions(ev), ...stateFactions(ev, state)];
    // 密约只给缔约双方；推不出当事方就不发（观战端仍可见）
    return dedupe(parties.filter((p) => p !== 'spectator'));
  }

  // 'owner'
  if (type === 'message_delivered' && ev['to'] === null) return 'all'; // 广播文书
  return dedupe([...payloadFactions(ev), ...stateFactions(ev, state)]);
}

/** 两个受众求并集（'all' 吸收一切） */
export function unionAudience(a: Audience, b: Audience): Audience {
  if (a === 'all' || b === 'all') return 'all';
  return dedupe([...a, ...b]);
}

/** 某接收者是否该收到该事件。观战端（全知视图）恒为 true */
export function audienceIncludes(audience: Audience, recipientFaction: string | 'spectator' | null): boolean {
  if (recipientFaction === 'spectator' || recipientFaction === null) return true;
  if (audience === 'all') return true;
  return audience.includes(recipientFaction);
}

function dedupe(list: readonly string[]): string[] {
  const out: string[] = [];
  for (const v of list) if (!out.includes(v)) out.push(v);
  return out.sort();
}

/** 存库/读库的受众编解码（audience_json） */
export function encodeAudience(audience: Audience): string {
  return JSON.stringify(audience === 'all' ? 'all' : [...audience]);
}

export function decodeAudience(raw: unknown): Audience {
  if (typeof raw !== 'string' || raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === 'all') return 'all';
    if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === 'string');
    return [];
  } catch {
    return []; // 损坏的受众字段按"谁都别发"处理（fail-closed），不抛错打断补发
  }
}

export type { DomainEvent };
