import * as z from "zod";
import { CREATE_AGENT_ACTION } from "../shared/turnstile.ts";
import { ApiError } from "../domain/validation.ts";

const verification = z.object({
  success: z.boolean(),
  hostname: z.string().optional(),
  action: z.string().optional(),
  "error-codes": z.array(z.string()).optional(),
});

/** Check the action and hostname of each single-use token using Siteverify. */
export async function verifyAgentChallenge(secret: string | undefined, hostname: string, token: string): Promise<void> {
  if (!secret?.trim() || !hostname) throw new ApiError(503, "turnstile_unavailable");

  let result: z.infer<typeof verification>;
  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: new URLSearchParams({ secret, response: token }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error();
    result = verification.parse(await response.json());
  } catch {
    throw new ApiError(503, "turnstile_unavailable");
  }

  const errors = result["error-codes"];
  if (errors?.some(code => ["internal-error", "missing-input-secret", "invalid-input-secret"].includes(code))) {
    throw new ApiError(503, "turnstile_unavailable");
  }
  if (!result.success || result.hostname !== hostname || result.action !== CREATE_AGENT_ACTION) {
    throw new ApiError(403, "turnstile_rejected");
  }
}
