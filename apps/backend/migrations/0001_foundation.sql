CREATE TABLE owner_slot (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner_id TEXT UNIQUE,
  claim_nonce TEXT NOT NULL,
  claim_email TEXT NOT NULL,
  claim_started_at TEXT NOT NULL,
  claimed_at TEXT
);

CREATE TABLE switches (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner_id TEXT NOT NULL UNIQUE,
  active_revision_id TEXT,
  cycle_id TEXT NOT NULL,
  cycle_started_at TEXT NOT NULL,
  armed INTEGER NOT NULL DEFAULT 0 CHECK (armed IN (0, 1)),
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  updated_at TEXT NOT NULL
);

CREATE TABLE schedule_revisions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  definition_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (owner_id, version)
);

CREATE TABLE schedule_rounds (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES schedule_revisions(id),
  ordinal INTEGER NOT NULL,
  delay_amount INTEGER NOT NULL CHECK (delay_amount > 0),
  delay_unit TEXT NOT NULL CHECK (delay_unit IN ('days', 'weeks', 'months')),
  manual_rearm INTEGER NOT NULL DEFAULT 0 CHECK (manual_rearm IN (0, 1)),
  UNIQUE (revision_id, ordinal)
);

CREATE TABLE action_groups (
  id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES schedule_rounds(id),
  ordinal INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('ordered', 'concurrent')),
  UNIQUE (round_id, ordinal)
);

CREATE TABLE actions (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES action_groups(id),
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('email', 'webhook', 'sms', 'browser')),
  config_ciphertext TEXT NOT NULL,
  failure_policy TEXT NOT NULL CHECK (failure_policy IN ('continue', 'stop_group', 'stop_round')),
  UNIQUE (group_id, ordinal)
);

CREATE TABLE round_arming (
  round_id TEXT PRIMARY KEY REFERENCES schedule_rounds(id),
  armed INTEGER NOT NULL CHECK (armed IN (0, 1)),
  updated_at TEXT NOT NULL
);

CREATE TABLE checkin_policy (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  methods_json TEXT NOT NULL,
  totp_secret_ciphertext TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE checkin_keys (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT
);

CREATE TABLE checkins (
  id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  method TEXT NOT NULL,
  key_id TEXT,
  session_id TEXT,
  accepted_at TEXT NOT NULL
);

CREATE TABLE admin_totp_proofs (
  session_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  verified_at TEXT NOT NULL
);

CREATE TABLE round_runs (
  id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL,
  revision_id TEXT NOT NULL REFERENCES schedule_revisions(id),
  round_id TEXT NOT NULL REFERENCES schedule_rounds(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'skipped', 'canceled', 'needs_review')),
  due_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE (cycle_id, round_id)
);

CREATE TABLE action_runs (
  id TEXT PRIMARY KEY,
  round_run_id TEXT NOT NULL REFERENCES round_runs(id),
  cycle_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  action_id TEXT NOT NULL REFERENCES actions(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'succeeded', 'failed', 'skipped', 'canceled', 'needs_review')),
  reason TEXT,
  claimed_at TEXT,
  finished_at TEXT,
  UNIQUE (cycle_id, action_id)
);

CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  action_run_id TEXT NOT NULL REFERENCES action_runs(id),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'published', 'canceled')),
  created_at TEXT NOT NULL,
  published_at TEXT,
  UNIQUE (action_run_id)
);

CREATE INDEX idx_round_runs_due ON round_runs(status, due_at);
CREATE INDEX idx_action_runs_round ON action_runs(round_run_id, status);
CREATE INDEX idx_outbox_pending ON outbox(status, created_at);
