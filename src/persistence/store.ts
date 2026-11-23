import type { PublicKey } from "../shared/protocol.ts";

export interface SessionRecord {
  id: string;
  publicKey: PublicKey;
  thumbprint: string;
  expiresAt: number;
}

export interface StoredAgent {
  tokenHash: string;
  id: string;
  jwk: string;
  thumbprint: string;
  expiresAt: number;
}

export interface GrantSnapshot {
  now: number;
  grantId: string | null;
  revokedAt: number | null;
  unused: boolean;
}

/** Persistence owns the database clock and the ordering of concurrent session changes. */
export interface LabStore {
  saveSession(tokenHash: string, agent: SessionRecord): Promise<void>;
  findAgent(tokenHash: string): Promise<StoredAgent | null>;
  saveGrant(tokenHash: string, grantId: string, expiresAt: number): Promise<boolean>;
  revokeGrant(tokenHash: string, grantId: string): Promise<number | null>;
  resetSession(tokenHash: string): Promise<void>;
  /** Consume the proof and read the active grant in one transaction. */
  consumeProof(tokenHash: string, proofId: string): Promise<GrantSnapshot | null>;
}
