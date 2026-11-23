import { app } from "../api/app.ts";
import { verifyAgentChallenge } from "../api/turnstile.ts";
import { d1Store } from "../persistence/d1.ts";

export default {
  fetch(request, env) {
    return app.fetch(request, {
      issuer: env,
      store: d1Store(env.DB),
      challenge: {
        verify: (token) => verifyAgentChallenge(env.TURNSTILE_SECRET, env.TURNSTILE_HOSTNAME, token),
      },
      async consumeRateLimit(key, delta) {
        return (await env.API_LIMIT.limit({ key, delta })).success;
      },
      clientAddress: request.headers.get("CF-Connecting-IP") ?? undefined,
    });
  },
} satisfies ExportedHandler<Env>;
