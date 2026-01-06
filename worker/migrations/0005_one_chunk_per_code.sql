-- Enforce one chunk per access code (prevents one code from claiming multiple chunks)
-- NOTE: chunk_id is already unique (primary key). This index enforces code_hash uniqueness too.
CREATE UNIQUE INDEX IF NOT EXISTS idx_chunk_claims_code_hash_unique ON chunk_claims(code_hash);
