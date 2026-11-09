/**
 * 原子写与恢复纪律 —— 架构文档 §5.4（aonw `PersistenceFileStore` 五步）。
 *
 *   ① 序列化并严格解码  ② 写临时文件并 fsync  ③ 旧主档轮转为 .bak（last-known-good）
 *   ④ 原子 rename 安装   ⑤ 任一步失败 ⇒ 回滚（把 .bak 复位、删临时文件）
 *
 *   恢复：主档校验失败 ⇒ 提升 .bak 并修复主档；两者都失败 ⇒ **抛错，会话保持原样**，
 *         绝不静默清空（清空 = 玩家的一整局蒸发，比拒绝启动严重得多）。
 *
 * 房间库本身由 SQLite 的事务 + WAL 保证原子性；本文件服务的是**整房间导出/备份**
 * （RoomStore.exportRoom）这类"一个文件就是一场对局"的写入。
 *
 * ★只用 Node 内置模块，零依赖。
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

let tempCounter = 0;

export interface AtomicWriteOptions {
  /** 是否 fsync 文件与父目录（默认 true；测试可以关掉换速度，但导出路径不该关） */
  readonly fsync?: boolean;
}

export interface AtomicWriteResult {
  readonly path: string;
  readonly bytes: number;
  /** 本次是否轮转出了 .bak（首次写入时为 null） */
  readonly backupPath: string | null;
}

export function backupPathOf(destPath: string): string {
  return `${destPath}.bak`;
}

function tempPathOf(destPath: string): string {
  tempCounter = (tempCounter + 1) % 1_000_000;
  return `${destPath}.tmp-${process.pid}-${tempCounter}`;
}

function tryFsyncPath(path: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    fsyncSync(fd);
  } catch {
    // Windows 上目录不可 fsync（EPERM/EISDIR）；文件已 fsync 就够了
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* 已关 */ }
    }
  }
}

/**
 * ②③④⑤：把**已经序列化好的**内容原子安装到 destPath。
 * 调用方负责第①步（序列化并严格解码）—— 见 atomicWriteJson。
 */
export function atomicWriteFile(destPath: string, content: string, opts: AtomicWriteOptions = {}): AtomicWriteResult {
  const doFsync = opts.fsync !== false;
  const target = resolve(destPath);
  const backup = backupPathOf(target);
  const temp = tempPathOf(target);
  let tempWritten = false;
  let rotated = false;

  try {
    // ② 写临时文件并 fsync（临时文件与目标同目录 ⇒ rename 一定是原子的同卷操作）
    //   ★父目录可能还不存在（首次导出到新建的备份目录）：先建，否则 writeFileSync 直接 ENOENT
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(temp, content, 'utf8');
    tempWritten = true;
    if (doFsync) {
      tryFsyncPath(temp);
      tryFsyncPath(dirname(target));
    }

    // ③ 旧主档轮转为 .bak（last-known-good）
    if (existsSync(target)) {
      renameSync(target, backup);
      rotated = true;
    }

    // ④ 原子安装
    renameSync(temp, target);
    tempWritten = false;
    if (doFsync) tryFsyncPath(dirname(target));

    return { path: target, bytes: Buffer.byteLength(content, 'utf8'), backupPath: rotated ? backup : null };
  } catch (err) {
    // ⑤ 回滚：把 .bak 复位成主档，清掉临时文件
    try {
      if (rotated && existsSync(backup) && !existsSync(target)) renameSync(backup, target);
    } catch { /* 回滚失败时不能再抛，掩盖原始错误更糟 */ }
    try {
      if (tempWritten && existsSync(temp)) unlinkSync(temp);
    } catch { /* 同上 */ }
    throw err;
  }
}

/**
 * ①+②③④⑤：序列化 → **严格解码校验** → 原子安装。
 *
 * "严格解码"不是走形式：JSON.stringify 遇到循环引用会抛，遇到 bigint 会抛，
 * 而遇到 NaN/Infinity 会**静默写成 null** —— 所以这里额外用 reviver 扫一遍，
 * 任何数值字段变成 null 而原值是数字的情况都当作损坏（findHoles 的同款纪律）。
 */
export function atomicWriteJson(destPath: string, value: unknown, opts: AtomicWriteOptions = {}): AtomicWriteResult {
  const content = serializeStrict(value, destPath);
  return atomicWriteFile(destPath, content, opts);
}

