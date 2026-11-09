-- ═══════════════════════════════════════════════════════════════════════
-- 每房间库 schema（data/rooms/<roomId>.db）
--
-- 依据：docs/02-架构设计文档.md §5.2。
-- ★与 §5.2 的**附加差异**（全部为「契约 src/server/room/types.ts 要求、
--   而文档表结构草案未列出」的列/表，只增不改，附理由）：
--     seat.faction_id      PersistedSeat.factionId（观战席位为 NULL；
--                          文档假设 seat_id = faction id，但观战席位没有势力）
--     seat.llm_driven      PersistedSeat.llmDriven（P14 分级策略：次级国家不调 LLM）
--     turn_record.state_digest / rejected_json / llm_applied
--                          loadTurn() 必须还原出完整 TurnReport（含 rejected 与
--                          llmApplied），文档草案里没有落点
--     command_receipt.params_hash / seat_id / turn
--                          P8 幂等：「同 id 同参 → replayed；同 id 异参 → 409」
--                          需要记住当时的参数指纹才能区分同参/异参
--     event_log.audience_json
--                          战争迷雾：事件按接收者裁剪后再下发。受众在**写库时**
--                          算好并存下，断线重连补发才不受"当前状态已变"影响
--     pending_order / turn_submission
--                          同时提交模型下，"已提交但尚未结算"的命令必须落库，
--                          否则进程重启会静默吞掉人类玩家已经下过的令
--
-- ★布尔一律存 0/1：node:sqlite 不接受 JS boolean 绑定，读出时由 codec 转回。
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ── 权威状态与房间头 ──
CREATE TABLE IF NOT EXISTS room (
  id                     TEXT PRIMARY KEY,
  name                   TEXT NOT NULL,
  scenario_id            TEXT NOT NULL,
  phase                  TEXT NOT NULL,
  turn                   INTEGER NOT NULL DEFAULT 0,
  max_turns              INTEGER NOT NULL,
  root_seed              TEXT NOT NULL,
  state_json             TEXT NOT NULL,
  state_digest           TEXT NOT NULL,
  behavior_fingerprint   INTEGER NOT NULL,
  content_hash           TEXT NOT NULL,
  module_order_json      TEXT NOT NULL,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);

-- ── 席位：人类 / AI / 观战 ──
CREATE TABLE IF NOT EXISTS seat (
  seat_id        TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,
  faction_id     TEXT,
  controller     TEXT,
  auto_commit    INTEGER NOT NULL DEFAULT 0,
  llm_driven     INTEGER NOT NULL DEFAULT 0,
  ai_profile     TEXT,
  token_used     INTEGER NOT NULL DEFAULT 0,
  token_cap      INTEGER NOT NULL DEFAULT 200000,
  joined_at      INTEGER NOT NULL
  -- ★不声明外键：每房间一个库，删房间 = 删文件，库内不存在跨房间引用；
  --   而 seat_id / turn 都不是 room.id 的合法外键（类型与语义都不对）。
);

-- ── 每回合记录：确定性基线与 LLM delta 分列存 ──
CREATE TABLE IF NOT EXISTS turn_record (
  turn            INTEGER PRIMARY KEY,
  state_digest    TEXT NOT NULL,
  orders_json     TEXT NOT NULL,
  baseline_json   TEXT NOT NULL,
  llm_delta_json  TEXT,
  llm_applied     INTEGER NOT NULL DEFAULT 0,
  violations_json TEXT,
  events_json     TEXT NOT NULL,
  evidence_json   TEXT NOT NULL,
  narratives_json TEXT,
  clamp_json      TEXT,
  rejected_json   TEXT,
  resolved_at     INTEGER NOT NULL
);

-- ── 逐字段增量归因（"这个数为什么变成这样"）──
CREATE TABLE IF NOT EXISTS turn_delta (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  turn      INTEGER NOT NULL,
  scope     TEXT NOT NULL,
  field     TEXT NOT NULL,
  old_value REAL NOT NULL,
  new_value REAL NOT NULL,
  delta     REAL NOT NULL,
  reason    TEXT NOT NULL,
  source    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turn_delta_turn ON turn_delta (turn);

-- ── AI 建议 ──
CREATE TABLE IF NOT EXISTS ai_advice (
  id               TEXT PRIMARY KEY,
  turn             INTEGER NOT NULL,
  seat_id          TEXT NOT NULL,
  snapshot_digest  TEXT NOT NULL,
  advice_json      TEXT NOT NULL,
  commands_json    TEXT NOT NULL,
  violations_json  TEXT,
  status           TEXT NOT NULL,
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_advice_seat ON ai_advice (seat_id, status);
CREATE INDEX IF NOT EXISTS idx_ai_advice_turn ON ai_advice (turn);

-- ── 命令幂等回执（P8）──
CREATE TABLE IF NOT EXISTS command_receipt (
  request_id   TEXT PRIMARY KEY,
  state_digest TEXT NOT NULL,
  params_hash  TEXT NOT NULL,
  seat_id      TEXT,
  turn         INTEGER NOT NULL DEFAULT 0,
  result_json  TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

-- ── 事件日志：单调 offset ──
CREATE TABLE IF NOT EXISTS event_log (
  offset        INTEGER PRIMARY KEY,
  turn          INTEGER NOT NULL,
  type          TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  audience_json TEXT NOT NULL DEFAULT '"all"'
);
CREATE INDEX IF NOT EXISTS idx_event_log_turn ON event_log (turn);

-- ── 外交文书 / 密约 ──
CREATE TABLE IF NOT EXISTS message (
  id               TEXT PRIMARY KEY,
  turn             INTEGER NOT NULL,
  from_seat        TEXT NOT NULL,
  to_seat          TEXT,
  publicity        TEXT NOT NULL,
  require_response INTEGER NOT NULL DEFAULT 0,
  body             TEXT NOT NULL,
  created_at       INTEGER NOT NULL
);

-- ── LLM 调用记账（per-call，★断流也记账）──
CREATE TABLE IF NOT EXISTS llm_call_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  turn              INTEGER,
  seat_id           TEXT,
  purpose           TEXT NOT NULL,
  provider          TEXT NOT NULL,
  model             TEXT NOT NULL,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  total_tokens      INTEGER,
  latency_ms        INTEGER,
  status            TEXT NOT NULL,
  error             TEXT,
  requested_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_llm_call_seat ON llm_call_log (seat_id);

-- ── AI 跨回合记忆 ──
CREATE TABLE IF NOT EXISTS ai_memory (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  seat_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  body       TEXT NOT NULL,
  weight     INTEGER NOT NULL DEFAULT 1,
  turn       INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- ── 本回合已提交、尚未结算的命令（同时提交模型的"待裁决区"）──
CREATE TABLE IF NOT EXISTS pending_order (
  turn         INTEGER NOT NULL,
  seat_id      TEXT NOT NULL,
  idx          INTEGER NOT NULL,
  request_id   TEXT NOT NULL,
  faction_id   TEXT NOT NULL,
  kind         TEXT NOT NULL,
  command_json TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (turn, seat_id, idx)
);

-- ── 席位锁定信号（lockOrders / timeoutLock）──
CREATE TABLE IF NOT EXISTS turn_submission (
  turn       INTEGER NOT NULL,
  seat_id    TEXT NOT NULL,
  locked_at  INTEGER NOT NULL,
  timed_out  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (turn, seat_id)
);
