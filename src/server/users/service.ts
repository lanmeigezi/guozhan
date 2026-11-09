import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hashPassword, verifyPassword } from './password.ts';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const USERNAME_RE = /^[\p{L}\p{N}_-]{2,24}$/u;

export interface PublicUser {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly role: 'user' | 'admin';
  readonly createdAt: number;
  readonly lastSeenAt: number;
}

export interface RoomMember {
  readonly roomId: string;
  readonly userId: string;
  readonly username: string;
  readonly displayName: string;
  readonly seatId: string;
  readonly joinedAt: number;
}

export interface RoomHost {
  readonly userId: string;
  readonly username: string;
  readonly displayName: string;
}

export interface RoomBan {
  readonly userId: string;
  readonly username: string;
  readonly displayName: string;
  readonly reason: string;
  readonly createdAt: number;
}

export class UserServiceError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'UserServiceError';
    this.status = status;
    this.code = code;
  }
}

export interface UserServiceOptions {
  readonly dataDir: string;
  readonly now?: () => number;
  readonly sessionTtlMs?: number;
}

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  password_salt: string;
  role: string;
  created_at: number;
  last_seen_at: number;
}

interface SessionRow {
  token_hash: string;
  user_id: string;
  expires_at: number;
}

function asUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role === 'admin' ? 'admin' : 'user',
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

function normalizeUsername(raw: string): string {
  const username = String(raw ?? '').trim().toLowerCase();
  if (!USERNAME_RE.test(username)) {
    throw new UserServiceError(400, 'INVALID_USERNAME', '用户名需为 2–24 位字母、数字、下划线、连字符或中文');
  }
  return username;
}

function normalizeDisplayName(raw: string | undefined, fallback: string): string {
  const displayName = String(raw ?? '').trim() || fallback;
  if (displayName.length > 32) {
    throw new UserServiceError(400, 'INVALID_DISPLAY_NAME', '昵称不能超过 32 个字符');
  }
  return displayName;
}

