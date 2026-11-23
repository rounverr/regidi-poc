import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer, request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { exportJWK, generateKeyPair } from "jose";
import { nodeConfig } from "../src/node/config.ts";
import { developmentChallenge, sqliteLimiter } from "../src/node/protection.ts";
import { createNodeServer } from "../src/node/index.ts";
import { openSqlite } from "../src/persistence/sqlite.ts";
import { DEVELOPMENT_CHALLENGE_PATH } from "../src/shared/turnstile.ts";
import { REQUEST_PATH } from "../src/shared/protocol.ts";
import { apiAt, envelope, expectDecision, grant, keyPair } from "./client.mjs";
import { migrations } from "./migrations.mjs";

const { privateKey } = await generateKeyPair("ES256", { extractable: true });
const env = {
  NODE_ENV: "development",
  REGIDI_CHALLENGE: "development",
  REGIDI_SQLITE_PATH: ":memory:",
  ISSUER_PRIVATE_JWK: JSON.stringify(await exportJWK(privateKey)),
};

test("Node configuration rejects an unsafe challenge, origin, port or issuer", async () => {
  for (const invalid of [
    { NODE_ENV: "production" }, { REGIDI_HOST: "0.0.0.0" },
    { REGIDI_PUBLIC_ORIGIN: "http://other.test:8787" }, { REGIDI_PORT: "" }, { REGIDI_PORT: "65536" },
    { REGIDI_SQLITE_PATH: "" }, { REGIDI_CHALLENGE: "unknown" }, { ISSUER_PRIVATE_JWK: "" },
    { REGIDI_CHALLENGE: undefined, REGIDI_PUBLIC_ORIGIN: "https://lab.example.com" },
    { REGIDI_PUBLIC_ORIGIN: "http://localhost:8787/lab" },
  ]) assert.throws(() => nodeConfig({ ...env, ...invalid }));
  assert.equal(nodeConfig(env).publicOrigin, "http://127.0.0.1:8787");
  await assert.rejects(createNodeServer(nodeConfig({ ...env, ISSUER_PRIVATE_JWK: "{}" })), /Invalid issuer key/);
});

