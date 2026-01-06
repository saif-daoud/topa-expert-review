-- 0004_expert_review.sql
-- Expert review tables: chunk locking + utterance-level labels + progress

CREATE TABLE IF NOT EXISTS chunk_claims (
  chunk_id   INTEGER PRIMARY KEY,
  code_hash  TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunk_claims_code_hash ON chunk_claims(code_hash);

CREATE TABLE IF NOT EXISTS utterance_reviews (
  id TEXT PRIMARY KEY,                 -- code_hash__chunk_id__item_key
  code_hash TEXT NOT NULL,
  chunk_id INTEGER NOT NULL,
  item_key TEXT NOT NULL,              -- user_idx__session_idx__utterance_id

  user_idx INTEGER NOT NULL,
  session_idx INTEGER NOT NULL,
  utterance_id TEXT NOT NULL,

  auto_macro_action TEXT,
  auto_micro_action TEXT,
  auto_confidence_score REAL,

  expert_macro_action TEXT NOT NULL,
  expert_micro_action TEXT NOT NULL,   -- includes 'None' or custom
  expert_micro_custom TEXT,            -- non-null when expert typed a custom label
  expert_confidence_1_10 INTEGER,      -- nullable
  expert_note TEXT,                    -- nullable

  timestamp_utc TEXT,
  user_agent TEXT,
  page_url TEXT,

  reviewed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reviews_code_chunk ON utterance_reviews(code_hash, chunk_id);
CREATE INDEX IF NOT EXISTS idx_reviews_item_key ON utterance_reviews(item_key);

CREATE TABLE IF NOT EXISTS expert_progress (
  code_hash TEXT NOT NULL,
  chunk_id INTEGER NOT NULL,
  current_pos INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (code_hash, chunk_id)
);

