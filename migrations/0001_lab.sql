CREATE TABLE lab_sessions (
  token_hash TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  agent_jwk TEXT NOT NULL,
  agent_thumbprint TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  grant_id TEXT,
  revoked_at INTEGER
) STRICT;

CREATE INDEX lab_sessions_expiry ON lab_sessions (expires_at);

CREATE TABLE lab_used_proofs (
  session_hash TEXT NOT NULL REFERENCES lab_sessions (token_hash) ON DELETE CASCADE,
  proof_id TEXT NOT NULL,
  PRIMARY KEY (session_hash, proof_id)
) WITHOUT ROWID, STRICT;
