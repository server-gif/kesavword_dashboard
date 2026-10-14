-- D1 schema for the dashboard Worker (replaces the local ./data files).
-- users.json          -> users (whole list is read/written as one JSON value, like before)
-- trash.json          -> settings key 'trash'
-- ignored.json        -> settings key 'ignored'
-- activity.jsonl      -> activity
-- history/*.json.gz   -> diffs
-- dbip-country-lite   -> geo (loaded from tools/export-geo.mjs output)

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  user TEXT NOT NULL,
  name TEXT NOT NULL,
  action TEXT NOT NULL,
  path TEXT,
  to_path TEXT,
  detail TEXT,
  size INTEGER,
  has_diff INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity (ts);

CREATE TABLE IF NOT EXISTS diffs (
  id TEXT PRIMARY KEY,
  gz BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Overview / API-detail summaries (L2 cache). Kept out of `settings` so the cron can prune
-- stale rows by timestamp; lets a cold isolate serve a warm result without touching SFTP.
CREATE TABLE IF NOT EXISTS cache (
  key TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cache_at ON cache (at);

CREATE TABLE IF NOT EXISTS geo (
  start INTEGER PRIMARY KEY,
  "end" INTEGER NOT NULL,
  cc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_geo_start ON geo (start);
