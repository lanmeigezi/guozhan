/**
 * SQLite 存储实现 —— 每房间一个库文件（WAL），用 **Node 内置 `node:sqlite`**。
 *
 * ★选型（2026-10-24 变更）：不用 better-sqlite3。它在 Node 26 无预编译二进制、
 *   回落源码编译又要 VS Build Tools，本机 `npm install` 直接失败并回滚全部依赖。
 *   `node:sqlite` 零安装零编译，Node 24+ 免 flag，Docker 镜像也少一个 build 阶段。
 *
 * ★与 better-sqlite3 的三处 API 差异，全部在本文件内吸收：
 *   1. 没有 `.pragma()` —— 只能 `db.exec('PRAGMA …')`
 *   2. 没有 `.transaction(fn)` —— 事务手写 BEGIN/COMMIT/ROLLBACK（见 `tx()`）
 *   3. 不接受 boolean / undefined 绑定 —— 一律经 codec 的 boolToInt()/nullify()
 *   另外 `.get()` 无结果返回 undefined（不是 null），行对象是 null-prototype（要 plain()）。
 *
 * 单写者纪律：每房间的写入只由该房间的 resolve 循环串行执行（RoomManager 的单飞锁），
 * 因此 WAL 下不会出现写者竞争；`busy_timeout` 只是偶发读的保险。
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GameState, SeatId } from '../../core/state.ts';
import type { AdviceRecord } from '../../protocol/advice.ts';
import type { CommandResult } from '../../protocol/commands.ts';
import type {
  LlmCallEntry,
  PersistedRoom,
  PersistedSeat,
  RoomIndex,
  RoomStore,
  TurnCommit,
  TurnReport,
} from '../room/types.ts';
import type {
  Audience,
  EventRow,
  MessageRow,
  PendingOrderRow,
  ReceiptRow,
  RoomExport,
  RoomStoreExt,
  SubmissionRow,
} from './room-store-ext.ts';
import {
  boolToInt,
  deserializeState,
  digestState,
  fromDbJson,
  fromDbJsonOr,
  intToBool,
  nullify,
  paramsHash as hashParams,
  plain,
  serializeState,
  toDbJson,
  assertDeltasAuditable,
  type StoredTurnRecord,
  turnRecordToReport,
} from './codec.ts';
import { audienceOfEvent, encodeAudience, decodeAudience, unionAudience } from './event-audience.ts';
import { atomicWriteJson } from './atomic-write.ts';

/**
 * schema 文件在两种运行形态下的位置不同：
 *   · 源码直跑（node --experimental-strip-types）：与本文件同目录
 *   · 打包后（dist/main.js）：由 scripts/copy-assets.mjs 拷到 dist/ 根
 * 逐个尝试，全失败就带着"试过哪些路径"报错 —— 不静默降级成空 schema。
 */
function readSchema(name: string): string {
  const here = fileURLToPath(new URL(`./${name}`, import.meta.url));
  const candidates = [here, join(process.cwd(), 'src/server/store', name), join(process.cwd(), 'dist', name)];
  for (const path of candidates) {
    if (existsSync(path)) return readFileSync(path, 'utf8');
  }
  throw new Error(`找不到 ${name}；已尝试：\n  ${candidates.join('\n  ')}`);
}

const SCHEMA_SQL = readSchema('schema.sql');
const INDEX_SCHEMA_SQL = readSchema('index-schema.sql');

/** 当前 schema 版本（写进 schema_meta；不匹配时 fail-closed，不静默按新表跑旧库） */
export const ROOM_SCHEMA_VERSION = '1';
export const INDEX_SCHEMA_VERSION = '1';

/** roomId 会进文件名 ⇒ 必须限定字符集（防路径穿越，与 protocol 的 idSchema 同规则） */
const ROOM_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export function assertSafeRoomId(roomId: string): void {
  if (typeof roomId !== 'string' || !ROOM_ID_RE.test(roomId)) {
    throw new Error(`非法 roomId：${JSON.stringify(roomId)}（只允许字母数字下划线连字符，≤64 字符）`);
  }
}

export interface SqliteStoreOptions {
  /** 数据根目录；房间库在 <dataDir>/rooms/<roomId>.db，注册表在 <dataDir>/index.db */
  readonly dataDir?: string;
  readonly roomsSubdir?: string;
  readonly busyTimeoutMs?: number;
  /** ':memory:' 库不支持 WAL；置 'MEMORY' 可跳过 WAL（仅测试用） */
  readonly journalMode?: 'WAL' | 'MEMORY' | 'DELETE';
}

interface RoomDb {
  readonly db: DatabaseSync;
  readonly stmts: Map<string, StatementSync>;
  readonly path: string;
  journalMode: string;
}

/** 手写事务（node:sqlite 没有 .transaction() 辅助方法） */
function tx<T>(room: RoomDb, fn: () => T): T {
  room.db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    room.db.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      room.db.exec('ROLLBACK');
    } catch {
      // 已经自动回滚（如 BEGIN 未成功）；此处再抛会掩盖原始错误
    }
    throw err;
  }
}

function stmt(room: RoomDb, sql: string): StatementSync {
  let s = room.stmts.get(sql);
  if (!s) {
    s = room.db.prepare(sql);
    room.stmts.set(sql, s);
  }
  return s;
}

export class SqliteRoomStore implements RoomStoreExt {
  readonly dataDir: string;
  readonly roomsDir: string;
  private readonly rooms: Map<string, RoomDb> = new Map();
  private readonly busyTimeoutMs: number;
  private readonly journalMode: 'WAL' | 'MEMORY' | 'DELETE';

