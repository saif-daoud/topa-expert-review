-- Enable multi-expert reviewing with a single shared access code:
-- - claims are per (chunk_id) with reviewer email_hash ownership
-- - claims can be taken over only after 1 day of inactivity AND only if no progress started (has_progress=0)

-- Remove one-chunk-per-code constraint (added in 0005)
DROP INDEX IF EXISTS idx_chunk_claims_code_hash_unique;

-- Add reviewer identity + progress flag to chunk_claims
ALTER TABLE chunk_claims ADD COLUMN email TEXT;
ALTER TABLE chunk_claims ADD COLUMN email_hash TEXT;
ALTER TABLE chunk_claims ADD COLUMN has_progress INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_chunk_claims_email_hash ON chunk_claims(email_hash);

-- Store reviewer identity and custom micro description on reviews
ALTER TABLE utterance_reviews ADD COLUMN reviewer_email TEXT;
ALTER TABLE utterance_reviews ADD COLUMN reviewer_hash TEXT;
ALTER TABLE utterance_reviews ADD COLUMN expert_micro_custom_desc TEXT;

CREATE INDEX IF NOT EXISTS idx_reviews_reviewer_chunk ON utterance_reviews(reviewer_hash, chunk_id);

-- Per-reviewer progress table (since multiple experts can share the same access code)
CREATE TABLE IF NOT EXISTS expert_progress_v2 (
  reviewer_hash TEXT NOT NULL,
  chunk_id INTEGER NOT NULL,
  current_pos INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (reviewer_hash, chunk_id)
);
