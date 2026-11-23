import assert from "node:assert/strict";
import { apiAt, envelope, expectDecision, flight, grant, start } from "./client.mjs";
import { DEVELOPMENT_CHALLENGE_PATH } from "../src/shared/turnstile.ts";
import { REQUEST_PATH } from "../src/shared/protocol.ts";

const origin = process.argv[2] ?? "http://127.0.0.1:8787";
const api = apiAt(origin);
let turnstileToken = process.env.TURNSTILE_TOKEN;
if (!turnstileToken && ["127.0.0.1", "localhost"].includes(new URL(origin).hostname)) {
  const challenge = await api(DEVELOPMENT_CHALLENGE_PATH, { method: "GET" });
  if (challenge.status === 200) turnstileToken = challenge.data.token;
}
assert.ok(turnstileToken, "A fresh, unused Turnstile token for create_agent is required in TURNSTILE_TOKEN.");
const landing = await fetch(new URL("/", origin));
assert.equal(landing.status, 200);
assert.match(await landing.text(), /Open the lab/);

const agent = await start(api, turnstileToken);
try {
  const delegation = await grant(api, agent);
  const submit = async (request) => api(REQUEST_PATH, {
    token: agent.token, body: await envelope(origin, agent, delegation.credential, request),
  });
  expectDecision(await submit(flight), "allowed");
  expectDecision(await submit({ ...flight, amountCents: 120_000 }), "amount", "amount");
  expectDecision(await submit({ ...flight, service: "bank", operation: "prepare_transfer" }), "audience", "audience");
  const revoke = await api("/api/delegations/revoke", { token: agent.token, body: { id: delegation.id } });
  assert.equal(revoke.status, 200);
  expectDecision(await submit(flight), "revoked", "revocation");
} finally {
  const reset = await api("/api/sessions/current", { token: agent.token, method: "DELETE" });
  assert.equal(reset.status, 204);
}
console.log(`Smoke test passed at ${origin}`);
