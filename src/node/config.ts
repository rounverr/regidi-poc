import type { IssuerConfig } from "../domain/issuer.ts";

export interface NodeConfig {
  host: string;
  port: number;
  publicOrigin: string;
  databasePath: string;
  issuer: IssuerConfig;
  challenge: { mode: "development" } | { mode: "turnstile"; secret: string; hostname: string };
}

/** Reject unsafe deployment settings before opening the database or binding the server. */
export function nodeConfig(env: NodeJS.ProcessEnv): NodeConfig {
  const host = env.REGIDI_HOST ?? "127.0.0.1";
  const port = Number(env.REGIDI_PORT ?? "8787");
  const local = env.REGIDI_CHALLENGE === "development";
  const databasePath = env.REGIDI_SQLITE_PATH ?? "./regidi-lab.sqlite";
  if (!host.trim() || !Number.isInteger(port) || port < 1 || port > 65535 || !databasePath.trim()) {
    throw new Error("Set a valid REGIDI_HOST, REGIDI_PORT and REGIDI_SQLITE_PATH");
  }
  if (!local && env.REGIDI_CHALLENGE !== undefined && env.REGIDI_CHALLENGE !== "turnstile") {
    throw new Error("REGIDI_CHALLENGE must be turnstile or development");
  }
  if (local && (env.NODE_ENV !== "development" || host !== "127.0.0.1")) {
    throw new Error("The development challenge requires NODE_ENV=development and REGIDI_HOST=127.0.0.1");
  }

  const origin = URL.parse(env.REGIDI_PUBLIC_ORIGIN ?? (local ? `http://127.0.0.1:${port}` : ""));
  if (!origin || origin.href !== `${origin.origin}/` || !["http:", "https:"].includes(origin.protocol)) {
    throw new Error("REGIDI_PUBLIC_ORIGIN must be an HTTP or HTTPS origin without a path");
  }
  if (local && (!["127.0.0.1", "localhost"].includes(origin.hostname) || origin.origin !== new URL(`http://${origin.hostname}:${port}`).origin)) {
    throw new Error("The development public origin must match the loopback HTTP listener");
  }
  const secret = env.TURNSTILE_SECRET?.trim();
  const challenge = local ? { mode: "development" as const } : turnstileConfig(origin, secret, env.PUBLIC_TURNSTILE_SITE_KEY);
  if (!env.ISSUER_PRIVATE_JWK?.trim()) throw new Error("Set ISSUER_PRIVATE_JWK to a generated P-256 key");

  return {
    host, port, databasePath, publicOrigin: origin.origin,
    issuer: {
      ISSUER: env.REGIDI_ISSUER ?? "urn:regidi:lab:issuer",
      AIR_AUDIENCE: env.REGIDI_AIR_AUDIENCE ?? "urn:regidi:lab:aero",
      BANK_AUDIENCE: env.REGIDI_BANK_AUDIENCE ?? "urn:regidi:lab:bank",
      ISSUER_PRIVATE_JWK: env.ISSUER_PRIVATE_JWK,
    },
    challenge,
  };
}

function turnstileConfig(origin: URL, secret: string | undefined, siteKey: string | undefined): NodeConfig["challenge"] {
  if (origin.protocol !== "https:" || !secret || !siteKey?.trim() || !origin.hostname.includes(".") ||
      /^127\./.test(origin.hostname)) {
    throw new Error("Turnstile mode requires a public HTTPS origin, PUBLIC_TURNSTILE_SITE_KEY and TURNSTILE_SECRET");
  }
  return { mode: "turnstile", secret, hostname: origin.hostname };
}
