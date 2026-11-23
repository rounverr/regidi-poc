import { createAdaptorServer, type HttpBindings, type Http2Bindings } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { access, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "../api/app.ts";
import { verifyAgentChallenge } from "../api/turnstile.ts";
import type { LabRuntime } from "../api/runtime.ts";
import { loadIssuer } from "../domain/issuer.ts";
import { openSqlite } from "../persistence/sqlite.ts";
import { nodeConfig, type NodeConfig } from "./config.ts";
import { developmentChallenge, sqliteLimiter } from "./protection.ts";

const assets = fileURLToPath(new URL("../../dist/", import.meta.url));

export async function createNodeServer(config: NodeConfig) {
  await access(join(assets, "lab/index.html"));
  try {
    const { jwk } = await loadIssuer(config.issuer);
    await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  } catch {
    throw new Error("Invalid issuer key or issuer configuration");
  }

  const { database, store } = openSqlite(config.databasePath);
  try {
    const challengeConfig = config.challenge;
    const runtime: LabRuntime = {
      store,
      issuer: config.issuer,
      publicOrigin: config.publicOrigin,
      challenge: challengeConfig.mode === "development" ?
        developmentChallenge(database) :
        { verify: (token) => verifyAgentChallenge(challengeConfig.secret, challengeConfig.hostname, token) },
      consumeRateLimit: sqliteLimiter(database),
    };

    const site = new Hono<{ Bindings: HttpBindings | Http2Bindings }>({ strict: false });
    site.all("/api/*", (c) => app.fetch(c.req.raw, {
      ...runtime,
      // Use the socket peer. Forwarded client addresses are ignored.
      clientAddress: c.env.incoming.socket.remoteAddress,
    }));
    site.use("*", async (c, next) => {
      c.header("X-Content-Type-Options", "nosniff");
      c.header("Referrer-Policy", "no-referrer");
      c.header("X-Frame-Options", "DENY");
      c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
      await next();
    });
    site.get("/_astro/*", async (c, next) => {
      await next();
      if (c.res.ok) c.header("Cache-Control", "public, max-age=31536000, immutable");
    });
    site.get("*", async (c, next) => {
      const { pathname: path, search } = new URL(c.req.url);
      if (/^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(path) &&
          (await stat(join(assets, path, "index.html")).catch(() => null))?.isFile()) {
        return c.redirect(path + "/" + search, 307);
      }
      await next();
    }, serveStatic({ root: assets }));
    const notFound = serveStatic({ path: join(assets, "404.html") });
    site.notFound(async (c) => {
      const response = await notFound(c, async () => {});
      if (!response) return c.text("Not Found", 404);
      return new Response(response.body, { headers: response.headers, status: 404 });
    });

    const server = createAdaptorServer({ fetch: site.fetch, hostname: config.host });
    server.once("close", () => database.close());
    return server;
  } catch (error) {
    database.close();
    throw error;
  }
}

if (import.meta.main) {
  try {
    const config = nodeConfig(process.env);
    const server = await createNodeServer(config);
    server.on("error", (error) => {
      console.error(`Could not listen: ${error.message}`);
      server.close();
      process.exitCode = 1;
    });
    server.listen(config.port, config.host, () => console.log(`Regidi Lab listening on ${config.host}:${config.port}`));
    process.once("SIGTERM", () => server.close());
    process.once("SIGINT", () => server.close());
  } catch (error) {
    console.error(`Regidi Lab could not start: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
