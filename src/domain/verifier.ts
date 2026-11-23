import { compactVerify } from "jose";
import {
  canonicalOperation, CHECKS, PROOF_FUTURE_SECONDS, PROOF_SECONDS, PROOF_TYPE, sha256,
  type Check, type Decision, type DecisionCode, type OperationRequest,
} from "../shared/protocol.ts";
import { audienceFor, loadIssuer, verifyCredential, type IssuerConfig } from "./issuer.ts";
import { allowAero } from "./policies/aero.ts";
import { allowBank } from "./policies/bank.ts";
import type { LabStore, StoredAgent } from "../persistence/store.ts";
import { ApiError, proofClaims, publicKey } from "./validation.ts";

const policies = { aero: allowAero, bank: allowBank };
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

function fresh(issuedAt: number, now: number): boolean {
  return issuedAt <= now + PROOF_FUTURE_SECONDS && issuedAt > now - PROOF_SECONDS;
}

async function verifyProof(proof: string, storedJwk: string) {
  const key = await crypto.subtle.importKey(
    "jwk", publicKey.parse(JSON.parse(storedJwk)), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"],
  );
  const { protectedHeader, payload } = await compactVerify(proof, key, { algorithms: ["ES256"] });
  if (protectedHeader.typ !== PROOF_TYPE) throw new Error("Unexpected proof type");
  return proofClaims.parse(JSON.parse(decoder.decode(payload)));
}

/** Verify possession and request binding before consuming the one-use proof. */
export async function evaluate(
  env: IssuerConfig,
  store: LabStore,
  agent: StoredAgent,
  input: { request: OperationRequest; credential: string; proof: string },
  endpoint: string,
): Promise<Decision> {
  const { request, credential } = input;
  const checks = Object.fromEntries(CHECKS.map((key) => [key, "skipped"])) as Decision["checks"];
  function finish(code: DecisionCode, failure?: Check): Decision {
    if (failure) checks[failure] = "failed";
    return {
      id: crypto.randomUUID(), decidedAt: Math.floor(Date.now() / 1000), agentId: agent.id,
      request, allowed: code === "allowed", code, checks,
    };
  }

  const issuer = await loadIssuer(env);
  let grant: Awaited<ReturnType<typeof verifyCredential>>;
  try {
    grant = await verifyCredential(credential, issuer);
  } catch {
    return finish("credential_signature", "signature");
  }
  checks.signature = "passed";

  if (grant.iss !== env.ISSUER) return finish("issuer", "issuer");
  checks.issuer = "passed";
  if (grant.sub !== agent.id || grant.cnf.jkt !== agent.thumbprint) return finish("agent", "agent");
  checks.agent = "passed";

  let proof: Awaited<ReturnType<typeof verifyProof>>;
  try {
    proof = await verifyProof(input.proof, agent.jwk);
  } catch {
    return finish("proof_signature", "possession");
  }
  checks.possession = "passed";

  const [credentialHash, bodyHash] = await Promise.all([
    sha256(credential), sha256(canonicalOperation(request)),
  ]);
  if (proof.htm !== "POST" || proof.htu !== endpoint || proof.ath !== credentialHash || proof.body !== bodyHash) {
    return finish("proof_binding", "binding");
  }
  checks.binding = "passed";
  if (!fresh(proof.iat, Math.floor(Date.now() / 1000))) return finish("proof_expired", "freshness");

  // Replay, expiry and revocation all refer to the same committed database snapshot.
  const snapshot = await store.consumeProof(agent.tokenHash, proof.jti);
  if (!snapshot) throw new ApiError(401, "session_expired");
  if (!fresh(proof.iat, snapshot.now)) return finish("proof_expired", "freshness");
  checks.freshness = "passed";
  if (!snapshot.unused) return finish("replay", "replay");
  checks.replay = "passed";

  if (snapshot.now >= grant.exp) return finish("expired", "validity");
  if (snapshot.now < grant.nbf || snapshot.now < grant.iat) return finish("not_yet_valid", "validity");
  checks.validity = "passed";
  if (snapshot.grantId !== grant.jti) return finish("superseded", "revocation");
  if (snapshot.revokedAt !== null) return finish("revoked", "revocation");
  checks.revocation = "passed";
  if (grant.aud !== audienceFor(env, request.service)) return finish("audience", "audience");
  checks.audience = "passed";
  if (grant.operation !== request.operation) return finish("operation", "operation");
  checks.operation = "passed";
  if (grant.currency !== request.currency) return finish("currency", "currency");
  checks.currency = "passed";
  if (request.amountCents > grant.maxAmountCents) return finish("amount", "amount");
  checks.amount = "passed";
  if (!policies[request.service](request)) return finish("policy", "policy");
  checks.policy = "passed";
  return finish("allowed");
}