test("the listening Node server serves the browser assets and verifies a delegation without Cloudflare credentials", async (t) => {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const { port } = reservation.address();
  await new Promise(resolve => reservation.close(resolve));
  const config = nodeConfig({ ...env, REGIDI_PORT: String(port) });
  const server = await createNodeServer(config);
  t.after(() => new Promise(resolve => server.close(resolve)));
  server.listen(config.port, config.host);
  await once(server, "listening");
  const origin = config.publicOrigin;
  const api = apiAt(origin);

  const page = await fetch(new URL("/lab/", origin));
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("X-Frame-Options"), "DENY");
  assert.match(await page.text(), /Create agent/);
  const redirect = await fetch(new URL("/lab", origin), { redirect: "manual" });
  assert.equal(redirect.headers.get("location"), "/lab/");
  assert.equal((await fetch(new URL("/absent/", origin))).status, 404);

  const { publicKey, privateKey } = await keyPair();
  const makeSession = (turnstileToken) => api("/api/sessions", { body: { publicKey, turnstileToken } });
  const unexpectedHost = new Promise((resolve, reject) => {
    const req = request(new URL(DEVELOPMENT_CHALLENGE_PATH, origin), { headers: { Host: "other.test" } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.once("error", reject);
    req.end();
  });
  assert.equal(await unexpectedHost, 403);
  assert.equal((await makeSession("unissued-token")).status, 403);
  const challenge = await api(DEVELOPMENT_CHALLENGE_PATH, { method: "GET" });
  assert.equal(challenge.status, 200);
  assert.equal(challenge.headers.get("cache-control"), "no-store");
  const registrations = await Promise.all([makeSession(challenge.data.token), makeSession(challenge.data.token)]);
  assert.deepEqual(registrations.map(({ status }) => status).sort(), [201, 403]);
  const agent = { ...registrations.find(({ status }) => status === 201).data, privateKey };

  const delegation = await grant(api, agent);
  const submit = (body) => api(REQUEST_PATH, { token: agent.token, body });
  const operation = await envelope(config.publicOrigin, agent, delegation.credential);
  const results = await Promise.all([submit(operation), submit(operation)]);
  assert.deepEqual(results.map(({ data }) => data.code).sort(), ["allowed", "replay"]);
  assert.equal((await api("/api/delegations/revoke", { token: agent.token, body: { id: delegation.id } })).status, 200);
  expectDecision(await submit(await envelope(config.publicOrigin, agent, delegation.credential)), "revoked", "revocation");
  assert.equal((await api("/api/sessions/current", { method: "DELETE", token: agent.token })).status, 204);
  assert.equal((await submit(operation)).status, 401);

  // Ten 18-unit challenges fill the socket peer's budget, regardless of address headers.
  const getChallenge = (address) => api(DEVELOPMENT_CHALLENGE_PATH, {
    method: "GET",
    headers: {
      Forwarded: `for=${address}`,
      "X-Forwarded-For": address,
      "X-Real-IP": address,
      "CF-Connecting-IP": address,
    },
  });
  for (let visitor = 1; visitor <= 9; visitor++) {
    assert.equal((await getChallenge(`192.0.2.${visitor}`)).status, 200);
  }
  const blocked = await getChallenge("198.51.100.1");
  assert.equal(blocked.status, 429);
  assert.deepEqual(blocked.data, { error: "rate_limited" });
});

test("SQLite migrates an empty file once, reopens it and checks migration integrity", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "regidi-lab-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "lab.sqlite");
  const initial = openSqlite(path);
  assert.deepEqual(initial.database.prepare("SELECT name FROM lab_schema_migrations ORDER BY name").all().map(row => row.name),
    migrations.map(({ name }) => name));
  initial.database.prepare("UPDATE lab_metrics SET step_1_count = 123 WHERE id = 1").run();
  initial.database.close();
  const reopened = openSqlite(path);
  assert.equal(reopened.database.prepare("SELECT step_1_count FROM lab_metrics").get().step_1_count, 123);
  reopened.database.prepare("UPDATE lab_schema_migrations SET checksum = 'wrong' WHERE name = ?").run(migrations[0].name);
  reopened.database.close();
  assert.throws(() => openSqlite(path), /migration history differs/);
});

test("SQLite rolls back the migration chain if it cannot apply a later migration", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "regidi-lab-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "lab.sqlite");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE lab_metrics (id INTEGER PRIMARY KEY)");
  db.close();
  assert.throws(() => openSqlite(path), /last_interaction_at_arg/);
  const inspected = new DatabaseSync(path);
  try {
    assert.equal(inspected.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name = 'lab_sessions'").get().count, 0);
  } finally {
    inspected.close();
  }
});

