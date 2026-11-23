import { defineConfig } from "astro/config";
import react from "@astrojs/react";

export default defineConfig({
  output: "static",
  trailingSlash: "always",
  integrations: [react()],
  markdown: { syntaxHighlight: false },
  security: {
    csp: {
      directives: [
        "default-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "connect-src 'self' https://challenges.cloudflare.com",
        "frame-src https://challenges.cloudflare.com",
      ],
      scriptDirective: { resources: ["'self'", "https://challenges.cloudflare.com"] },
      styleDirective: { resources: ["'self'"] },
    },
  },
  devToolbar: { enabled: false },
});
