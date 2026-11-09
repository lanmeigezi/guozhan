-- ═══════════════════════════════════════════════════════════════════════
-- 房间注册表（data/index.db）
--
-- 存在的唯一理由：listRooms() 不必打开每个房间库（文件句柄 + WAL 恢复成本）。
-- 它只存"列表页要显示的最小字段"；任何权威数据一律以 data/rooms/<id>.db 为准，
-- 两者不一致时以房间库为准（本表是可重建的派生索引）。
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS room_index (
  room_id     TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  phase       TEXT NOT NULL,
  turn        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_room_index_updated ON room_index (updated_at DESC);
