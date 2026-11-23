import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  publicDir: "dist",
  plugins: [cloudflare({ remoteBindings: false, types: { includeRuntime: false } })],
  server: { port: 8787, strictPort: true },
});
