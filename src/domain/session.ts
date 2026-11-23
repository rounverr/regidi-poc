import { sha256 } from "../shared/protocol.ts";
import type { LabStore } from "../persistence/store.ts";
import { ApiError } from "./validation.ts";

/** Persist a digest of the bearer credential instead of the credential itself. */
export async function sessionHash(authorization: string | undefined): Promise<string> {
  const token = authorization?.match(/^Bearer ([0-9a-f]{64})$/)?.[1];
  if (!token) throw new ApiError(401, "session_required");
  return sha256(token);
}

export async function requireAgent(store: LabStore, authorization: string | undefined) {
  const agent = await store.findAgent(await sessionHash(authorization));
  if (!agent) throw new ApiError(401, "session_expired");
  return agent;
}