test("independent SQLite connections commit a proof only once", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "regidi-race-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "lab.sqlite");
  const issuer = openSqlite(path);
  const { publicKey } = await keyPair();
  const expiresAt = Math.floor(Date.now() / 1000) + 120;
  await issuer.store.saveSession("session", { id: "agent", publicKey, thumbprint: "jkt", expiresAt });
  await issuer.store.saveGrant("session", "grant", expiresAt);
  issuer.database.close();

  const adapter = new URL("../src/persistence/sqlite.ts", import.meta.url).href;
  const threads = Array.from({ length: 2 }, () => new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    import(workerData.adapter).then(({ openSqlite }) => {
      const { database, store } = openSqlite(workerData.path);
      parentPort.postMessage("ready");
      parentPort.once("message", async () => {
        parentPort.postMessage(await store.consumeProof("session", "proof"));
        database.close();
      });
    });
  `, { eval: true, workerData: { adapter, path } }));
  t.after(() => Promise.all(threads.map(thread => thread.terminate())));
  await Promise.all(threads.map(thread => once(thread, "message")));
  const results = threads.map(thread => once(thread, "message"));
  threads.forEach(thread => thread.postMessage("start"));
  assert.equal((await Promise.all(results)).flat().filter(result => result.unused).length, 1);
});

test("SQLite enforces the exact weighted budget and resets expired windows", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "regidi-protection-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "lab.sqlite");
  const first = openSqlite(path).database;
  const second = openSqlite(path).database;
  try {
    const consumeFirst = sqliteLimiter(first);
    const consumeSecond = sqliteLimiter(second);
    assert.equal(await consumeFirst("shared", 181), false);
    assert.equal(await consumeFirst("shared", 179), true);
    assert.equal(await consumeSecond("shared", 4), false);
    assert.equal(await consumeSecond("shared", 1), true);
    assert.equal(await consumeFirst("shared", 1), false);
    assert.equal(first.prepare("SELECT count FROM lab_rate_limits WHERE key = 'shared'").get().count, 180);

    second.prepare("UPDATE lab_rate_limits SET expires_at = unixepoch()").run();
    assert.equal(await consumeFirst("shared", 181), false);
    assert.equal(await consumeFirst("shared", 180), true);
    assert.equal(await consumeSecond("shared", 1), false);
    assert.equal(second.prepare("SELECT count FROM lab_rate_limits WHERE key = 'shared'").get().count, 180);
  } finally {
    second.close();
    first.close();
  }
});

test("SQLite challenge tokens expire and only a fresh token can be consumed once", async () => {
  const { database } = openSqlite(":memory:");
  try {
    const challenge = developmentChallenge(database);
    const token = challenge.issue();
    database.prepare("UPDATE lab_development_challenges SET expires_at = unixepoch()").run();
    await assert.rejects(challenge.verify(token), { code: "turnstile_rejected" });
    const fresh = challenge.issue();
    await challenge.verify(fresh);
    await assert.rejects(challenge.verify(fresh), { code: "turnstile_rejected" });
  } finally {
    database.close();
  }
});

test("concurrent SQLite connections cannot spend the same remaining budget", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "regidi-limiter-race-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "lab.sqlite");
  const { database } = openSqlite(path);
  try {
    assert.equal(await sqliteLimiter(database)("shared", 176), true);
  } finally {
    database.close();
  }

  const protection = new URL("../src/node/protection.ts", import.meta.url).href;
  const threads = Array.from({ length: 2 }, () => new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    const { DatabaseSync } = require("node:sqlite");
    import(workerData.protection).then(({ sqliteLimiter }) => {
      const database = new DatabaseSync(workerData.path, { timeout: 5_000 });
      const consume = sqliteLimiter(database);
      parentPort.postMessage("ready");
      parentPort.once("message", async () => {
        const allowed = await consume("shared", 4);
        database.close();
        parentPort.postMessage(allowed);
      });
    });
  `, { eval: true, workerData: { protection, path } }));
  t.after(() => Promise.all(threads.map(thread => thread.terminate())));
  await Promise.all(threads.map(thread => once(thread, "message")));
  const results = threads.map(thread => once(thread, "message"));
  threads.forEach(thread => thread.postMessage("start"));
  assert.deepEqual((await Promise.all(results)).flat().sort(), [false, true]);
});

test("SQLite rate-limit usage survives a Node process restart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "regidi-limiter-restart-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "lab.sqlite");
  const protection = new URL("../src/node/protection.ts", import.meta.url).href;
  const runNode = promisify(execFile);
  async function consumeInProcess(weight) {
    const { stdout } = await runNode(process.execPath, ["--input-type=module", "--eval", `
      import { DatabaseSync } from "node:sqlite";
      const { sqliteLimiter } = await import(process.argv[1]);
      const database = new DatabaseSync(process.argv[2]);
      console.log(await sqliteLimiter(database)("shared", Number(process.argv[3])));
      database.close();
    `, protection, path, String(weight)]);
    return stdout.trim();
  }

  assert.equal(await consumeInProcess(177), "true");
  assert.equal(await consumeInProcess(4), "false");
  assert.equal(await consumeInProcess(3), "true");
  assert.equal(await consumeInProcess(1), "false");
});
