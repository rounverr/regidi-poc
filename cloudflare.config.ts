import { bindings, defineConfig } from "cf/config";

export const localDatabaseId = "00000000-0000-4000-8000-000000000001";

export default defineConfig(({ mode, isPreview }) => {
  const origin = process.env.REGIDI_PUBLIC_ORIGIN ? new URL(process.env.REGIDI_PUBLIC_ORIGIN) : undefined;
  return {
    worker: {
      name: process.env.REGIDI_WORKER_NAME ?? "regidi-lab-local",
      entrypoint: "./src/worker/index.ts",
      compatibilityDate: "2026-11-21",
      assets: {
        htmlHandling: "force-trailing-slash",
        notFoundHandling: "404-page",
        runWorkerFirst: ["/api", "/api/*"],
      },
      domains: mode === "production" && !isPreview && origin?.protocol === "https:" ? [origin.hostname] : undefined,
      workersDev: false,
      previewUrls: false,
      env: {
        DB: bindings.d1({
          name: process.env.REGIDI_D1_NAME ?? "regidi-lab-local",
          id: mode === "development" ? localDatabaseId : process.env.REGIDI_D1_ID ?? localDatabaseId,
        }),
        API_LIMIT: bindings.rateLimit({
          namespace: process.env.REGIDI_RATE_NAMESPACE ?? "1",
          simple: { limit: 180, period: 60 },
        }),
        ISSUER: bindings.text(process.env.REGIDI_ISSUER ?? "urn:regidi:lab:issuer"),
        AIR_AUDIENCE: bindings.text(process.env.REGIDI_AIR_AUDIENCE ?? "urn:regidi:lab:aero"),
        BANK_AUDIENCE: bindings.text(process.env.REGIDI_BANK_AUDIENCE ?? "urn:regidi:lab:bank"),
        TURNSTILE_HOSTNAME: bindings.text(origin?.hostname ?? "localhost"),
        ISSUER_PRIVATE_JWK: bindings.secret(),
        TURNSTILE_SECRET: bindings.secret(),
      },
    },
  };
});
