/**
 * 存储编解码 —— memory-store 与 sqlite-store **共用**的序列化/反序列化与布尔映射。
 *
 * ★为什么必须共用：两套实现要实现同一个 RoomStore 接口，行为必须逐位一致
 *   （尤其是"布尔存 0/1 读回 true/false"与"存进去的 state 读出来 digest 不变"）。
 *   各写一份 = 两处日久漂移，正是本项目反复警惕的坑。
 *
 * ★node:sqlite 的两个硬约束在这里统一吸收：
 *   1. 绑定参数不接受 boolean / undefined ⇒ 一律 boolToInt() / nullify()
 *   2. 查出来的行是 null-prototype 对象 ⇒ plain() 转成普通对象，
 *      否则 assert.deepStrictEqual 会因原型不同而失败（且业务代码拿到的形状也怪）
 */
import { sha256, stableStringify, assertNoHoles } from '../config-loader.ts';
import type { GameState } from '../../core/state.ts';
import type { TurnReport } from '../room/types.ts';

/** SQLite 可绑定的标量：null | number | bigint | string | Uint8Array */
export type DbScalar = null | number | bigint | string | Uint8Array;

export function boolToInt(v: boolean | null | undefined): number {
  return v === true ? 1 : 0;
}

/** ★SQLite 里没有布尔：1 → true，其余（0/null/undefined）→ false。绝不返回 1 或 "true" */
export function intToBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'bigint') return v !== 0n;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v === '1' || v === 'true';
  return false;
}

/** undefined → null（node:sqlite 拒绝绑定 undefined），boolean → 0/1 */
export function nullify(v: unknown): DbScalar {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'string') return v;
  if (v instanceof Uint8Array) return v;
  return String(v);
}

/** null-prototype 行对象 → 普通对象（deepStrictEqual 与 JSON 序列化都需要） */
export function plain<T extends object>(row: T): T {
  return { ...row };
}

/**
 * 严格序列化：JSON.stringify 之后**立刻解码回来**校验，坏值当场抛错。
 * 架构文档 §5.4 第一步"序列化并严格解码"就是这条。
 * bigint 会被 JSON.stringify 抛错，正好是我们想要的（本项目不该出现 bigint）。
 */
export function toDbJson(value: unknown, label: string): string {
  let raw: string;
  try {
    raw = JSON.stringify(value);
  } catch (err) {
    throw new Error(`序列化 ${label} 失败：${err instanceof Error ? err.message : String(err)}`);
  }
  if (raw === undefined) throw new Error(`序列化 ${label} 失败：值不可 JSON 化（undefined？）`);
  try {
    JSON.parse(raw);
  } catch (err) {
    throw new Error(`${label} 序列化产物无法解码（损坏）：${err instanceof Error ? err.message : String(err)}`);
  }
  return raw;
}

export function fromDbJson<T>(raw: string | null | undefined, label: string): T | null {
  if (raw === null || raw === undefined || raw === '') return null;
  try {
    return JSON.parse(raw as string) as T;
  } catch (err) {
    throw new Error(`${label} 反序列化失败（库中数据损坏）：${err instanceof Error ? err.message : String(err)}`);
  }
}

export function fromDbJsonOr<T>(raw: string | null | undefined, fallback: T, label: string): T {
  const v = fromDbJson<T>(raw, label);
  return v === null ? fallback : v;
}

/**
 * 权威状态的规范化序列化。
 *
 * ★必须用 stableStringify 而不是 JSON.stringify：state_digest = sha256(state_json)，
 *   键序一变 digest 就变，CAS 与重放全部失效。
 * ★顺带跑 assertNoHoles：NaN/Infinity/undefined 进库就等于把"无法解释的数值漂移"
 *   写进权威状态，宁可当场 fail-closed（本项目栽过：NaN 也是确定性的，测试全绿）。
 */
export function serializeState(state: GameState, label = 'GameState'): string {
  assertNoHoles(state, label);
  return stableStringify(state);
}

export function deserializeState(raw: string, label = 'GameState'): GameState {
  const parsed = fromDbJson<GameState>(raw, label);
  if (parsed === null) throw new Error(`${label} 为空，无法还原状态`);
  return parsed;
}

