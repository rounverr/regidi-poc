import * as z from "zod";
import {
  DELEGATION_DURATIONS, MAX_AMOUNT_CENTS, OPERATIONS, PUBLIC_KEY_CURVE, SERVICES,
} from "../shared/protocol.ts";

export const identifier = z.uuid({ version: "v4" });
const digest = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const cents = z.int().min(1).max(MAX_AMOUNT_CENTS);
const timestamp = z.int().min(0);
const operation = z.enum(OPERATIONS);
const service = z.enum(SERVICES);
const label = z.string().min(1).max(256);
const compact = z.string().min(40).max(4096);

export const publicKey = z.strictObject({
  kty: z.literal("EC"), crv: z.literal(PUBLIC_KEY_CURVE), x: digest, y: digest,
});
export const privateKey = publicKey.extend({ d: digest });
export const sessionInput = z.strictObject({ publicKey, turnstileToken: z.string().trim().min(1).max(2048) });
export const delegationInput = z.strictObject({
  service, operation, maxAmountCents: cents, durationSeconds: z.literal(DELEGATION_DURATIONS),
});
export const revocationInput = z.strictObject({ id: identifier });
export const operationInput = z.strictObject({
  service, operation, amountCents: cents, currency: z.enum(["USD", "EUR"]),
});
export const requestInput = z.strictObject({
  credential: compact, proof: compact, request: operationInput,
});
export const delegationClaims = z.strictObject({
  iss: label,
  aud: label,
  sub: identifier,
  jti: identifier,
  iat: timestamp,
  nbf: timestamp,
  exp: timestamp,
  cnf: z.strictObject({ jkt: digest }),
  operation,
  currency: z.literal("USD"),
  maxAmountCents: cents,
});
export const proofClaims = z.strictObject({
  jti: identifier,
  iat: timestamp,
  htm: z.literal("POST"),
  htu: z.string().url().max(512),
  ath: digest,
  body: digest,
});

export class ApiError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 503;
  readonly code: string;

  constructor(status: ApiError["status"], code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export async function readInput<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const mediaType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") throw new ApiError(415, "json_required");

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    throw new ApiError(400, "malformed_json");
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ApiError(400, "invalid_input");
  return parsed.data;
}