  constructor(opts: SqliteStoreOptions = {}) {
    this.dataDir = resolve(opts.dataDir ?? 'data');
    this.roomsDir = join(this.dataDir, opts.roomsSubdir ?? 'rooms');
    this.busyTimeoutMs = opts.busyTimeoutMs ?? 5000;
    this.journalMode = opts.journalMode ?? 'WAL';
    mkdirSync(this.roomsDir, { recursive: true });
  }

  // ─────────────────────────────────────────────────────────────
  // 连接生命周期
  // ─────────────────────────────────────────────────────────────

  roomPath(roomId: string): string {
    assertSafeRoomId(roomId);
    return join(this.roomsDir, `${roomId}.db`);
  }

  open(roomId: string): void {
    assertSafeRoomId(roomId);
    if (this.rooms.has(roomId)) return;
    mkdirSync(this.roomsDir, { recursive: true });
    const path = this.roomPath(roomId);
    const db = new DatabaseSync(path);
    // ★没有 .pragma() 方法，只能 exec
    if (this.journalMode === 'WAL') db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA synchronous=NORMAL');
    db.exec(`PRAGMA busy_timeout=${Math.max(0, Math.floor(this.busyTimeoutMs))}`);
    db.exec('PRAGMA foreign_keys=ON');
    const room: RoomDb = { db, stmts: new Map(), path, journalMode: 'unknown' };
    try {
      const row = db.prepare('PRAGMA journal_mode').get() as { journal_mode?: unknown } | undefined;
      room.journalMode = String(row?.journal_mode ?? 'unknown');
      db.exec(SCHEMA_SQL);
      db
        .prepare(`INSERT INTO schema_meta(key,value) VALUES('room_schema_version',?)
                  ON CONFLICT(key) DO NOTHING`)
        .run(ROOM_SCHEMA_VERSION);
      const versionRow = db
        .prepare(`SELECT value FROM schema_meta WHERE key='room_schema_version'`)
        .get() as { value?: unknown } | undefined;
      const version = String(versionRow?.value ?? ROOM_SCHEMA_VERSION);
      if (version !== ROOM_SCHEMA_VERSION) {
        throw new Error(
          `房间库 ${roomId} 的 schema 版本 ${version} 与代码期望的 ${ROOM_SCHEMA_VERSION} 不符 —— fail-closed，拒绝加载（迁移工具尚未提供，请勿静默改表）`,
        );
      }
    } catch (err) {
      try { db.close(); } catch { /* 已关 */ }
      throw err;
    }
    this.rooms.set(roomId, room);
  }

  /** 实际生效的 journal_mode（测试用：文件库应为 'wal'，:memory: 为 'memory'） */
  journalModeOf(roomId: string): string {
    return this.use(roomId).journalMode;
  }

  close(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    this.rooms.delete(roomId);
    try {
      room.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // MEMORY/DELETE 模式下没有 WAL，checkpoint 会报错，忽略
    }
    room.db.close();
  }

  closeAll(): void {
    for (const id of [...this.rooms.keys()]) this.close(id);
  }

  openRoomIds(): readonly string[] {
    return [...this.rooms.keys()].sort();
  }

  /** 取已打开的库；未打开但文件存在 ⇒ 自动打开（幂等），否则 fail-closed */
  private use(roomId: string): RoomDb {
    assertSafeRoomId(roomId);
    const existing = this.rooms.get(roomId);
    if (existing) return existing;
    if (existsSync(this.roomPath(roomId))) {
      this.open(roomId);
      return this.rooms.get(roomId)!;
    }
    throw new Error(`房间库 ${roomId} 未打开且 ${this.roomPath(roomId)} 不存在（先调 open()）`);
  }

  // ─────────────────────────────────────────────────────────────
  // 身份校验（P4 fail-closed）
  // ─────────────────────────────────────────────────────────────