/** 状态摘要：与 core 侧使用的算法完全一致（sha256(stableStringify(state))） */
export function digestState(state: GameState): string {
  return sha256(stableStringify(state));
}

/** 幂等参数指纹：同 requestId 是否"同参"由它判定（P8） */
export function paramsHash(envelope: unknown): string {
  return sha256(stableStringify(envelope));
}

// ─────────────────────────────────────────────────────────────
// 回合记录 ⇄ TurnReport
// ─────────────────────────────────────────────────────────────

/**
 * turn_record 一行的**领域形状**（两套 store 都存它，只是介质不同）。
 * 共用它是为了保证 loadTurn() 在内存库与 SQLite 上返回逐字段相同的结果。
 */
export interface StoredTurnRecord {
  readonly turn: number;
  readonly stateDigest: string;
  readonly orders: ReadonlyArray<{ seatId: string; commands: readonly unknown[] }>;
  readonly baseline: TurnReport['baseline'];
  readonly llmDelta: unknown | null;
  readonly llmApplied: boolean;
  readonly violations: TurnReport['violations'];
  readonly events: readonly unknown[];
  readonly evidence: readonly unknown[];
  readonly narratives: Readonly<Record<string, string>> | null;
  readonly clamps: TurnReport['clamps'];
  readonly rejected: TurnReport['rejected'];
  readonly resolvedAt: number;
}

/** 组装 TurnReport。★narratives 为 null 时返回 {}（契约里它是必填的 Record） */
export function turnRecordToReport(roomId: string, rec: StoredTurnRecord): TurnReport {
  return {
    roomId,
    turn: rec.turn,
    stateDigest: rec.stateDigest,
    orders: rec.orders.map((o) => ({ seatId: o.seatId, commands: [...o.commands] })),
    baseline: rec.baseline.map((b) => ({ ...b })),
    llmDelta: rec.llmDelta ?? null,
    violations: rec.violations.map((v) => ({ ...v })),
    clamps: rec.clamps.map((c) => ({ ...c })),
    events: rec.events.map((e) => e) as TurnReport['events'],
    narratives: rec.narratives === null ? {} : { ...rec.narratives },
    rejected: rec.rejected.map((r) => ({ ...r })),
    llmApplied: rec.llmApplied === true,
    resolvedAt: rec.resolvedAt,
  };
}

/**
 * 落库前的增量归因体检（铁律 8）。
 * turn_delta 的每一行都必须说清"这个数为什么变成这样"：
 * reason 非空、source 在 {deterministic|llm|event} 内、delta 与 old/new 自洽。
 * ★不是风格检查：Histrategy 的教训是数值漂移在几个月后才被发现，而唯一能定位它的
 *   就是这张逐字段归因表 —— 表里出现空 reason 等于审计线索断掉。
 */
export function assertDeltasAuditable(baseline: TurnReport['baseline'], label = 'turn_delta'): void {
  for (let i = 0; i < baseline.length; i++) {
    const d = baseline[i]!;
    if (typeof d.reason !== 'string' || d.reason.length === 0) {
      throw new Error(`${label}[${i}] 缺少 reason（scope=${String(d.scope)} field=${String(d.field)}）—— 拒绝落库`);
    }
    if (d.source !== 'deterministic' && d.source !== 'llm' && d.source !== 'event') {
      throw new Error(`${label}[${i}] 的 source 非法：${String(d.source)}（只允许 deterministic|llm|event）`);
    }
    if (!Number.isFinite(d.oldValue) || !Number.isFinite(d.newValue) || !Number.isFinite(d.delta)) {
      throw new Error(`${label}[${i}] 含非有限数：${String(d.oldValue)}→${String(d.newValue)}`);
    }
    if (Math.abs(d.newValue - d.oldValue - d.delta) > 1e-9) {
      throw new Error(`${label}[${i}] 的 delta 与 old/new 不自洽：${String(d.oldValue)}→${String(d.newValue)} Δ${String(d.delta)}`);
    }
  }
}
