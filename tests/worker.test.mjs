import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { compactVerify, exportJWK, generateKeyPair, importJWK } from "jose";
import { Miniflare } from "miniflare";
import { migrateD1 } from "./migrations.mjs";
import { CHECKS, REQUEST_PATH, sha256 } from "../src/shared/protocol.ts";
import { apiAt, envelope, expectDecision, flight, flightGrant, grant, keyPair, start as startSession } from "./client.mjs";

const root = new URL("../.cloudflare/output/v1/workers/default/", import.meta.url);
const config = JSON.parse(await readFile(new URL("worker.config.json", root), "utf8"));
const origin = "http://lab.test";
const { privateKey } = await generateKeyPair("ES256", { extractable: true });
const issuerKey = JSON.stringify(await exportJWK(privateKey));
const bundle = new URL("bundle/", root);
const moduleName = config.manifest.mainModule;
const contents = await readFile(new URL(moduleName, bundle), "utf8");

function start(api) {
  return startSession(api, crypto.randomUUID());
}

function workerOptions(name, signingKey = issuerKey) {
  const verified = new Set();
  return {
    dev: {
      outboundService: {
        type: "fetcher",
        async handler(request) {
          assert.equal(request.url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
          assert.equal(request.method, "POST");
          const body = new URLSearchParams(await request.text());
          assert.equal(body.get("secret"), "local-test-secret");
          const token = body.get("response");
          if (verified.has(token)) return Response.json({ success: false, "error-codes": ["timeout-or-duplicate"] });
          verified.add(token);
          return Response.json({ success: true, hostname: token === "other-hostname" ? "other.test" : "lab.test", action: token === "other-action" ? "other_action" : "create_agent" });
        },
      },
    },
    config: {
      name,
      compatibilityDate: config.compatibilityDate,
      manifest: {
        mainModule: moduleName,
        modulesRoot: fileURLToPath(bundle),
        modules: { [moduleName]: { type: "esm", contents } },
      },
      env: {
        ...config.env,
        DB: { type: "d1", name },
        ISSUER_PRIVATE_JWK: { type: "text", value: signingKey },
        TURNSTILE_SECRET: { type: "text", value: "local-test-secret" },
        TURNSTILE_HOSTNAME: { type: "text", value: "lab.test" },
      },
    },
  };
}

let mf;
let api;
let db;
let visitor = 0;

// Miniflare supplies this test address in place of Cloudflare's edge metadata.
beforeEach(() => {
  const ip = `192.0.2.${++visitor}`;
  api = apiAt(origin, (url, init) => mf.dispatchFetch(url, {
    ...init,
    headers: { ...init.headers, "CF-Connecting-IP": ip },
  }));
});

before(async () => {
  mf = new Miniflare({ cf: false, enableDevRegistry: false, workers: [workerOptions("regidi-tests")] });
  db = await mf.getD1Database("DB");
  await migrateD1(db);
});
after(async () => { await mf?.dispose(); });

async function setup(scope = flightGrant) {
  const agent = await start(api);
  return { agent, delegation: await grant(api, agent, scope) };
}

async function submit(agent, delegation, request, options) {
  return api(REQUEST_PATH, { token: agent.token, body: await envelope(origin, agent, delegation.credential, request, options) });
}

test("issuer JWKS verifies the signed delegation and the airline allows USD 650", async () => {
  const { agent, delegation } = await setup();
  const jwks = await api("/api/issuer/jwks", { method: "GET" });
  assert.equal(jwks.status, 200);
  const [jwk] = jwks.data.keys;
  assert.equal(jwk.kid, delegation.keyId);
  assert.equal(jwk.d, undefined);
  await compactVerify(delegation.credential, await importJWK(jwk, "ES256"));
  const result = await submit(agent, delegation, flight);
  expectDecision(result, "allowed");
  assert.deepEqual(Object.values(result.data.checks), CHECKS.map(() => "passed"));
  assert.equal(result.headers.get("Cache-Control"), "no-store");
});

test("limits, permissions, audience and currency are checked by the backend", async () => {
  const { agent, delegation } = await setup();
  for (const [request, code] of [
    [{ ...flight, amountCents: 120_000 }, "amount"],
    [{ ...flight, operation: "prepare_transfer" }, "operation"],
    [{ ...flight, service: "bank", operation: "prepare_transfer" }, "audience"],
    [{ ...flight, currency: "EUR" }, "currency"],
  ]) {
    expectDecision(await submit(agent, delegation, request), code, code);
  }
});

test("the bank accepts a scoped transfer draft and enforces its own cap and confirmation policy", async () => {
  const scope = { ...flightGrant, service: "bank", operation: "prepare_transfer" };
  const { agent, delegation } = await setup(scope);
  const transfer = { ...flight, service: "bank", operation: "prepare_transfer", amountCents: 40_000 };
  expectDecision(await submit(agent, delegation, transfer), "allowed");
  expectDecision(await submit(agent, delegation, { ...transfer, amountCents: 65_000 }), "policy", "policy");
  const confirmation = await grant(api, agent, { ...scope, operation: "confirm_transfer" });
  expectDecision(await submit(agent, confirmation, { ...transfer, operation: "confirm_transfer" }), "policy", "policy");
  expectDecision(await submit(agent, delegation, transfer), "superseded", "revocation");
});

test("altered credentials and proofs signed with the wrong agent key are denied", async () => {
  const { agent, delegation } = await setup();
  const [header, payload, signature] = delegation.credential.split(".");
  const altered = [header, payload, (signature[0] === "A" ? "B" : "A") + signature.slice(1)].join(".");
  expectDecision(await submit(agent, { credential: altered }, flight), "credential_signature", "signature");
  const { privateKey: wrongKey } = await keyPair();
  expectDecision(await submit({ ...agent, privateKey: wrongKey }, delegation, flight), "proof_signature", "possession");
});

test("the proof binds the request, credential and exact endpoint and rejects stale proofs", async () => {
  const { agent, delegation } = await setup();
  const body = await envelope(origin, agent, delegation.credential);
  expectDecision(await api(REQUEST_PATH, {
    token: agent.token, body: { ...body, request: { ...flight, amountCents: 1 } },
  }), "proof_binding", "binding");
  expectDecision(await submit(agent, delegation, flight, { path: "/api/other" }), "proof_binding", "binding");

  const replacement = await grant(api, agent);
  expectDecision(await api(REQUEST_PATH, {
    token: agent.token, body: { ...body, credential: replacement.credential },
  }), "proof_binding", "binding");
  expectDecision(await submit(agent, replacement, flight, { issuedAt: Math.floor(Date.now() / 1000) - 90 }),
    "proof_expired", "freshness");
});

test("concurrent submissions can consume a proof only once", async () => {
  const { agent, delegation } = await setup();
  const body = await envelope(origin, agent, delegation.credential);
  const results = await Promise.all([
    api(REQUEST_PATH, { token: agent.token, body }),
    api(REQUEST_PATH, { token: agent.token, body }),
  ]);
  assert.deepEqual(results.map(({ data }) => data.code).sort(), ["allowed", "replay"]);
});

test("revocation is immediate and reset invalidates the session and clears its proof rows", async () => {
  const { agent, delegation } = await setup();
  expectDecision(await submit(agent, delegation, flight), "allowed");
  const revoke = () => api("/api/delegations/revoke", { token: agent.token, body: { id: delegation.id } });
  const result = await revoke();
  assert.equal(result.status, 200);
  assert.equal((await revoke()).data.revokedAt, result.data.revokedAt);
  expectDecision(await submit(agent, delegation, flight), "revoked", "revocation");

  const reset = () => api("/api/sessions/current", { token: agent.token, method: "DELETE" });
  assert.equal((await reset()).status, 204);
  assert.equal((await reset()).status, 204);
  assert.equal((await submit(agent, delegation, flight)).status, 401);
  const dangling = await db.prepare(`SELECT count(*) AS count FROM lab_used_proofs
    WHERE session_hash NOT IN (SELECT token_hash FROM lab_sessions)`).first();
  assert.equal(dangling.count, 0);
});

test("another visitor cannot operate with or revoke the first visitor's grant", async () => {
  const { agent, delegation } = await setup();
  const other = await start(api);
  const revoke = await api("/api/delegations/revoke", { token: other.token, body: { id: delegation.id } });
  assert.equal(revoke.status, 409);
  expectDecision(await submit(other, delegation, flight), "agent", "agent");
  expectDecision(await submit(agent, delegation, flight), "allowed");
});

test("expired sessions are rejected and opportunistic cleanup cascades to their proofs", async () => {
  const { agent, delegation } = await setup();
  expectDecision(await submit(agent, delegation, flight), "allowed");
  const hash = await sha256(agent.token);
  await db.prepare("UPDATE lab_sessions SET expires_at = unixepoch() WHERE token_hash = ?").bind(hash).run();
  assert.equal((await submit(agent, delegation, flight)).status, 401);
  await start(api);
  assert.equal(await db.prepare("SELECT token_hash FROM lab_sessions WHERE token_hash = ?").bind(hash).first(), null);
  assert.equal(await db.prepare("SELECT proof_id FROM lab_used_proofs WHERE session_hash = ?").bind(hash).first(), null);
});

test("invalid input and cross-origin requests are rejected", async () => {
  assert.equal((await api("/api/sessions", { body: { publicKey: { d: "ignored" } } })).status, 400);
  assert.equal((await api("/api/sessions", { body: { excess: "x".repeat(13_000) } })).status, 413);
  assert.equal((await api("/api/sessions", { body: {}, headers: { Origin: "http://other.test" } })).status, 403);
});

test("issuer errors and D1 errors fail closed without exposing details", async () => {
  const broken = new Miniflare({ cf: false, enableDevRegistry: false, workers: [workerOptions("broken-tests", "{}")] });
  try {
    const brokenApi = apiAt(origin, broken.dispatchFetch.bind(broken));
    const { publicKey } = await keyPair();
    const noDatabase = await brokenApi("/api/sessions", { body: { publicKey, turnstileToken: crypto.randomUUID() } });
    assert.equal(noDatabase.status, 503);
    assert.deepEqual(noDatabase.data, { error: "service_unavailable" });
    const brokenDb = await broken.getD1Database("DB");
    await migrateD1(brokenDb);
    const agent = await start(brokenApi);
    const badIssuer = await brokenApi("/api/delegations", { token: agent.token, body: flightGrant });
    assert.equal(badIssuer.status, 503);
    assert.deepEqual(badIssuer.data, { error: "issuer_unavailable" });
    const failedVerification = await brokenApi(REQUEST_PATH, {
      token: agent.token, body: await envelope(origin, agent, "x".repeat(40)),
    });
    assert.equal(failedVerification.status, 503);
    assert.deepEqual(failedVerification.data, { error: "issuer_unavailable" });
  } finally {
    await broken.dispose();
  }
});

test("an expired grant also expires its agent session", async () => {
  const { agent, delegation } = await setup({ ...flightGrant, durationSeconds: 10 });
  const hash = await sha256(agent.token);
  await db.prepare("UPDATE lab_sessions SET expires_at = unixepoch() - 1 WHERE token_hash = ?").bind(hash).run();
  const result = await submit(agent, delegation, flight);
  assert.equal(result.status, 401);
  assert.equal(result.data.error, "session_expired");
});


async function startInsideRateWindow() {
  // The emulator's counters reset at a minute boundary, so give the burst a full window.
  const remaining = 60_000 - (Date.now() % 60_000);
  if (remaining < 7_000) await setTimeout(remaining + 50);
}

function expectRateLimit(response) {
  assert.equal(response.status, 429, JSON.stringify(response.data));
  assert.deepEqual(response.data, { error: "rate_limited" });
  assert.equal(response.headers.get("Retry-After"), "60");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
}

test("session creation has a stricter IP limit than normal verifications", async () => {
  await startInsideRateWindow();
  const { agent, delegation } = await setup();
  for (let count = 1; count < 10; count++) await start(api);

  const { publicKey } = await keyPair();
  expectRateLimit(await api("/api/sessions", {
    body: { publicKey }, headers: { "X-Forwarded-For": "203.0.113.20", "X-Real-IP": "203.0.113.21" },
  }));
  for (let count = 0; count < 11; count++) {
    expectDecision(await submit(agent, delegation, flight), "allowed");
  }
});

test("authentic sessions have independent issuance and verification budgets", async () => {
  await startInsideRateWindow();
  const first = await setup();
  const second = await setup();
  let current = first.delegation;
  for (let count = 1; count < 10; count++) current = await grant(api, first.agent);
  expectRateLimit(await api("/api/delegations", {
    token: first.agent.token,
    body: flightGrant,
    headers: { "X-Session-ID": second.agent.agentId },
  }));
  const secondGrant = await grant(api, second.agent);

  for (let count = 0; count < 45; count++) {
    expectDecision(await submit(first.agent, current, flight), "allowed");
  }
  expectRateLimit(await submit(first.agent, current, flight));
  expectDecision(await submit(second.agent, secondGrant, flight), "allowed");
  const revoke = await api("/api/delegations/revoke", { token: first.agent.token, body: { id: current.id } });
  assert.equal(revoke.status, 200);
});

test("switching to freshly created sessions cannot exceed the shared IP budget", async () => {
  await startInsideRateWindow();
  const sessions = [];
  for (let count = 0; count < 4; count++) sessions.push(await setup());

  // With two setup calls and 43 verifications each, all sessions stay below
  // their individual verification limits and use the full IP allowance together.
  for (const { agent, delegation } of sessions) {
    for (let count = 0; count < 43; count++) {
      expectDecision(await submit(agent, delegation, flight), "allowed");
    }
  }

  const { publicKey } = await keyPair();
  expectRateLimit(await api("/api/sessions", { body: { publicKey } }));
  const { agent, delegation } = sessions.at(-1);
  expectRateLimit(await submit(agent, delegation, flight));
  assert.equal((await api("/api/issuer/jwks", { method: "GET" })).status, 200);
  assert.equal((await api("/api/sessions/current", { token: agent.token, method: "DELETE" })).status, 204);
});

test("a failed limiter fails closed before creating a session", async () => {
  const worker = workerOptions("unavailable-limiter");
  worker.config.env.API_LIMIT = { type: "text", value: "unavailable" };
  const broken = new Miniflare({ cf: false, enableDevRegistry: false, workers: [worker] });
  try {
    const brokenDb = await broken.getD1Database("DB");
    await migrateD1(brokenDb);
    const brokenApi = apiAt(origin, broken.dispatchFetch.bind(broken));
    const { publicKey } = await keyPair();
    const response = await brokenApi("/api/sessions", { body: { publicKey } });
    assert.equal(response.status, 503);
    assert.deepEqual(response.data, { error: "service_unavailable" });
    assert.equal((await brokenDb.prepare("SELECT count(*) AS count FROM lab_sessions").first()).count, 0);
  } finally {
    await broken.dispose();
  }
});

test("Siteverify requires the configured hostname and action and rejects a used challenge", async () => {
  const { publicKey } = await keyPair();
  const create = (turnstileToken) => api("/api/sessions", { body: { publicKey, turnstileToken } });
  for (const token of ["other-hostname", "other-action"]) {
    const response = await create(token);
    assert.equal(response.status, 403);
    assert.deepEqual(response.data, { error: "turnstile_rejected" });
  }
  const fresh = crypto.randomUUID();
  assert.equal((await create(fresh)).status, 201);
  assert.equal((await create(fresh)).status, 403);
  assert.equal((await api("/api/development/challenge", { method: "GET" })).status, 404);
});
