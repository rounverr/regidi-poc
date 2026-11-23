import assert from "node:assert/strict";
import { test } from "node:test";
import config, { localDatabaseId } from "../cloudflare.config.ts";
import { validateBuild, validateRemote } from "../scripts/deploy.mjs";

const retiredDomain = "other.example.com";
const target = {
  CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  REGIDI_PUBLIC_ORIGIN: "https://lab.example.com",
  REGIDI_WORKER_NAME: "example-lab",
  REGIDI_D1_NAME: "example-database",
  REGIDI_RATE_NAMESPACE: "42",
  PUBLIC_TURNSTILE_SITE_KEY: "example-widget",
};
const databaseId = "abcd0000-0000-4000-8000-abcd00000000";

function configure(env) {
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    return config({ mode: "production", isPreview: false }).worker;
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("production derives the Custom Domain and Siteverify hostname from the public origin", () => {
  const defaultWorker = configure({ REGIDI_PUBLIC_ORIGIN: "" });
  assert.equal(defaultWorker.domains, undefined);
  assert.equal(defaultWorker.env.TURNSTILE_HOSTNAME.value, "localhost");
  const worker = configure(target);
  assert.deepEqual(worker.domains, ["lab.example.com"]);
  assert.equal(worker.env.TURNSTILE_HOSTNAME.value, "lab.example.com");
});

test("local and preview configurations leave Custom Domains unset", () => {
  const local = config({ mode: "development", isPreview: false }).worker;
  assert.equal(local.env.DB.id, localDatabaseId);
  assert.equal(local.domains, undefined);
  assert.equal(config({ mode: "production", isPreview: true }).worker.domains, undefined);
  assert.equal(config({ mode: undefined, isPreview: false }).worker.domains, undefined);
});

function buildFixture() {
  const env = { ...target, REGIDI_D1_ID: databaseId };
  const build = { buildContext: { mode: "production", isPreview: false } };
  const worker = configure(env);
  return { env, build, worker };
}

test("preflight rejects unexpected accounts, automation, Workers, domains and builds", () => {
  const { env, build, worker } = buildFixture();
  assert.doesNotThrow(() => validateBuild(env, build, worker));
  assert.throws(() => validateBuild({ ...env, CLOUDFLARE_ACCOUNT_ID: "wrong" }, build, worker), /account/);
  assert.throws(() => validateBuild({ ...env, WORKERS_CI: "1" }, build, worker), /manual releases/);
  assert.throws(() => validateBuild({ ...env, CI: "true" }, build, worker), /manual releases/);
  assert.throws(() => validateBuild(env, build, { ...worker, name: "unexpected" }), /target/);
  for (const domains of [[], [retiredDomain], ["lab.example.com", retiredDomain]]) {
    assert.throws(() => validateBuild(env, build, { ...worker, domains }), /only lab/);
  }
  for (const buildContext of [{ mode: "development", isPreview: false }, { mode: "production", isPreview: true }]) {
    assert.throws(() => validateBuild(env, { buildContext }, worker), /production output/);
  }
  assert.throws(() => validateBuild({ ...env, REGIDI_D1_ID: undefined }, build, worker), /database UUID/);
  const { TURNSTILE_SECRET, ...incompleteBindings } = worker.env;
  assert.throws(() => validateBuild(env, build, { ...worker, env: incompleteBindings }), /TURNSTILE_SECRET/);
});

test("preflight checks the live domain and bindings without needing secret values", () => {
  const { worker } = buildFixture();
  const bindings = [
    { name: "DB", type: "d1", id: databaseId },
    { name: "API_LIMIT", type: "ratelimit", namespace_id: worker.env.API_LIMIT.namespace, simple: worker.env.API_LIMIT.simple },
    ...["ISSUER", "AIR_AUDIENCE", "BANK_AUDIENCE", "TURNSTILE_HOSTNAME"].map(name =>
      ({ name, type: "plain_text", text: worker.env[name].value })),
    { name: "ISSUER_PRIVATE_JWK", type: "secret_text" },
    { name: "TURNSTILE_SECRET", type: "secret_text" },
  ];
  const domain = { hostname: "lab.example.com", service: target.REGIDI_WORKER_NAME, environment: "production", enabled: true, previews_enabled: false };
  assert.doesNotThrow(() => validateRemote(worker, { bindings }, [domain]));
  assert.throws(() => validateRemote(worker, { bindings }, [{ ...domain, hostname: retiredDomain }]), /sole enabled Custom Domain/);
  assert.throws(() => validateRemote(worker, { bindings }, [{ ...domain, service: "another-worker" }]), /sole enabled Custom Domain/);
  assert.throws(() => validateRemote(worker, { bindings: bindings.slice(0, -1) }, [domain]), /same bindings/);
  const wrongDatabase = bindings.map(binding => binding.name === "DB" ? { ...binding, id: localDatabaseId } : binding);
  assert.throws(() => validateRemote(worker, { bindings: wrongDatabase }, [domain]), /D1 ID differs/);
});
