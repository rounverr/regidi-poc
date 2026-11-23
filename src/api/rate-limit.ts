import { createMiddleware } from "hono/factory";
import { ApiError } from "../domain/validation.ts";
import type { LabRuntime } from "./runtime.ts";

const ipPolicies = {
  challenge: { cost: 18, sharesBudget: false },
  create: { cost: 18, sharesBudget: true },
  delegate: { cost: 4, sharesBudget: true },
  verify: { cost: 1, sharesBudget: true },
  revoke: { cost: 2, sharesBudget: false },
  close: { cost: 2, sharesBudget: false },
  jwks: { cost: 2, sharesBudget: false },
} as const;

const sessionCosts = { delegate: 18, verify: 4, revoke: 9 } as const;
const utf8 = new TextEncoder();

/** Derive a separate HMAC key so raw client addresses never become limiter keys. */
async function ipKey(env: LabRuntime, ip: string | undefined): Promise<string> {
  if (!ip) return "unavailable";
  if (!env.issuer.ISSUER_PRIVATE_JWK) throw new ApiError(503, "issuer_unavailable");

  const material = await crypto.subtle.importKey("raw", utf8.encode(env.issuer.ISSUER_PRIVATE_JWK), "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: utf8.encode("regidi-lab/rate-limit/ip/v1") },
    material,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, utf8.encode(ip));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

async function consume(env: LabRuntime, key: string, delta: number) {
  if (!await env.consumeRateLimit(`regidi-lab:v2:${key}`, delta)) throw new ApiError(429, "rate_limited");
}

export function limitIp(operation: keyof typeof ipPolicies) {
  return createMiddleware<{ Bindings: LabRuntime }>(async (c, next) => {
    const ip = await ipKey(c.env, c.env.clientAddress);
    const policy = ipPolicies[operation];
    await consume(c.env, `ip:${operation}:${ip}`, policy.cost);
    if (policy.sharesBudget) await consume(c.env, `ip:lab:${ip}`, 1);
    await next();
  });
}

export function limitSession(env: LabRuntime, operation: keyof typeof sessionCosts, authenticatedHash: string) {
  return consume(env, `session:${operation}:${authenticatedHash}`, sessionCosts[operation]);
}
