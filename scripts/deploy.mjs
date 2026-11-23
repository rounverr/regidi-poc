import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { localDatabaseId } from "../cloudflare.config.ts";

const root = new URL("../", import.meta.url);
const output = new URL(".cloudflare/output/v1/", root);
const bindingTypes = {
  DB: ["d1", "d1"],
  API_LIMIT: ["rate-limit", "ratelimit"],
  ISSUER: ["text", "plain_text"],
  AIR_AUDIENCE: ["text", "plain_text"],
  BANK_AUDIENCE: ["text", "plain_text"],
  ISSUER_PRIVATE_JWK: ["secret", "secret_text"],
  TURNSTILE_SECRET: ["secret", "secret_text"],
  TURNSTILE_HOSTNAME: ["text", "plain_text"],
};

function requireCondition(valid, message) {
  if (!valid) throw new Error(message);
}

export function validateBuild(env, build, worker) {
  requireCondition(!env.WORKERS_CI && !env.WORKERS_CI_BUILD_UUID && (!env.CI || env.CI === "false"),
    "Regidi Lab uses manual releases. Run this command outside CI and Workers Builds.");
  requireCondition(/^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID ?? ""),
    "Set CLOUDFLARE_ACCOUNT_ID to the intended Cloudflare account ID.");
  const origin = URL.parse(env.REGIDI_PUBLIC_ORIGIN ?? "");
  requireCondition(origin?.protocol === "https:" && origin.href === `${origin.origin}/` && !origin.port,
    "Set REGIDI_PUBLIC_ORIGIN to the intended public HTTPS origin.");
  requireCondition(env.REGIDI_WORKER_NAME && env.REGIDI_D1_NAME && /^\d+$/.test(env.REGIDI_RATE_NAMESPACE ?? ""),
    "Set the explicit Worker, D1 and rate limiting target values before deploying.");
  requireCondition(env.PUBLIC_TURNSTILE_SITE_KEY, "Set the public Turnstile site key before building.");
  requireCondition(build?.buildContext?.mode === "production" && build.buildContext.isPreview === false,
    "Build fresh production output with npm run build:cloudflare.");
  requireCondition(worker?.name === env.REGIDI_WORKER_NAME, `Build Output must target ${env.REGIDI_WORKER_NAME}.`);
  requireCondition(Array.isArray(worker.domains) && worker.domains.length === 1 &&
    worker.domains[0] === origin.hostname, `Build Output must contain only ${origin.hostname}.`);
  requireCondition(worker.workersDev === false && worker.previewUrls === false,
    "Build Output must disable workers.dev and preview URLs.");
  requireCondition(worker.assets?.htmlHandling === "force-trailing-slash" &&
    worker.assets.notFoundHandling === "404-page" &&
    JSON.stringify(worker.assets.runWorkerFirst) === '["/api","/api/*"]',
    "Build Output does not match the production Static Assets routing.");

  const bindings = worker.env;
  for (const [name, [localType]] of Object.entries(bindingTypes)) {
    requireCondition(bindings?.[name]?.type === localType, `Invalid or missing Build Output binding: ${name}.`);
  }
  requireCondition(bindings.TURNSTILE_HOSTNAME.value === origin.hostname,
    "Build Output must verify Turnstile for the configured origin.");
  requireCondition(bindings.API_LIMIT.namespace === env.REGIDI_RATE_NAMESPACE,
    "Build Output must use the configured rate limit namespace.");
  const dbId = bindings.DB.id;
  requireCondition(bindings.DB.name === env.REGIDI_D1_NAME && typeof dbId === "string" &&
    /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(dbId) && dbId !== localDatabaseId &&
    dbId === env.REGIDI_D1_ID, "Set REGIDI_D1_ID to the existing production database UUID and rebuild.");
}

export function validateRemote(worker, settings, domains) {
  const [domain] = worker.domains;
  requireCondition(Array.isArray(domains) && domains.length === 1 &&
    domains[0].hostname === domain && domains[0].service === worker.name &&
    domains[0].environment === "production" && domains[0].enabled === true && domains[0].previews_enabled === false,
    `Configure ${domain} as the sole enabled Custom Domain for ${worker.name} before publishing.`);

  requireCondition(Array.isArray(settings?.bindings), "Could not read bindings for the existing production Worker.");
  const remote = new Map(settings.bindings.map(binding => [binding.name, binding]));
  requireCondition(remote.size === Object.keys(worker.env).length && Object.keys(worker.env).every(name => remote.has(name)),
    "Build Output and production must declare the same bindings.");
  for (const [name, [, remoteType]] of Object.entries(bindingTypes)) {
    requireCondition(remote.get(name)?.type === remoteType, `Invalid or missing production binding: ${name}.`);
  }
  const bind = worker.env;
  const limiter = remote.get("API_LIMIT");
  requireCondition(remote.get("DB").id === bind.DB.id, "Build Output D1 ID differs from the production binding.");
  requireCondition(String(limiter.namespace_id) === bind.API_LIMIT.namespace &&
    limiter.simple?.limit === bind.API_LIMIT.simple?.limit && limiter.simple?.period === bind.API_LIMIT.simple?.period,
    "Build Output rate limit differs from production.");
  for (const name of ["ISSUER", "AIR_AUDIENCE", "BANK_AUDIENCE", "TURNSTILE_HOSTNAME"]) {
    requireCondition(remote.get(name).text === bind[name].value, `Build Output value differs from production: ${name}.`);
  }
}

async function readCloudflare(accountId, path, token) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Cloudflare preflight could not read ${path} (HTTP ${response.status}).`);
  const data = await response.json();
  if (data.success !== true) throw new Error(`Cloudflare preflight could not read ${path}.`);
  return data.result;
}

async function main() {
  const { values } = parseArgs({
    options: { check: { type: "boolean" }, "dry-run": { type: "boolean" }, message: { type: "string" } },
  });
  const [build, worker] = await Promise.all(
    ["config.json", "workers/default/worker.config.json"].map(async path =>
      JSON.parse(await readFile(new URL(path, output), "utf8"))),
  );
  validateBuild(process.env, build, worker);

  const token = process.env.CLOUDFLARE_API_TOKEN;
  requireCondition(token, "Export a Cloudflare API token scoped to the intended account.");
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const [settings, domains] = await Promise.all([
    readCloudflare(accountId, `/workers/scripts/${encodeURIComponent(worker.name)}/settings`, token),
    readCloudflare(accountId, `/workers/domains?service=${encodeURIComponent(worker.name)}`, token),
  ]);
  validateRemote(worker, settings, domains);
  console.log(`Preflight passed for ${worker.name} at https://${worker.domains[0]}/.`);
  if (values.check) return;

  const cli = fileURLToPath(new URL("node_modules/cf/bin/cf", root));
  const flags = ["deploy", "--prebuilt", "--mode", "production", "--no-provision"];
  if (values["dry-run"]) flags.push("--dry-run");
  if (values.message) flags.push("--message", values.message);
  execFileSync(process.execPath, [cli, ...flags], { cwd: root, stdio: "inherit" });
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
