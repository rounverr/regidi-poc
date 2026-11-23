import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { calculateJwkThumbprint } from "jose";
import { REQUEST_PATH, SESSION_SECONDS, sha256, type Session } from "../shared/protocol.ts";
import { issueCredential, loadIssuer, targetUrl } from "../domain/issuer.ts";
import { limitIp, limitSession } from "./rate-limit.ts";
import { requireAgent, sessionHash } from "../domain/session.ts";
import { evaluate } from "../domain/verifier.ts";
import type { LabRuntime } from "./runtime.ts";
import { DEVELOPMENT_CHALLENGE_PATH } from "../shared/turnstile.ts";
import {
  ApiError, delegationInput, readInput, requestInput, revocationInput, sessionInput,
} from "../domain/validation.ts";

export const app = new Hono<{ Bindings: LabRuntime }>();

app.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  const origin = c.req.header("Origin");
  const requestOrigin = new URL(c.req.url).origin;
  const expectedOrigin = c.env.publicOrigin ?? requestOrigin;
  if ((origin && origin !== expectedOrigin) || (c.env.challenge.issue && requestOrigin !== expectedOrigin)) {
    throw new ApiError(403, "origin_denied");
  }
  await next();
});

app.use("*", bodyLimit({
  maxSize: 12_288,
  onError: () => { throw new ApiError(413, "body_too_large"); },
}));

app.get(DEVELOPMENT_CHALLENGE_PATH, async (c, next) => {
  if (!c.env.challenge.issue) return c.notFound();
  await next();
}, limitIp("challenge"), (c) => c.json({ token: c.env.challenge.issue!() }));

app.post("/api/sessions", limitIp("create"), async (c) => {
  const { publicKey, turnstileToken } = await readInput(c.req.raw, sessionInput);
  try {
    await crypto.subtle.importKey("jwk", publicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  } catch {
    throw new ApiError(400, "invalid_public_key");
  }

  await c.env.challenge.verify(turnstileToken);
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)),
    (byte) => byte.toString(16).padStart(2, "0")).join("");
  const id = crypto.randomUUID();
  const thumbprint = await calculateJwkThumbprint(publicKey);
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  await c.env.store.saveSession(await sha256(token), { id, publicKey, thumbprint, expiresAt });
  return c.json({ token, agentId: id, thumbprint, expiresAt } satisfies Session, 201);
});

app.post("/api/delegations", limitIp("delegate"), async (c) => {
  const input = await readInput(c.req.raw, delegationInput);
  const agent = await requireAgent(c.env.store, c.req.header("Authorization"));
  await limitSession(c.env, "delegate", agent.tokenHash);
  const grant = await issueCredential(c.env.issuer, agent, input);
  if (!await c.env.store.saveGrant(agent.tokenHash, grant.id, grant.expiresAt)) {
    throw new ApiError(401, "session_expired");
  }
  return c.json(grant, 201);
});

app.post("/api/delegations/revoke", limitIp("revoke"), async (c) => {
  const { id } = await readInput(c.req.raw, revocationInput);
  const agent = await requireAgent(c.env.store, c.req.header("Authorization"));
  await limitSession(c.env, "revoke", agent.tokenHash);
  const revokedAt = await c.env.store.revokeGrant(agent.tokenHash, id);
  if (revokedAt === null) throw new ApiError(409, "grant_inactive");
  return c.json({ revokedAt });
});

app.post(REQUEST_PATH, limitIp("verify"), async (c) => {
  const input = await readInput(c.req.raw, requestInput);
  const url = new URL(c.req.url);
  if (url.search) throw new ApiError(400, "unexpected_query");
  const agent = await requireAgent(c.env.store, c.req.header("Authorization"));
  await limitSession(c.env, "verify", agent.tokenHash);
  const decision = await evaluate(c.env.issuer, c.env.store, agent, input, targetUrl(new URL(c.env.publicOrigin ?? url)));
  return c.json(decision, decision.allowed ? 200 : 403);
});

app.delete("/api/sessions/current", limitIp("close"), async (c) => {
  const hash = await sessionHash(c.req.header("Authorization"));
  await c.env.store.resetSession(hash);
  return c.body(null, 204);
});

app.get("/api/issuer/jwks", limitIp("jwks"), async (c) => {
  const issuer = await loadIssuer(c.env.issuer);
  return c.json({ keys: [{ ...issuer.publicJwk, kid: issuer.keyId, use: "sig", alg: "ES256" }] });
});

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError((error, c) => {
  if (error instanceof ApiError) {
    if (error.status === 429) c.header("Retry-After", "60");
    if (error.status === 503) console.error(JSON.stringify({ event: error.code }));
    return c.json({ error: error.code }, error.status);
  }
  console.error(JSON.stringify({ event: "lab_request_failed" }));
  return c.json({ error: "service_unavailable" }, 503);
});