  verifyIdentity(roomId: string, expected: { behaviorFingerprint: number; contentHash: string }): void {
    const row = this.getRoomRow(roomId);
    if (!row) {
      throw new Error(`身份校验失败：房间 ${roomId} 在库中不存在，无法确认 behavior_fingerprint / content_hash`);
    }
    const fp = Number(row['behavior_fingerprint']);
    const ch = String(row['content_hash']);
    if (fp !== expected.behaviorFingerprint) {
      throw new Error(
        `身份校验失败（fail-closed）：房间 ${roomId} 的 behavior_fingerprint=${fp}，当前核心为 ${expected.behaviorFingerprint}。` +
          `规则版本变了，旧档不得按新规则继续跑（会产生无法解释的数值漂移）。`,
      );
    }
    if (ch !== expected.contentHash) {
      throw new Error(
        `身份校验失败（fail-closed）：房间 ${roomId} 的 content_hash=${ch.slice(0, 12)}…，当前剧本+配置为 ${expected.contentHash.slice(0, 12)}…。` +
          `配置改过了，旧档与新配置不兼容。`,
      );
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 房间头 / 席位 / 状态
  // ─────────────────────────────────────────────────────────────

  private getRoomRow(roomId: string): Record<string, unknown> | undefined {
    const room = this.use(roomId);
    const row = stmt(room, `SELECT * FROM room WHERE id=?`).get(roomId);
    return row === undefined ? undefined : plain(row as object) as Record<string, unknown>;
  }

  loadRoom(roomId: string): PersistedRoom | null {
    const row = this.getRoomRow(roomId);
    if (!row) return null;
    return rowToRoom(row);
  }

  saveRoom(roomId: string, r: PersistedRoom): void {
    const room = this.use(roomId);
    stmt(
      room,
      `INSERT INTO room (id,name,scenario_id,phase,turn,max_turns,root_seed,state_json,state_digest,
                         behavior_fingerprint,content_hash,module_order_json,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         name=excluded.name, scenario_id=excluded.scenario_id, phase=excluded.phase,
         turn=excluded.turn, max_turns=excluded.max_turns, root_seed=excluded.root_seed,
         state_json=excluded.state_json, state_digest=excluded.state_digest,
         behavior_fingerprint=excluded.behavior_fingerprint, content_hash=excluded.content_hash,
         module_order_json=excluded.module_order_json, updated_at=excluded.updated_at`,
    ).run(
      r.roomId,
      r.name,
      r.scenarioId,
      r.phase,
      r.turn,
      r.maxTurns,
      r.rootSeed,
      r.stateJson,
      r.stateDigest,
      r.behaviorFingerprint,
      r.contentHash,
      r.moduleOrderJson,
      r.createdAt,
      r.updatedAt,
    );
  }

  loadSeats(roomId: string): PersistedSeat[] {
    const room = this.use(roomId);
    const rows = stmt(room, `SELECT * FROM seat ORDER BY seat_id`).all();
    return rows.map((r) => rowToSeat(plain(r as object) as Record<string, unknown>));
  }

  saveSeat(roomId: string, seat: PersistedSeat): void {
    const room = this.use(roomId);
    stmt(
      room,
      `INSERT INTO seat (seat_id,kind,faction_id,controller,auto_commit,llm_driven,ai_profile,token_used,token_cap,joined_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(seat_id) DO UPDATE SET
         kind=excluded.kind, faction_id=excluded.faction_id, controller=excluded.controller,
         auto_commit=excluded.auto_commit, llm_driven=excluded.llm_driven, ai_profile=excluded.ai_profile,
         token_used=excluded.token_used, token_cap=excluded.token_cap, joined_at=excluded.joined_at`,
    ).run(
      seat.seatId,
      seat.kind,
      nullify(seat.factionId),
      nullify(seat.controllerId),
      // ★node:sqlite 不收 boolean：必须存 0/1
      boolToInt(seat.autoCommit),
      boolToInt(seat.llmDriven),
      nullify(seat.aiProfile),
      seat.tokenUsed,
      seat.tokenCap,
      seat.joinedAt,
    );
  }

  loadState(roomId: string): { state: GameState; digest: string } | null {
    const row = this.getRoomRow(roomId);
    if (!row) return null;
    return {
      state: deserializeState(String(row['state_json']), `room(${roomId}).state_json`),
      digest: String(row['state_digest']),
    };
  }

  saveState(
    roomId: string,
    state: GameState,
    digest: string,
    phase: GameState['phase'],
    turn: number,
    updatedAt: number,
  ): void {
    const room = this.use(roomId);
    const stateJson = serializeState(state, `room(${roomId}).state`);
    stmt(
      room,
      `UPDATE room SET state_json=?, state_digest=?, phase=?, turn=?, updated_at=? WHERE id=?`,
    ).run(stateJson, digest, phase, turn, updatedAt, roomId);
  }

  // ─────────────────────────────────────────────────────────────
  // ★回合提交（单事务：state + turn_record + turn_delta + event_log）
  // ─────────────────────────────────────────────────────────────

  commitTurn(roomId: string, c: TurnCommit): void {
    const room = this.use(roomId);
    tx(room, () => {
      // 回合前状态：事件受众要用它求并集（部队可能在本回合阵亡，事后查不到 ownerId）
      const prevRow = stmt(room, `SELECT state_json FROM room WHERE id=?`).get(roomId) as
        | { state_json?: unknown }
        | undefined;
      const prevState = prevRow?.state_json !== undefined ? deserializeState(String(prevRow.state_json)) : undefined;

      // ① 序列化权威状态（含 NaN/Infinity 体检）—— 坏了就别写任何东西
      const stateJson = serializeState(c.state, `room(${roomId}).turn(${c.turn}).state`);

      // ② 房间头
      const updatedRoom = stmt(
        room,
        `UPDATE room SET state_json=?, state_digest=?, phase=?, turn=?, updated_at=? WHERE id=?`,
      ).run(stateJson, c.stateDigest, c.phase, c.turn, c.resolvedAt, roomId);
      if (updatedRoom.changes === 0) throw new Error(`commitTurn 失败：房间 ${roomId} 不存在（room 行未命中）`);

      // ③ turn_record（★序列化在这里发生：中途抛错必须回滚 ①②）
      const ordersJson = toDbJson(c.orders, `turn_record(${c.turn}).orders_json`);
      const baselineJson = toDbJson(c.baseline, `turn_record(${c.turn}).baseline_json`);
      const eventsJson = toDbJson(c.events, `turn_record(${c.turn}).events_json`);
      const evidenceJson = toDbJson(c.evidence, `turn_record(${c.turn}).evidence_json`);
      const violationsJson = toDbJson(c.violations, `turn_record(${c.turn}).violations_json`);
      const clampsJson = toDbJson(c.clamps, `turn_record(${c.turn}).clamp_json`);
      const rejectedJson = toDbJson(c.rejected, `turn_record(${c.turn}).rejected_json`);
      const llmDeltaJson = c.llmDelta === null || c.llmDelta === undefined ? null : toDbJson(c.llmDelta, `turn_record(${c.turn}).llm_delta_json`);
      const narrativesJson = c.narratives === null || c.narratives === undefined ? null : toDbJson(c.narratives, `turn_record(${c.turn}).narratives_json`);
      stmt(
        room,
        `INSERT INTO turn_record (turn,state_digest,orders_json,baseline_json,llm_delta_json,llm_applied,
                                   violations_json,events_json,evidence_json,narratives_json,clamp_json,rejected_json,resolved_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(turn) DO UPDATE SET
           state_digest=excluded.state_digest, orders_json=excluded.orders_json, baseline_json=excluded.baseline_json,
           llm_delta_json=excluded.llm_delta_json, llm_applied=excluded.llm_applied, violations_json=excluded.violations_json,
           events_json=excluded.events_json, evidence_json=excluded.evidence_json, narratives_json=excluded.narratives_json,
           clamp_json=excluded.clamp_json, rejected_json=excluded.rejected_json, resolved_at=excluded.resolved_at`,
      ).run(
        c.turn,
        c.stateDigest,
        ordersJson,
        baselineJson,
        nullify(llmDeltaJson),
        boolToInt(c.llmApplied),
        nullify(violationsJson),
        eventsJson,
        evidenceJson,
        nullify(narrativesJson),
        nullify(clampsJson),
        nullify(rejectedJson),
        c.resolvedAt,
      );

      // ④ turn_delta（逐字段归因，铁律 8：reason/source 缺一不可）
      assertDeltasAuditable(c.baseline, `room(${roomId}).turn(${c.turn}).turn_delta`);
      stmt(room, `DELETE FROM turn_delta WHERE turn=?`).run(c.turn);
      const insDelta = stmt(
        room,
        `INSERT INTO turn_delta (turn,scope,field,old_value,new_value,delta,reason,source) VALUES (?,?,?,?,?,?,?,?)`,
      );
      for (const d of c.baseline) {
        insDelta.run(c.turn, d.scope, d.field, d.oldValue, d.newValue, d.delta, d.reason, d.source);
      }

      // ⑤ event_log：offset 严格单调递增（本事务内分配，绝不允许空洞或重复）
      this.appendEventsInTx(room, c.events, c.turn, prevState, c.state);

      // ⑥ 本回合的待裁决命令与锁定信号已完成使命
      stmt(room, `DELETE FROM pending_order WHERE turn=?`).run(c.turn);
      stmt(room, `DELETE FROM turn_submission WHERE turn=?`).run(c.turn);
    });
  }

  /** 事务内追加事件（commitTurn 与 appendEvents 共用同一段逻辑与同一套不变量） */
  private appendEventsInTx(
    room: RoomDb,
    events: readonly unknown[],
    turn: number,
    prevState: GameState | undefined,
    nextState: GameState | undefined,
    explicitOffsets?: readonly number[],
  ): number {
    if (events.length === 0) return this.maxOffset(room);
    const maxBefore = this.maxOffset(room);
    const ins = stmt(
      room,
      `INSERT INTO event_log (offset,turn,type,payload_json,audience_json) VALUES (?,?,?,?,?)`,
    );
    let next = maxBefore;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i] as { type?: unknown } | undefined;
      const type = typeof ev?.type === 'string' ? ev.type : '<unknown>';
      const offset = explicitOffsets ? Number(explicitOffsets[i]) : next + 1;
      if (!Number.isInteger(offset) || offset <= 0) {
        throw new Error(`event_log offset 非法：${String(offset)}（必须是正整数）`);
      }
      if (offset <= next) {
        throw new Error(
          `event_log offset 不是严格单调递增：上一批已到 ${next}，本条却是 ${offset}（断线补发会漏事件）`,
        );
      }
      const payloadJson = toDbJson(ev ?? null, `event_log(${offset}).payload_json`);
      const audience: Audience = unionAudience(
        audienceOfEvent(ev, prevState),
        audienceOfEvent(ev, nextState),
      );
      ins.run(offset, turn, type, payloadJson, encodeAudience(audience));
      next = offset;
    }
    return next;
  }