export function serializeStrict(value: unknown, label = 'value'): string {
  let raw: string;
  try {
    raw = JSON.stringify(value);
  } catch (err) {
    throw new Error(`原子写第①步失败：${label} 无法序列化 —— ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof raw !== 'string') {
    throw new Error(`原子写第①步失败：${label} 序列化得到 ${String(raw)}`);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (err) {
    throw new Error(`原子写第①步失败：${label} 的序列化产物无法解码 —— ${err instanceof Error ? err.message : String(err)}`);
  }
  const lost = countNonFiniteNumbers(value);
  if (lost > 0) {
    throw new Error(`原子写第①步失败：${label} 含 ${lost} 处 NaN/Infinity，JSON 会把它们静默写成 null（拒绝落盘）`);
  }
  if (decoded === undefined) {
    throw new Error(`原子写第①步失败：${label} 解码为 undefined`);
  }
  return raw;
}

/** 深度统计 NaN/Infinity 的个数（不含 undefined：JSON 里 undefined 字段本就应消失） */
function countNonFiniteNumbers(value: unknown, seen = new Set<unknown>()): number {
  if (typeof value === 'number') return Number.isFinite(value) ? 0 : 1;
  if (value === null || typeof value !== 'object') return 0;
  if (seen.has(value)) return 0;
  seen.add(value);
  let n = 0;
  if (Array.isArray(value)) {
    for (const v of value) n += countNonFiniteNumbers(v, seen);
    return n;
  }
  for (const v of Object.values(value as Record<string, unknown>)) n += countNonFiniteNumbers(v, seen);
  return n;
}

export interface RecoveryResult<T> {
  readonly value: T;
  /** 'primary' = 主档完好；'backup' = 主档坏了、已提升 .bak */
  readonly source: 'primary' | 'backup';
  /** source==='backup' 时为 true：已把 .bak 内容重新原子安装回主档 */
  readonly repaired: boolean;
}

/**
 * 恢复：主档 → .bak → 都坏则抛错（**不静默清空**）。
 *
 * @param decode 严格解码器；抛错即视为该档损坏
 */
export function readWithRecovery<T>(primaryPath: string, decode: (raw: string) => T): RecoveryResult<T> {
  const target = resolve(primaryPath);
  const backup = backupPathOf(target);

  const primaryError = tryRead(target, decode);
  if (primaryError.kind === 'ok') return { value: primaryError.value as T, source: 'primary', repaired: false };

  const backupRead = tryRead(backup, decode);
  if (backupRead.kind === 'ok') {
    // 提升 .bak 并修复主档（修复本身也走原子写，失败不影响本次读取成功）
    let repaired = false;
    try {
      const raw = readFileSync(backup, 'utf8');
      atomicWriteFile(target, raw);
      repaired = true;
    } catch {
      repaired = false;
    }
    return { value: backupRead.value as T, source: 'backup', repaired };
  }

  // 两者都坏：保留现场（不删任何文件），把两份错误一起报出来
  const detail = [
    `主档 ${target}：${primaryError.kind === 'missing' ? '文件不存在' : primaryError.message}`,
    existsSync(backup) ? `备份 ${backup}：${backupRead.kind === 'missing' ? '文件不存在' : backupRead.message}` : `备份 ${backup}：文件不存在`,
  ].join('\n  ');
  throw new Error(
    `恢复失败：主档与 .bak 都无法解码，会话数据保持原样（未清空、未覆盖）。\n  ${detail}`,
  );
}

type ReadAttempt<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'missing' }
  | { kind: 'corrupt'; message: string };

function tryRead<T>(path: string, decode: (raw: string) => T): ReadAttempt<T> {
  if (!existsSync(path)) return { kind: 'missing' };
  try {
    if (!statSync(path).isFile()) return { kind: 'corrupt', message: '不是普通文件' };
    const raw = readFileSync(path, 'utf8');
    return { kind: 'ok', value: decode(raw) };
  } catch (err) {
    return { kind: 'corrupt', message: err instanceof Error ? err.message : String(err) };
  }
}

/** 测试与运维用：安全删除（不存在也不报错） */
export function tryRemove(path: string): boolean {
  try {
    if (!existsSync(path)) return false;
    rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}