function validatePassword(raw: string): string {
  const password = String(raw ?? '');
  if (password.length < 8 || password.length > 128) {
    throw new UserServiceError(400, 'INVALID_PASSWORD', '密码长度需为 8–128 个字符');
  }
  return password;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * 账号与房间成员关系存储。
 *
 * 这是一个**独立于每房间游戏库**的全局库：用户、会话、房主、成员、房间封禁。
 * 游戏状态仍只写每房间 SQLite；这里不碰任何 GameState。
 */
export class UserService {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly sessionTtlMs: number;
  private closed = false;

  constructor(opts: UserServiceOptions) {
    mkdirSync(opts.dataDir, { recursive: true });
    this.now = opts.now ?? (() => Date.now());
    this.sessionTtlMs = opts.sessionTtlMs ?? SESSION_TTL_MS;
    this.db = new DatabaseSync(join(opts.dataDir, 'users.db'));
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS users (
        id            TEXT PRIMARY KEY,
        username      TEXT NOT NULL UNIQUE,
        display_name  TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        role          TEXT NOT NULL DEFAULT 'user',
        created_at    INTEGER NOT NULL,
        last_seen_at  INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash   TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at   INTEGER NOT NULL,
        expires_at   INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE TABLE IF NOT EXISTS room_hosts (
        room_id    TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS room_members (
        room_id   TEXT NOT NULL,
        user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        seat_id   TEXT NOT NULL,
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (room_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_room_members_room ON room_members(room_id);
      CREATE TABLE IF NOT EXISTS room_bans (
        room_id    TEXT NOT NULL,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reason     TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        PRIMARY KEY (room_id, user_id)
      );
    `);
    this.pruneSessions();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  register(input: { username: string; password: string; displayName?: string }): { user: PublicUser; token: string } {
    const username = normalizeUsername(input.username);
    const password = validatePassword(input.password);
    const displayName = normalizeDisplayName(input.displayName, username);
    const now = this.now();
    const id = `u_${randomBytes(9).toString('base64url')}`;
    const { hash, salt } = hashPassword(password);
    try {
      this.db.prepare(
        `INSERT INTO users (id, username, display_name, password_hash, password_salt, role, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, 'user', ?, ?)`,
      ).run(id, username, displayName, hash, salt, now, now);
    } catch (err) {
      if (String(err).toLowerCase().includes('unique')) {
        throw new UserServiceError(409, 'USERNAME_TAKEN', '用户名已被占用');
      }
      throw err;
    }
    const user = this.getUserRow(id);
    if (!user) throw new Error('创建账号后无法读取用户');
    return { user: asUser(user), token: this.createSession(id) };
  }

  login(input: { username: string; password: string }): { user: PublicUser; token: string } {
    const username = normalizeUsername(input.username);
    const row = this.db
      .prepare('SELECT * FROM users WHERE username = ?')
      .get(username) as UserRow | undefined;
    // 账号不存在与密码错误返回同一错误，避免枚举用户名
    if (!row || !verifyPassword(String(input.password ?? ''), row.password_salt, row.password_hash)) {
      throw new UserServiceError(401, 'INVALID_CREDENTIALS', '用户名或密码错误');
    }
    const now = this.now();
    this.db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now, row.id);
    const user = this.getUserRow(row.id)!;
    return { user: asUser(user), token: this.createSession(row.id) };
  }

  logout(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  }

  resolveSession(token: string): PublicUser | null {
    if (!token.startsWith('usr_')) return null;
    this.pruneSessions();
    const row = this.db
      .prepare(
        `SELECT s.token_hash, s.user_id, s.expires_at, u.*
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ?`,
      )
      .get(hashToken(token)) as (UserRow & SessionRow) | undefined;
    if (!row || row.expires_at <= this.now()) return null;
    const now = this.now();
    this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(now, row.token_hash);
    this.db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now, row.user_id);
    return asUser(row);
  }

  getUser(userId: string): PublicUser | null {
    const row = this.getUserRow(userId);
    return row ? asUser(row) : null;
  }

  listUsers(limit = 100): PublicUser[] {
    const rows = this.db
      .prepare('SELECT * FROM users ORDER BY created_at DESC LIMIT ?')
      .all(Math.max(1, Math.min(500, limit))) as unknown as UserRow[];
    return rows.map(asUser);
  }

  setRoomHost(roomId: string, userId: string): void {
    this.db
      .prepare(
        `INSERT INTO room_hosts (room_id, user_id, created_at) VALUES (?, ?, ?)
         ON CONFLICT(room_id) DO UPDATE SET user_id = excluded.user_id`,
      )
      .run(roomId, userId, this.now());
  }

  getRoomHost(roomId: string): RoomHost | null {
    const row = this.db
      .prepare(
        `SELECT u.id, u.username, u.display_name
         FROM room_hosts h JOIN users u ON u.id = h.user_id
         WHERE h.room_id = ?`,
      )
      .get(roomId) as { id: string; username: string; display_name: string } | undefined;
    return row ? { userId: row.id, username: row.username, displayName: row.display_name } : null;
  }

  removeRoomHost(roomId: string): void {
    this.db.prepare('DELETE FROM room_hosts WHERE room_id = ?').run(roomId);
  }

  setMember(roomId: string, userId: string, seatId: string): void {
    this.db
      .prepare(
        `INSERT INTO room_members (room_id, user_id, seat_id, joined_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(room_id, user_id) DO UPDATE SET seat_id = excluded.seat_id`,
      )
      .run(roomId, userId, seatId, this.now());
  }

  getMember(roomId: string, userId: string): RoomMember | null {
    const row = this.db
      .prepare(
        `SELECT m.room_id, m.user_id, m.seat_id, m.joined_at, u.username, u.display_name
         FROM room_members m JOIN users u ON u.id = m.user_id
         WHERE m.room_id = ? AND m.user_id = ?`,
      )
      .get(roomId, userId) as
      | { room_id: string; user_id: string; seat_id: string; joined_at: number; username: string; display_name: string }
      | undefined;
    return row
      ? {
          roomId: row.room_id,
          userId: row.user_id,
          username: row.username,
          displayName: row.display_name,
          seatId: row.seat_id,
          joinedAt: row.joined_at,
        }
      : null;
  }

  listMembers(roomId: string): RoomMember[] {
    const rows = this.db
      .prepare(
        `SELECT m.room_id, m.user_id, m.seat_id, m.joined_at, u.username, u.display_name
         FROM room_members m JOIN users u ON u.id = m.user_id
         WHERE m.room_id = ? ORDER BY m.joined_at ASC`,
      )
      .all(roomId) as Array<{
      room_id: string;
      user_id: string;
      seat_id: string;
      joined_at: number;
      username: string;
      display_name: string;
    }>;
    return rows.map((row) => ({
      roomId: row.room_id,
      userId: row.user_id,
      username: row.username,
      displayName: row.display_name,
      seatId: row.seat_id,
      joinedAt: row.joined_at,
    }));
  }

  listMemberships(userId: string): RoomMember[] {
    const rows = this.db
      .prepare(
        `SELECT m.room_id, m.user_id, m.seat_id, m.joined_at, u.username, u.display_name
         FROM room_members m JOIN users u ON u.id = m.user_id
         WHERE m.user_id = ? ORDER BY m.joined_at DESC`,
      )
      .all(userId) as Array<{
      room_id: string;
      user_id: string;
      seat_id: string;
      joined_at: number;
      username: string;
      display_name: string;
    }>;
    return rows.map((row) => ({
      roomId: row.room_id,
      userId: row.user_id,
      username: row.username,
      displayName: row.display_name,
      seatId: row.seat_id,
      joinedAt: row.joined_at,
    }));
  }

  removeMember(roomId: string, userId: string): void {
    this.db.prepare('DELETE FROM room_members WHERE room_id = ? AND user_id = ?').run(roomId, userId);
  }

  ban(roomId: string, userId: string, reason = ''): void {
    this.db
      .prepare(
        `INSERT INTO room_bans (room_id, user_id, reason, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(room_id, user_id) DO UPDATE SET reason = excluded.reason, created_at = excluded.created_at`,
      )
      .run(roomId, userId, String(reason).slice(0, 200), this.now());
  }

  unban(roomId: string, userId: string): void {
    this.db.prepare('DELETE FROM room_bans WHERE room_id = ? AND user_id = ?').run(roomId, userId);
  }

  isBanned(roomId: string, userId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM room_bans WHERE room_id = ? AND user_id = ?').get(roomId, userId));
  }

  listBans(roomId: string): RoomBan[] {
    const rows = this.db
      .prepare(
        `SELECT b.user_id, b.reason, b.created_at, u.username, u.display_name
         FROM room_bans b JOIN users u ON u.id = b.user_id
         WHERE b.room_id = ? ORDER BY b.created_at DESC`,
      )
      .all(roomId) as Array<{
      user_id: string;
      reason: string;
      created_at: number;
      username: string;
      display_name: string;
    }>;
    return rows.map((row) => ({
      userId: row.user_id,
      username: row.username,
      displayName: row.display_name,
      reason: row.reason,
      createdAt: row.created_at,
    }));
  }

  deleteRoomData(roomId: string): void {
    this.db.prepare('DELETE FROM room_bans WHERE room_id = ?').run(roomId);
    this.db.prepare('DELETE FROM room_members WHERE room_id = ?').run(roomId);
    this.db.prepare('DELETE FROM room_hosts WHERE room_id = ?').run(roomId);
  }

  private getUserRow(userId: string): UserRow | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined;
    return row ?? null;
  }

  private createSession(userId: string): string {
    const token = `usr_${randomBytes(32).toString('base64url')}`;
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(hashToken(token), userId, now, now + this.sessionTtlMs, now);
    return token;
  }

  private pruneSessions(): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(this.now());
  }
}

export function createUserService(opts: UserServiceOptions): UserService {
  return new UserService(opts);
}
