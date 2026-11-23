import assert from "node:assert/strict";
import { SignJWT } from "jose";
import {
  canonicalOperation, PROOF_TYPE, REQUEST_PATH, sha256,
} from "../src/shared/protocol.ts";

export const flight = {
  service: "aero", operation: "prepare_booking", amountCents: 65_000, currency: "USD",
};
export const flightGrant = {
  service: "aero", operation: "prepare_booking", maxAmountCents: 80_000, durationSeconds: 300,
};

export function apiAt(origin, dispatch = fetch) {
  return async (path, { token, body, method = "POST", headers = {} } = {}) => {
    const response = await dispatch(new URL(path, origin).href, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, headers: response.headers, data: response.status === 204 ? null : await response.json() };
  };
}

export async function keyPair() {
  const keys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"],
  );
  assert.equal(keys.privateKey.extractable, false);
  const { kty, crv, x, y } = await crypto.subtle.exportKey("jwk", keys.publicKey);
  return { publicKey: { kty, crv, x, y }, privateKey: keys.privateKey };
}

export async function start(api, turnstileToken) {
  const { publicKey, privateKey } = await keyPair();
  const result = await api("/api/sessions", { body: { publicKey, turnstileToken } });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return { ...result.data, privateKey };
}

export async function grant(api, agent, scope = flightGrant) {
  const result = await api("/api/delegations", { token: agent.token, body: scope });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.data;
}

export async function envelope(origin, agent, credential, request = flight, options = {}) {
  const proof = await new SignJWT({
    htm: "POST",
    htu: new URL(options.path ?? REQUEST_PATH, origin).href,
    ath: await sha256(credential),
    body: await sha256(canonicalOperation(request)),
  })
    .setProtectedHeader({ alg: "ES256", typ: PROOF_TYPE })
    .setJti(crypto.randomUUID())
    .setIssuedAt(options.issuedAt ?? Math.floor(Date.now() / 1000))
    .sign(agent.privateKey);
  return { credential, proof, request };
}

export function expectDecision(response, code, failedCheck) {
  assert.equal(response.status, code === "allowed" ? 200 : 403, JSON.stringify(response.data));
  assert.equal(response.data.code, code);
  assert.equal(response.data.allowed, code === "allowed");
  if (failedCheck) assert.equal(response.data.checks[failedCheck], "failed");
}
