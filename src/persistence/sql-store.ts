import type { GrantSnapshot, LabStore, StoredAgent } from "./store.ts";

type Value = string | number;
export type Query = readonly [sql: string, ...parameters: Value[]];

/** Both runtimes implement the same statements and commit a batch as one write transaction. */
export interface SqlConnection {
  first<Row>(query: Query): Promise<Row | null>;
  run(query: Query): Promise<void>;
  batch<Row>(queries: readonly Query[]): Promise<readonly Row[][]>;
}

export function sqlStore(db: SqlConnection): LabStore {
  return {
    async saveSession(tokenHash, agent) {
      await db.batch([
        [`DELETE FROM lab_sessions WHERE token_hash IN (
          SELECT token_hash FROM lab_sessions WHERE expires_at <= unixepoch() ORDER BY expires_at LIMIT 64
        )`],
        [`INSERT INTO lab_sessions (token_hash, agent_id, agent_jwk, agent_thumbprint, expires_at)
          VALUES (?, ?, ?, ?, ?)`,
          tokenHash, agent.id, JSON.stringify(agent.publicKey), agent.thumbprint, agent.expiresAt],
      ]);
    },

    findAgent(tokenHash) {
      return db.first<StoredAgent>([`
        SELECT token_hash AS tokenHash, agent_id AS id, agent_jwk AS jwk,
          agent_thumbprint AS thumbprint, expires_at AS expiresAt
        FROM lab_sessions WHERE token_hash = ? AND expires_at > unixepoch()`, tokenHash]);
    },

    async saveGrant(tokenHash, grantId, expiresAt) {
      const saved = await db.first<{ grant_id: string }>([`
        UPDATE lab_sessions SET grant_id = ?, revoked_at = NULL, expires_at = ?
        WHERE token_hash = ? AND expires_at > unixepoch() RETURNING grant_id`,
        grantId, expiresAt, tokenHash]);
      return saved !== null;
    },

    async revokeGrant(tokenHash, grantId) {
      const result = await db.first<{ revokedAt: number }>([`
        UPDATE lab_sessions SET revoked_at = COALESCE(revoked_at, unixepoch())
        WHERE token_hash = ? AND grant_id = ? AND expires_at > unixepoch()
        RETURNING revoked_at AS revokedAt`, tokenHash, grantId]);
      return result?.revokedAt ?? null;
    },

    resetSession(tokenHash) {
      return db.run(["DELETE FROM lab_sessions WHERE token_hash = ?", tokenHash]);
    },

    async consumeProof(tokenHash, proofId) {
      type Receipt = { proof_id: string };
      type Snapshot = Omit<GrantSnapshot, "unused">;
      const [inserted, snapshot] = await db.batch<Receipt | Snapshot>([
        [`INSERT INTO lab_used_proofs (session_hash, proof_id)
          SELECT token_hash, ? FROM lab_sessions WHERE token_hash = ? AND expires_at > unixepoch()
          ON CONFLICT (session_hash, proof_id) DO NOTHING RETURNING proof_id`, proofId, tokenHash],
        [`SELECT unixepoch() AS now, grant_id AS grantId, revoked_at AS revokedAt
          FROM lab_sessions WHERE token_hash = ? AND expires_at > unixepoch()`, tokenHash],
      ]);
      const state = snapshot?.[0];
      if (!state || !("now" in state)) return null;
      // RETURNING detects this insert independently of the aggregate metrics trigger.
      const unused = inserted?.some((row) => "proof_id" in row && row.proof_id === proofId) ?? false;
      return { ...state, unused };
    },
  };
}