  private maxOffset(room: RoomDb): number {
    const row = stmt(room, `SELECT COALESCE(MAX(offset),0) AS m FROM event_log`).get() as { m?: unknown } | undefined;
    return Number(row?.m ?? 0);
  }

  nextOffset(roomId: string): number {
    return this.maxOffset(this.use(roomId)) + 1;
  }

  appendEvents(
    roomId: string,
    events: ReadonlyArray<{ offset: number; turn: number; type: string; payload: unknown }>,
  ): void {
    const room = this.use(roomId);
    tx(room, () => {
      // 逐条写入：offset 由调用方给定（契约如此），仍然校验严格单调
      const maxBefore = this.maxOffset(room);
      const ins = stmt(
        room,
        `INSERT INTO event_log (offset,turn,type,payload_json,audience_json) VALUES (?,?,?,?,?)`,
      );
      const stateRow = stmt(room, `SELECT state_json FROM room WHERE id=?`).get(roomId) as
        | { state_json?: unknown }
        | undefined;
      const state = stateRow?.state_json !== undefined ? deserializeState(String(stateRow.state_json)) : undefined;
      let next = maxBefore;
      for (const e of events) {
        if (!Number.isInteger(e.offset) || e.offset <= next) {
          throw new Error(
            `appendEvents：offset ${String(e.offset)} 不是严格单调递增（当前最大 ${next}）—— 拒绝写入，事件流不能有空洞或重复`,
          );
        }
        const payloadJson = toDbJson(e.payload ?? null, `event_log(${e.offset}).payload_json`);
        ins.run(e.offset, e.turn, e.type, payloadJson, encodeAudience(audienceOfEvent(e.payload, state)));
        next = e.offset;
      }
    });
  }

