import assert from "node:assert/strict";
import { test } from "node:test";
import { Miniflare } from "miniflare";
import { d1Store } from "../src/persistence/d1.ts";
import { openSqlite } from "../src/persistence/sqlite.ts";
import { migrateD1, migrations } from "./migrations.mjs";

const localWorker = {
  config: {
    name: "persistence-tests",
    compatibilityDate: "2026-11-21",
    manifest: {
      mainModule: "index.js",
      modules: { "index.js": { type: "esm", contents: "export default { fetch: () => new Response() }" } },
    },
    env: { DB: { type: "d1", name: "persistence-tests" } },
  },
};

async function d1Fixture(t, apply = true) {
  const worker = new Miniflare({ cf: false, enableDevRegistry: false, workers: [localWorker] });
  t.after(() => worker.dispose());
  const db = await worker.getD1Database("DB");
  if (apply) await migrateD1(db);
  return { db, store: d1Store(db), first: (query) => db.prepare(query).first() };
}

async function sqliteFixture(t) {
  const { database, store } = openSqlite(":memory:");
  t.after(() => database.close());
  return { store, first: async (query) => database.prepare(query).get() ?? null };
}

const seconds = () => Math.floor(Date.now() / 1000);
const session = (expiresAt) => ({ id: "agent", publicKey: { kty: "EC", crv: "P-256", x: "x", y: "y" }, thumbprint: "jkt", expiresAt });

for (const [name, fixture] of [["D1", d1Fixture], ["SQLite", sqliteFixture]]) {
  test(`${name} preserves proof, revocation, expiry and rollback semantics`, async (t) => {
    const { store, first } = await fixture(t);
    const agent = session(seconds() + 120);
    await store.saveSession("active", agent);
    assert.equal((await store.findAgent("active")).jwk, JSON.stringify(agent.publicKey));
    assert.equal(await store.saveGrant("active", "grant", agent.expiresAt), true);

    const results = await Promise.all([
      store.consumeProof("active", "proof"),
      store.consumeProof("active", "proof"),
    ]);
    assert.equal(results.filter((result) => result.unused).length, 1);
    assert.ok(results.every((result) => result.grantId === "grant" && result.revokedAt === null));

    const [revokedAt, duringRevocation] = await Promise.all([
      store.revokeGrant("active", "grant"),
      store.consumeProof("active", "another-proof"),
    ]);
    assert.ok(revokedAt > 0);
    assert.ok(duringRevocation.unused);
    assert.ok(duringRevocation.revokedAt === null || duringRevocation.revokedAt === revokedAt);
    assert.equal(await store.revokeGrant("active", "grant"), revokedAt);
    assert.equal((await store.consumeProof("active", "after-revocation")).revokedAt, revokedAt);
    assert.equal(await store.revokeGrant("active", "other-grant"), null);
    assert.equal(await store.saveGrant("active", "replacement", agent.expiresAt), true);
    const replacement = await store.consumeProof("active", "replacement-proof");
    assert.equal(replacement.grantId, "replacement");
    assert.equal(replacement.revokedAt, null);

    await store.saveSession("expired", session(seconds() - 1));
    assert.equal(await store.saveGrant("expired", "expired-grant", agent.expiresAt), false);
    assert.equal(await store.findAgent("expired"), null);
    assert.equal(await store.revokeGrant("expired", "grant"), null);
    assert.equal(await store.consumeProof("expired", "never-used"), null);

    // Duplicate insertion must also roll back the expired-session cleanup in the batch.
    await assert.rejects(store.saveSession("active", agent));
    assert.equal((await first("SELECT count(*) AS count FROM lab_sessions WHERE token_hash = 'expired'")).count, 1);
    await store.saveSession("new", agent);
    assert.equal((await first("SELECT count(*) AS count FROM lab_sessions WHERE token_hash = 'expired'")).count, 0);
    await store.resetSession("active");
    assert.equal((await first("SELECT count(*) AS count FROM lab_used_proofs")).count, 0);

    const metrics = await first("SELECT step_1_count, step_2_count, step_3_count, last_interaction_at FROM lab_metrics");
    assert.deepEqual({ ...metrics }, {
      step_1_count: 3, step_2_count: 2, step_3_count: 4, last_interaction_at: metrics.last_interaction_at,
    });
    assert.match(metrics.last_interaction_at, /-03:00$/);
  });
}

test("D1 upgrades the original metrics schema without resetting historic values", async (t) => {
  const { db, store, first } = await d1Fixture(t, false);
  await migrateD1(db, migrations.slice(0, 2));
  await store.saveSession("historical", session(seconds() + 120));
  const before = await first("SELECT step_1_count, last_interaction_at_arg FROM lab_metrics");
  await migrateD1(db, migrations.slice(2));
  const after = await first("SELECT step_1_count, last_interaction_at FROM lab_metrics");
  assert.equal(after.step_1_count, 1);
  assert.equal(after.last_interaction_at, before.last_interaction_at_arg);
});
