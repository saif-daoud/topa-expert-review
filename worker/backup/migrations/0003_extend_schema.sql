-- Extend schema: participant profile fields + tie + feedback votes

-- Participants: add profile columns
ALTER TABLE participants ADD COLUMN name TEXT;
ALTER TABLE participants ADD COLUMN email TEXT;
ALTER TABLE participants ADD COLUMN job_title TEXT;
ALTER TABLE participants ADD COLUMN institution TEXT;
ALTER TABLE participants ADD COLUMN latest_degree TEXT;
ALTER TABLE participants ADD COLUMN years_experience INTEGER;
ALTER TABLE participants ADD COLUMN updated_at TEXT;

-- Votes: add tie support + resolved_preferred + optional feedback.
ALTER TABLE votes RENAME TO votes_old;

CREATE TABLE votes (
  id TEXT PRIMARY KEY,
  participant_id TEXT NOT NULL,
  component TEXT NOT NULL,
  trial_id INTEGER NOT NULL,
  left_method_id TEXT NOT NULL,
  right_method_id TEXT NOT NULL,
  preferred TEXT NOT NULL CHECK (preferred IN ('left','right','tie')),
  resolved_preferred TEXT NOT NULL CHECK (resolved_preferred IN ('left','right')),
  feedback TEXT,
  timestamp_utc TEXT NOT NULL,
  user_agent TEXT,
  page_url TEXT,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT INTO votes (
  id, participant_id, component, trial_id,
  left_method_id, right_method_id,
  preferred, resolved_preferred, feedback,
  timestamp_utc, user_agent, page_url, received_at
)
SELECT
  id, participant_id, component, trial_id,
  left_method_id, right_method_id,
  preferred,
  preferred AS resolved_preferred,
  NULL AS feedback,
  timestamp_utc, user_agent, page_url, received_at
FROM votes_old;

DROP TABLE votes_old;

CREATE INDEX IF NOT EXISTS idx_votes_participant ON votes(participant_id);
CREATE INDEX IF NOT EXISTS idx_votes_component ON votes(component);
CREATE INDEX IF NOT EXISTS idx_votes_component_trial ON votes(component, trial_id);
