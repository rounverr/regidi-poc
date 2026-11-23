import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Challenge } from "../api/runtime.ts";
import { ApiError } from "../domain/validation.ts";

const costLimit = 180;
const windowSeconds = 60;
const tokenDigest = (token: string) => createHash("sha256").update(token).digest("hex");

/** Share the weighted budget across Node processes using the same SQLite file. */
export function sqliteLimiter(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lab_rate_limits (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS lab_rate_limits_expiry ON lab_rate_limits (expires_at);
  `);
  const consume = db.prepare(`
    INSERT INTO lab_rate_limits (key, count, expires_at)
    VALUES (?, ?, unixepoch() + ?)
    ON CONFLICT (key) DO UPDATE SET
      count = IIF(expires_at <= unixepoch(), excluded.count, count + excluded.count),
      expires_at = IIF(expires_at <= unixepoch(), excluded.expires_at, expires_at)
    WHERE expires_at <= unixepoch() OR count + excluded.count <= ? RETURNING key`);
  const prune = db.prepare(`
    DELETE FROM lab_rate_limits WHERE key IN (
      SELECT key FROM lab_rate_limits WHERE expires_at <= unixepoch() ORDER BY expires_at LIMIT 16
    )`);

  return async (key: string, weight: number) => {
    if (!Number.isInteger(weight) || weight < 1 || weight > costLimit) return false;
    prune.run();
    return consume.get(key, weight, windowSeconds, costLimit) !== undefined;
  };
}

/** Issue short-lived, single-use tokens for the explicitly enabled loopback server. */
export function developmentChallenge(db: DatabaseSync): Challenge {
  // TEMP keeps development challenge data connection-local and out of the database file.
  db.exec("CREATE TEMP TABLE lab_development_challenges (digest TEXT PRIMARY KEY, expires_at INTEGER NOT NULL) STRICT");
  const insert = db.prepare("INSERT INTO lab_development_challenges VALUES (?, unixepoch() + 60)");
  const consume = db.prepare("DELETE FROM lab_development_challenges WHERE digest = ? AND expires_at > unixepoch() RETURNING digest");
  const prune = db.prepare("DELETE FROM lab_development_challenges WHERE expires_at <= unixepoch()");
  return {
    issue() {
      const token = randomBytes(32).toString("base64url");
      prune.run();
      insert.run(tokenDigest(token));
      return token;
    },
    async verify(token) {
      if (!consume.get(tokenDigest(token))) throw new ApiError(403, "turnstile_rejected");
    },
  };
}
