import { calculateJwkThumbprint, compactVerify, SignJWT } from "jose";
import {
  CREDENTIAL_TYPE, REQUEST_PATH, type Delegation, type Scope, type Service,
} from "../shared/protocol.ts";
import { ApiError, delegationClaims, privateKey } from "./validation.ts";

const ES256 = { name: "ECDSA", namedCurve: "P-256" };
const ALGORITHMS = ["ES256"];
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export function targetUrl(url: URL): string {
  return new URL(REQUEST_PATH, url.origin).href;
}

export interface IssuerConfig {
  ISSUER: string;
  AIR_AUDIENCE: string;
  BANK_AUDIENCE: string;
  ISSUER_PRIVATE_JWK: string;
}

export function audienceFor(env: IssuerConfig, service: Service): string {
  return service === "aero" ? env.AIR_AUDIENCE : env.BANK_AUDIENCE;
}

/** Derive the public JWKS and key ID from the configured P-256 signing key. */
export async function loadIssuer(env: IssuerConfig) {
  try {
    if (!env.ISSUER?.trim() || !env.AIR_AUDIENCE?.trim() || !env.BANK_AUDIENCE?.trim() ||
        env.AIR_AUDIENCE === env.BANK_AUDIENCE ||
        [env.ISSUER, env.AIR_AUDIENCE, env.BANK_AUDIENCE].some((label) => label.length > 256)) {
      throw new Error("Invalid issuer configuration");
    }
    const jwk = privateKey.parse(JSON.parse(env.ISSUER_PRIVATE_JWK));
    const { kty, crv, x, y } = jwk;
    const publicJwk = { kty, crv, x, y };
    const [verifyKey, keyId] = await Promise.all([
      crypto.subtle.importKey("jwk", publicJwk, ES256, false, ["verify"]),
      calculateJwkThumbprint(publicJwk),
    ]);
    return { jwk, publicJwk, verifyKey, keyId };
  } catch {
    throw new ApiError(503, "issuer_unavailable");
  }
}

/** Bind a scoped ES256 delegation to the enrolled agent key thumbprint. */
export async function issueCredential(
  env: IssuerConfig,
  agent: { id: string; thumbprint: string },
  scope: Scope,
): Promise<Delegation> {
  const issuer = await loadIssuer(env);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + scope.durationSeconds;
  if (expiresAt <= now) throw new ApiError(401, "session_expired");
  const audience = audienceFor(env, scope.service);
  const id = crypto.randomUUID();
  try {
    const signingKey = await crypto.subtle.importKey("jwk", issuer.jwk, ES256, false, ["sign"]);
    const credential = await new SignJWT({
      cnf: { jkt: agent.thumbprint },
      operation: scope.operation,
      currency: "USD",
      maxAmountCents: scope.maxAmountCents,
    })
      .setProtectedHeader({ alg: "ES256", kid: issuer.keyId, typ: CREDENTIAL_TYPE })
      .setIssuer(env.ISSUER).setSubject(agent.id).setAudience(audience).setJti(id)
      .setIssuedAt(now).setNotBefore(now).setExpirationTime(expiresAt)
      .sign(signingKey);
    // A mismatched private scalar and public point must never yield an issued grant.
    await compactVerify(credential, issuer.verifyKey, { algorithms: ALGORITHMS });
    return {
      id, credential, service: scope.service, audience, operation: scope.operation,
      maxAmountCents: scope.maxAmountCents, issuedAt: now, expiresAt,
      issuer: env.ISSUER, keyId: issuer.keyId,
    };
  } catch {
    throw new ApiError(503, "issuer_unavailable");
  }
}

export async function verifyCredential(credential: string, issuer: Awaited<ReturnType<typeof loadIssuer>>) {
  const { protectedHeader, payload } = await compactVerify(credential, issuer.verifyKey, {
    algorithms: ALGORITHMS,
  });
  if (protectedHeader.typ !== CREDENTIAL_TYPE || protectedHeader.kid !== issuer.keyId) {
    throw new Error("Unexpected credential type or signing key");
  }
  return delegationClaims.parse(JSON.parse(decoder.decode(payload)));
}
