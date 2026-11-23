export const SERVICES = ["aero", "bank"] as const;
export type Service = (typeof SERVICES)[number];
export const OPERATIONS = ["prepare_booking", "prepare_transfer", "confirm_transfer"] as const;
export type Operation = (typeof OPERATIONS)[number];

export const PUBLIC_KEY_CURVE = "P-256";
export const CREDENTIAL_TYPE = "regidi-delegation+jwt";
export const PROOF_TYPE = "regidi-proof+jwt";
export const SESSION_SECONDS = 5 * 60;
export const DELEGATION_DURATIONS = [10, 60, 180, 300, 900] as const;
export const MAX_AMOUNT_CENTS = 1_000_000;
export const PROOF_SECONDS = 45;
export const PROOF_FUTURE_SECONDS = 5;
export const REQUEST_PATH = "/api/requests";
export const DEMO_PERSON = "Arthur Parker";

export interface PublicKey {
  kty: "EC";
  crv: typeof PUBLIC_KEY_CURVE;
  x: string;
  y: string;
}

export interface Session {
  token: string;
  agentId: string;
  thumbprint: string;
  expiresAt: number;
}

export interface Scope {
  service: Service;
  operation: Operation;
  maxAmountCents: number;
  durationSeconds: (typeof DELEGATION_DURATIONS)[number];
}

export interface Delegation {
  id: string;
  credential: string;
  service: Service;
  audience: string;
  operation: Operation;
  maxAmountCents: number;
  issuedAt: number;
  expiresAt: number;
  issuer: string;
  keyId: string;
}

export interface OperationRequest {
  service: Service;
  operation: Operation;
  amountCents: number;
  currency: "USD" | "EUR";
}

export const CHECKS = [
  "signature", "issuer", "agent", "possession", "binding", "freshness",
  "replay", "validity", "revocation", "audience", "operation", "currency", "amount", "policy",
] as const;
export type Check = (typeof CHECKS)[number];
export type DecisionCode =
  | "allowed" | "credential_signature" | "issuer" | "agent"
  | "proof_signature" | "proof_binding" | "proof_expired" | "replay"
  | "expired" | "not_yet_valid" | "revoked" | "superseded"
  | "audience" | "operation" | "currency" | "amount" | "policy";

export interface Decision {
  id: string;
  decidedAt: number;
  agentId: string;
  request: OperationRequest;
  allowed: boolean;
  code: DecisionCode;
  checks: Record<Check, "passed" | "failed" | "skipped">;
}

/** The ordered JSON tuple is the wire representation used for proof binding. */
export function canonicalOperation(request: OperationRequest): string {
  return JSON.stringify([request.service, request.operation, request.amountCents, request.currency]);
}

export async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
