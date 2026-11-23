import { SignJWT } from "jose";
import { getAgentChallenge } from "./browser-challenge.ts";
import { LocalizedError } from "../i18n/index.ts";
import type { MessageKey } from "../i18n/locales/en.ts";
import {
  canonicalOperation, PROOF_TYPE, REQUEST_PATH, sha256,
  type Decision, type Delegation, type OperationRequest, type PublicKey, type Scope, type Session,
} from "../shared/protocol.ts";

const errors: Record<string, MessageKey> = {
  turnstile_rejected: "error.turnstile_rejected",
  turnstile_unavailable: "error.turnstile_unavailable",
  session_expired: "error.session_expired",
  session_required: "error.session_required",
  grant_inactive: "error.grant_inactive",
  invalid_input: "error.invalid_input",
  rate_limited: "error.rate_limited",
  service_unavailable: "error.service_unavailable",
  issuer_unavailable: "error.issuer_unavailable",
};

async function api<T>(path: string, options: {
  token?: string;
  body?: object;
  method?: "POST" | "DELETE";
  decision?: boolean;
}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? "POST",
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new LocalizedError("error.network");
  }
  if (response.status === 204) return undefined as T;
  const result = await response.json().catch(() => null);
  if (result && (response.ok || (options.decision && response.status === 403 && typeof result.allowed === "boolean"))) {
    return result as T;
  }
  throw new LocalizedError(errors[result?.error] ?? "error.api");
}

export async function createAgent(challengeContainer: HTMLElement) {
  if (!crypto.subtle) throw new LocalizedError("error.https");
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const { x, y } = await crypto.subtle.exportKey("jwk", keys.publicKey);
  if (!x || !y) throw new LocalizedError("error.publicKey");
  const publicKey: PublicKey = { kty: "EC", crv: "P-256", x, y };
  const turnstileToken = await getAgentChallenge(challengeContainer);
  const session = await api<Session>("/api/sessions", { body: { publicKey, turnstileToken } });
  return { session, privateKey: keys.privateKey };
}

export function createDelegation(session: Session, scope: Scope) {
  return api<Delegation>("/api/delegations", { token: session.token, body: scope });
}

export function revokeDelegation(session: Session, id: string) {
  return api<{ revokedAt: number }>("/api/delegations/revoke", { token: session.token, body: { id } });
}

export function closeSession(session: Session) {
  return api<void>("/api/sessions/current", { token: session.token, method: "DELETE" });
}

export async function sendOperation(
  session: Session, privateKey: CryptoKey, credential: string, request: OperationRequest,
) {
  const [ath, body] = await Promise.all([sha256(credential), sha256(canonicalOperation(request))]);
  const proof = await new SignJWT({ ath, body, htm: "POST", htu: new URL(REQUEST_PATH, window.location.origin).href })
    .setProtectedHeader({ alg: "ES256", typ: PROOF_TYPE })
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .sign(privateKey);
  return api<Decision>(REQUEST_PATH, {
    token: session.token, body: { credential, proof, request }, decision: true,
  });
}