  readEvents(
    roomId: string,
    fromOffset: number,
    limit?: number,
  ): Array<{ offset: number; turn: number; type: string; payload: unknown }> {
    return this.readEventRows(roomId, fromOffset, limit).map((r) => ({
      offset: r.offset,
      turn: r.turn,
      type: r.type,
      payload: r.payload,
    }));
  }

  readEventRows(roomId: string, fromOffset: number, limit?: number): EventRow[] {
    const room = this.use(roomId);
    const useLimit = limit !== undefined && Number.isInteger(limit) && limit >= 0;
    const rows = useLimit
      ? stmt(room, `SELECT * FROM event_log WHERE offset>=? ORDER BY offset LIMIT ?`).all(fromOffset, limit)
      : stmt(room, `SELECT * FROM event_log WHERE offset>=? ORDER BY offset`).all(fromOffset);
    return rows.map((r) => {
      const row = plain(r as object) as Record<string, unknown>;
      return {
        offset: Number(row['offset']),
        turn: Number(row['turn']),
        type: String(row['type']),
        payload: fromDbJson<unknown>(row['payload_json'] as string | null, 'event_log.payload_json'),
        audience: decodeAudience(row['audience_json']),
      };
    });
  }

  // ─────────────────────────────────────────────────────────────
  // 回合记录
  // ─────────────────────────────────────────────────────────────

  loadTurn(roomId: string, turn: number): TurnReport | null {
    const rec = this.loadTurnRecord(roomId, turn);
    return rec === null ? null : turnRecordToReport(roomId, rec);
  }

  private loadTurnRecord(roomId: string, turn: number): StoredTurnRecord | null {
    const room = this.use(roomId);
    const row = stmt(room, `SELECT * FROM turn_record WHERE turn=?`).get(turn);
    if (row === undefined) return null;
    return rowToTurnRecord(plain(row as object) as Record<string, unknown>);
  }

  saveNarratives(roomId: string, turn: number, narratives: Readonly<Record<SeatId, string>>): void {
    const room = this.use(roomId);
    const json = toDbJson(narratives, `turn_record(${turn}).narratives_json`);
    const res = stmt(room, `UPDATE turn_record SET narratives_json=? WHERE turn=?`).run(json, turn);
    if (res.changes === 0) {
      throw new Error(`saveNarratives 失败：第 ${turn} 回合的 turn_record 不存在（P11 要求状态先落库、叙事后补写）`);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 待裁决命令与锁定信号
  // ─────────────────────────────────────────────────────────────

  savePendingOrder(roomId: string, order: PendingOrderRow): void {
    const room = this.use(roomId);
    stmt(
      room,
      `INSERT INTO pending_order (turn,seat_id,idx,request_id,faction_id,kind,command_json,created_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(turn,seat_id,idx) DO UPDATE SET
         request_id=excluded.request_id, faction_id=excluded.faction_id, kind=excluded.kind,
         command_json=excluded.command_json, created_at=excluded.created_at`,
    ).run(
      order.turn,
      order.seatId,
      order.index,
      order.requestId,
      order.factionId,
      order.kind,
      toDbJson(order.command, `pending_order(${order.turn},${order.seatId},${order.index})`),
      order.createdAt,
    );
  }

  loadPendingOrders(roomId: string, turn: number): PendingOrderRow[] {
    const room = this.use(roomId);
    const rows = stmt(room, `SELECT * FROM pending_order WHERE turn=? ORDER BY seat_id, idx`).all(turn);
    return rows.map((r) => {
      const row = plain(r as object) as Record<string, unknown>;
      return {
        turn: Number(row['turn']),
        seatId: String(row['seat_id']),
        index: Number(row['idx']),
        requestId: String(row['request_id']),
        factionId: String(row['faction_id']),
        kind: String(row['kind']),
        command: fromDbJson<unknown>(row['command_json'] as string | null, 'pending_order.command_json'),
        createdAt: Number(row['created_at']),
      };
    });
  }

  clearPendingOrders(roomId: string, turn: number): void {
    stmt(this.use(roomId), `DELETE FROM pending_order WHERE turn=?`).run(turn);
  }

  saveSubmission(roomId: string, turn: number, seatId: SeatId, lockedAt: number, timedOut: boolean): void {
    stmt(
      this.use(roomId),
      `INSERT INTO turn_submission (turn,seat_id,locked_at,timed_out) VALUES (?,?,?,?)
       ON CONFLICT(turn,seat_id) DO UPDATE SET locked_at=excluded.locked_at, timed_out=excluded.timed_out`,
    ).run(turn, seatId, lockedAt, boolToInt(timedOut));
  }

  loadSubmissions(roomId: string, turn: number): SubmissionRow[] {
    const rows = stmt(this.use(roomId), `SELECT * FROM turn_submission WHERE turn=? ORDER BY seat_id`).all(turn);
    return rows.map((r) => {
      const row = plain(r as object) as Record<string, unknown>;
      return {
        seatId: String(row['seat_id']),
        lockedAt: Number(row['locked_at']),
        timedOut: intToBool(row['timed_out']),
      };
    });
  }

  clearSubmissions(roomId: string, turn: number): void {
    stmt(this.use(roomId), `DELETE FROM turn_submission WHERE turn=?`).run(turn);
  }

  // ─────────────────────────────────────────────────────────────
  // AI 建议
  // ─────────────────────────────────────────────────────────────

  saveAdvice(roomId: string, advice: AdviceRecord): void {
    const room = this.use(roomId);
    stmt(
      room,
      `INSERT INTO ai_advice (id,turn,seat_id,snapshot_digest,advice_json,commands_json,violations_json,status,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         turn=excluded.turn, seat_id=excluded.seat_id, snapshot_digest=excluded.snapshot_digest,
         advice_json=excluded.advice_json, commands_json=excluded.commands_json,
         violations_json=excluded.violations_json, status=excluded.status, created_at=excluded.created_at`,
    ).run(
      advice.id,
      advice.turn,
      advice.seatId,
      advice.snapshotDigest,
      toDbJson({ ...advice, commands: undefined, violations: undefined }, `ai_advice(${advice.id}).advice_json`),
      toDbJson(advice.commands, `ai_advice(${advice.id}).commands_json`),
      nullify(toDbJson(advice.violations, `ai_advice(${advice.id}).violations_json`)),
      advice.status,
      advice.createdAt,
    );
  }

  loadAdvice(roomId: string, seatId: SeatId, status?: string): AdviceRecord[] {
    const room = this.use(roomId);
    const rows =
      status === undefined
        ? stmt(room, `SELECT * FROM ai_advice WHERE seat_id=? ORDER BY created_at, id`).all(seatId)
        : stmt(room, `SELECT * FROM ai_advice WHERE seat_id=? AND status=? ORDER BY created_at, id`).all(seatId, status);
    return rows.map((r) => rowToAdvice(plain(r as object) as Record<string, unknown>));
  }

  loadAdviceByTurn(roomId: string, turn: number): AdviceRecord[] {
    const rows = stmt(this.use(roomId), `SELECT * FROM ai_advice WHERE turn=? ORDER BY seat_id, id`).all(turn);
    return rows.map((r) => rowToAdvice(plain(r as object) as Record<string, unknown>));
  }

  updateAdviceStatus(roomId: string, adviceId: string, status: string): void {
    stmt(this.use(roomId), `UPDATE ai_advice SET status=? WHERE id=?`).run(status, adviceId);
  }

  // ─────────────────────────────────────────────────────────────
  // 幂等回执（P8）
  // ─────────────────────────────────────────────────────────────

  saveReceipt(roomId: string, receipt: { requestId: string; stateDigest: string; result: CommandResult }): void {
    this.saveReceiptRow(
      roomId,
      receipt.requestId,
      {
        stateDigest: receipt.stateDigest,
        paramsHash: hashParams(receipt.result),
        seatId: null,
        turn: receipt.result.turn,
        result: receipt.result,
      },
      receipt.result.turn,
    );
  }

  saveReceiptRow(roomId: string, requestId: string, row: ReceiptRow, createdAt: number): void {
    stmt(
      this.use(roomId),
      `INSERT INTO command_receipt (request_id,state_digest,params_hash,seat_id,turn,result_json,created_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(request_id) DO UPDATE SET
         state_digest=excluded.state_digest, params_hash=excluded.params_hash, seat_id=excluded.seat_id,
         turn=excluded.turn, result_json=excluded.result_json, created_at=excluded.created_at`,
    ).run(
      requestId,
      row.stateDigest,
      row.paramsHash,
      nullify(row.seatId),
      row.turn,
      toDbJson(row.result, `command_receipt(${requestId}).result_json`),
      createdAt,
    );
  }

  loadReceipt(roomId: string, requestId: string): { stateDigest: string; result: CommandResult } | null {
    const row = this.loadReceiptRow(roomId, requestId);
    return row === null ? null : { stateDigest: row.stateDigest, result: row.result };
  }

  loadReceiptRow(roomId: string, requestId: string): ReceiptRow | null {
    const room = this.use(roomId);
    const row = stmt(room, `SELECT * FROM command_receipt WHERE request_id=?`).get(requestId);
    if (row === undefined) return null;
    const r = plain(row as object) as Record<string, unknown>;
    return {
      stateDigest: String(r['state_digest']),
      paramsHash: String(r['params_hash'] ?? ''),
      seatId: r['seat_id'] === null || r['seat_id'] === undefined ? null : String(r['seat_id']),
      turn: Number(r['turn'] ?? 0),
      result: fromDbJson<CommandResult>(r['result_json'] as string | null, `command_receipt(${requestId}).result_json`)!,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // LLM 记账（★status='stream_broken' 也要落库：断流时 API 已计费）
  // ─────────────────────────────────────────────────────────────

  logLlmCall(roomId: string, entry: LlmCallEntry): void {
    stmt(
      this.use(roomId),
      `INSERT INTO llm_call_log (turn,seat_id,purpose,provider,model,prompt_tokens,completion_tokens,
                                  total_tokens,latency_ms,status,error,requested_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      nullify(entry.turn),
      nullify(entry.seatId),
      entry.purpose,
      entry.provider,
      entry.model,
      nullify(entry.promptTokens),
      nullify(entry.completionTokens),
      nullify(entry.totalTokens),
      nullify(entry.latencyMs),
      entry.status,
      nullify(entry.error),
      entry.requestedAt,
    );
  }

  sumTokens(roomId: string, seatId: SeatId): number {
    const row = stmt(
      this.use(roomId),
      `SELECT COALESCE(SUM(COALESCE(total_tokens,0)),0) AS s FROM llm_call_log WHERE seat_id=?`,
    ).get(seatId) as { s?: unknown } | undefined;
    return Number(row?.s ?? 0);
  }

  // ─────────────────────────────────────────────────────────────
  // 外交文书
  // ─────────────────────────────────────────────────────────────

  saveMessage(roomId: string, m: MessageRow): void {
    stmt(
      this.use(roomId),
      `INSERT INTO message (id,turn,from_seat,to_seat,publicity,require_response,body,created_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         turn=excluded.turn, from_seat=excluded.from_seat, to_seat=excluded.to_seat,
         publicity=excluded.publicity, require_response=excluded.require_response,
         body=excluded.body, created_at=excluded.created_at`,
    ).run(m.id, m.turn, m.fromSeat, nullify(m.toSeat), m.publicity, boolToInt(m.requireResponse), m.body, m.createdAt);
  }

  loadMessages(roomId: string, turn?: number): MessageRow[] {
    const room = this.use(roomId);
    const rows =
      turn === undefined
        ? stmt(room, `SELECT * FROM message ORDER BY created_at, id`).all()
        : stmt(room, `SELECT * FROM message WHERE turn=? ORDER BY created_at, id`).all(turn);
    return rows.map((r) => {
      const row = plain(r as object) as Record<string, unknown>;
      return {
        id: String(row['id']),
        turn: Number(row['turn']),
        fromSeat: String(row['from_seat']),
        toSeat: row['to_seat'] === null || row['to_seat'] === undefined ? null : String(row['to_seat']),
        publicity: row['publicity'] === 'public' ? 'public' : 'non-public',
        requireResponse: intToBool(row['require_response']),
        body: String(row['body']),
        createdAt: Number(row['created_at']),
      };
    });
  }

  // ─────────────────────────────────────────────────────────────
  // 导出 / 删除
  // ─────────────────────────────────────────────────────────────

  buildExport(roomId: string, exportedAt: number): RoomExport {
    const room = this.use(roomId);
    const all = (sql: string): unknown[] => stmt(room, sql).all().map((r) => plain(r as object));
    return {
      format: 'guozhan-room-export',
      version: 1,
      exportedAt,
      room: all(`SELECT * FROM room`),
      seats: all(`SELECT * FROM seat ORDER BY seat_id`),
      turnRecords: all(`SELECT * FROM turn_record ORDER BY turn`),
      turnDeltas: all(`SELECT * FROM turn_delta ORDER BY turn, id`),
      events: all(`SELECT * FROM event_log ORDER BY offset`),
      advice: all(`SELECT * FROM ai_advice ORDER BY created_at, id`),
      receipts: all(`SELECT * FROM command_receipt ORDER BY created_at, request_id`),
      messages: all(`SELECT * FROM message ORDER BY created_at, id`),
      llmCalls: all(`SELECT * FROM llm_call_log ORDER BY id`),
    };
  }

  exportRoom(roomId: string, destPath: string): void {
    // 导出前 flush WAL，保证导出的是完整数据而不是"主档 + 未合并的 -wal"
    try {
      this.use(roomId).db.exec('PRAGMA wal_checkpoint(PASSIVE)');
    } catch {
      /* MEMORY 模式无 WAL */
    }
    const doc = this.buildExport(roomId, Date.now());
    // ①序列化并严格解码 ②临时文件+fsync ③旧档轮转 .bak ④原子 rename ⑤失败回滚
    atomicWriteJson(destPath, doc);
  }

  destroyRoom(roomId: string): void {
    assertSafeRoomId(roomId);
    this.close(roomId);
    const base = this.roomPath(roomId);
    for (const suffix of ['', '-wal', '-shm', '.bak']) {
      try {
        if (existsSync(base + suffix)) rmSync(base + suffix, { force: true });
      } catch {
        /* Windows 上偶发句柄未释放；留给下次删除 */
      }
    }
    // 清理可能残留的临时文件
    try {
      for (const name of readdirSync(this.roomsDir)) {
        if (name.startsWith(`${roomId}.db.tmp-`)) rmSync(join(this.roomsDir, name), { force: true });
      }
    } catch {
      /* 目录不存在就算了 */
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 行 → 领域对象
// ─────────────────────────────────────────────────────────────

function rowToRoom(row: Record<string, unknown>): PersistedRoom {
  return {
    roomId: String(row['id']),
    name: String(row['name']),
    scenarioId: String(row['scenario_id']),
    phase: String(row['phase']) as PersistedRoom['phase'],
    turn: Number(row['turn']),
    maxTurns: Number(row['max_turns']),
    rootSeed: String(row['root_seed']),
    stateJson: String(row['state_json']),
    stateDigest: String(row['state_digest']),
    behaviorFingerprint: Number(row['behavior_fingerprint']),
    contentHash: String(row['content_hash']),
    moduleOrderJson: String(row['module_order_json']),
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at']),
  };
}

/** ★布尔字段往返的唯一出口：SQLite 里是 0/1，交出去必须是真 boolean */
function rowToSeat(row: Record<string, unknown>): PersistedSeat {
  return {
    seatId: String(row['seat_id']),
    kind: String(row['kind']) as PersistedSeat['kind'],
    factionId: row['faction_id'] === null || row['faction_id'] === undefined ? null : String(row['faction_id']),
    controllerId: row['controller'] === null || row['controller'] === undefined ? null : String(row['controller']),
    autoCommit: intToBool(row['auto_commit']),
    llmDriven: intToBool(row['llm_driven']),
    aiProfile: row['ai_profile'] === null || row['ai_profile'] === undefined ? null : String(row['ai_profile']),
    tokenUsed: Number(row['token_used']),
    tokenCap: Number(row['token_cap']),
    joinedAt: Number(row['joined_at']),
  };
}

function rowToTurnRecord(row: Record<string, unknown>): StoredTurnRecord {
  const turn = Number(row['turn']);
  return {
    turn,
    stateDigest: String(row['state_digest']),
    orders: fromDbJsonOr<StoredTurnRecord['orders']>(row['orders_json'] as string | null, [], `turn_record(${turn}).orders_json`),
    baseline: fromDbJsonOr<StoredTurnRecord['baseline']>(row['baseline_json'] as string | null, [], `turn_record(${turn}).baseline_json`),
    llmDelta: fromDbJson<unknown>(row['llm_delta_json'] as string | null, `turn_record(${turn}).llm_delta_json`),
    llmApplied: intToBool(row['llm_applied']),
    violations: fromDbJsonOr<StoredTurnRecord['violations']>(row['violations_json'] as string | null, [], `turn_record(${turn}).violations_json`),
    events: fromDbJsonOr<readonly unknown[]>(row['events_json'] as string | null, [], `turn_record(${turn}).events_json`),
    evidence: fromDbJsonOr<readonly unknown[]>(row['evidence_json'] as string | null, [], `turn_record(${turn}).evidence_json`),
    narratives: fromDbJson<StoredTurnRecord['narratives']>(row['narratives_json'] as string | null, `turn_record(${turn}).narratives_json`),
    clamps: fromDbJsonOr<StoredTurnRecord['clamps']>(row['clamp_json'] as string | null, [], `turn_record(${turn}).clamp_json`),
    rejected: fromDbJsonOr<StoredTurnRecord['rejected']>(row['rejected_json'] as string | null, [], `turn_record(${turn}).rejected_json`),
    resolvedAt: Number(row['resolved_at']),
  };
}

function rowToAdvice(row: Record<string, unknown>): AdviceRecord {
  const base = fromDbJson<Record<string, unknown>>(row['advice_json'] as string | null, `ai_advice.advice_json`)!;
  const commands = fromDbJsonOr<AdviceRecord['commands']>(row['commands_json'] as string | null, [], 'ai_advice.commands_json');
  const violations = fromDbJsonOr<AdviceRecord['violations']>(row['violations_json'] as string | null, [], 'ai_advice.violations_json');
  return {
    ...(base as unknown as AdviceRecord),
    id: String(row['id']),
    turn: Number(row['turn']),
    seatId: String(row['seat_id']),
    snapshotDigest: String(row['snapshot_digest']),
    status: String(row['status']) as AdviceRecord['status'],
    createdAt: Number(row['created_at']),
    commands,
    violations,
  };
}

// ─────────────────────────────────────────────────────────────
// 房间注册表（data/index.db）
// ─────────────────────────────────────────────────────────────

export interface SqliteIndexOptions {
  readonly dataDir?: string;
  readonly busyTimeoutMs?: number;
  readonly journalMode?: 'WAL' | 'MEMORY' | 'DELETE';
}

export class SqliteRoomIndex implements RoomIndex {
  readonly path: string;
  private readonly db: DatabaseSync;
  private readonly stmts: Map<string, StatementSync> = new Map();

  constructor(opts: SqliteIndexOptions = {}) {
    const dataDir = resolve(opts.dataDir ?? 'data');
    mkdirSync(dataDir, { recursive: true });
    this.path = join(dataDir, 'index.db');
    this.db = new DatabaseSync(this.path);
    if ((opts.journalMode ?? 'WAL') === 'WAL') this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA synchronous=NORMAL');
    this.db.exec(`PRAGMA busy_timeout=${Math.max(0, Math.floor(opts.busyTimeoutMs ?? 5000))}`);
    this.db.exec(INDEX_SCHEMA_SQL);
    this.prepare(`INSERT INTO schema_meta(key,value) VALUES('index_schema_version',?) ON CONFLICT(key) DO NOTHING`).run(
      INDEX_SCHEMA_VERSION,
    );
  }

  private prepare(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  upsert(entry: {
    roomId: string;
    name: string;
    scenarioId: string;
    createdAt: number;
    updatedAt: number;
    phase: string;
    turn: number;
  }): void {
    assertSafeRoomId(entry.roomId);
    this.prepare(
      `INSERT INTO room_index (room_id,name,scenario_id,created_at,updated_at,phase,turn)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(room_id) DO UPDATE SET
         name=excluded.name, scenario_id=excluded.scenario_id, updated_at=excluded.updated_at,
         phase=excluded.phase, turn=excluded.turn`,
    ).run(entry.roomId, entry.name, entry.scenarioId, entry.createdAt, entry.updatedAt, entry.phase, entry.turn);
  }

  list(): Array<{
    roomId: string;
    name: string;
    scenarioId: string;
    createdAt: number;
    updatedAt: number;
    phase: string;
    turn: number;
  }> {
    const rows = this.prepare(`SELECT * FROM room_index ORDER BY updated_at DESC, room_id`).all();
    return rows.map((r) => {
      const row = plain(r as object) as Record<string, unknown>;
      return {
        roomId: String(row['room_id']),
        name: String(row['name']),
        scenarioId: String(row['scenario_id']),
        createdAt: Number(row['created_at']),
        updatedAt: Number(row['updated_at']),
        phase: String(row['phase']),
        turn: Number(row['turn']),
      };
    });
  }

  remove(roomId: string): void {
    this.prepare(`DELETE FROM room_index WHERE room_id=?`).run(roomId);
  }

  close(): void {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      /* 无 WAL */
    }
    this.db.close();
  }
}

/** 便捷工厂：一次性建好注册表 + 房间库存储 */
export function createSqliteStore(opts: SqliteStoreOptions = {}): { store: SqliteRoomStore; index: SqliteRoomIndex } {
  return { store: new SqliteRoomStore(opts), index: new SqliteRoomIndex(opts) };
}

export { digestState };
