import { CREATE_AGENT_ACTION, DEVELOPMENT_CHALLENGE_PATH } from "../shared/turnstile";
import { LocalizedError } from "../i18n/index";

interface Turnstile {
  render(container: HTMLElement, options: {
    sitekey: string;
    action: string;
    execution: "execute";
    retry: "auto";
    "retry-interval": number;
    "response-field": false;
    callback: (token: string) => void;
    "error-callback": (code?: string) => boolean;
    "expired-callback": () => void;
    "timeout-callback": () => void;
    "unsupported-callback": () => void;
  }): string;
  execute(widgetId: string): void;
  remove(widgetId: string): void;
}

type TurnstileWindow = Window & {
  turnstile?: Turnstile;
  __regidiTurnstileReady?: () => void;
};

const sitekey = import.meta.env.PUBLIC_TURNSTILE_SITE_KEY;
const unavailable = (code?: string) => new LocalizedError("error.turnstileVerify", code);
const expired = () => new LocalizedError("error.turnstileExpired");
const scriptUnavailable = () => new LocalizedError("error.turnstileLoad");
let loading: Promise<Turnstile> | undefined;

function preloadTurnstile(): Promise<Turnstile> {
  const browser = window as TurnstileWindow;
  if (browser.turnstile) return Promise.resolve(browser.turnstile);
  if (loading) return loading;

  loading = new Promise<Turnstile>((resolve, reject) => {
    const script = document.createElement("script");
    let settled = false;
    const timer = window.setTimeout(() => fail(), 15_000);

    const cleanup = () => {
      window.clearTimeout(timer);
      delete browser.__regidiTurnstileReady;
    };
    const succeed = () => {
      if (settled || !browser.turnstile) return;
      settled = true;
      cleanup();
      resolve(browser.turnstile);
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      script.remove();
      loading = undefined;
      reject(scriptUnavailable());
    };

    browser.__regidiTurnstileReady = succeed;
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=__regidiTurnstileReady";
    script.async = true;
    script.onerror = fail;
    script.onload = succeed;
    document.head.append(script);
  });

  return loading;
}

async function executeAgentChallenge(container: HTMLElement): Promise<string> {
  if (["127.0.0.1", "localhost"].includes(window.location.hostname)) {
    const response = await fetch(DEVELOPMENT_CHALLENGE_PATH, {
      cache: "no-store", signal: AbortSignal.timeout(8_000),
    }).catch(() => { throw unavailable(); });
    if (response.ok) {
      const data: { token?: string } = await response.json().catch(() => ({}));
      if (typeof data.token === "string") return data.token;
      throw unavailable();
    }
    if (response.status !== 404) throw unavailable();
  }
  if (!sitekey) throw unavailable();
  const turnstile = await preloadTurnstile();
  let widgetId: string | undefined;
  let timer: number | undefined;
  let lastErrorCode: string | undefined;

  try {
    return await new Promise<string>((resolve, reject) => {
      const expire = () => reject(expired());
      timer = window.setTimeout(() => reject(unavailable(lastErrorCode)), 40_000);

      try {
        widgetId = turnstile.render(container, {
          sitekey,
          action: CREATE_AGENT_ACTION,
          execution: "execute",
          retry: "auto",
          "retry-interval": 3000,
          "response-field": false,
          callback: resolve,
          "error-callback": (code) => {
            // Codes identify a challenge failure, never the visitor or their token.
            lastErrorCode = typeof code === "string" && /^[0-9]{5,6}$/.test(code) ? code : undefined;
            const nonRetryable = ["110100", "110110", "110200", "400020", "400021"];
            if (lastErrorCode && nonRetryable.includes(lastErrorCode)) {
              reject(unavailable(lastErrorCode));
              return true;
            }
            return false; // Let Turnstile retry transient failures.
          },
          "expired-callback": expire,
          "timeout-callback": expire,
          "unsupported-callback": () => reject(new LocalizedError("error.turnstileUnsupported")),
        });
        turnstile.execute(widgetId);
      } catch {
        reject(unavailable(lastErrorCode));
      }
    });
  } finally {
    window.clearTimeout(timer);
    if (widgetId !== undefined) {
      try { turnstile.remove(widgetId); } catch { /* Already removed by Turnstile. */ }
    }
  }
}

/**
 * Run the invisible challenge while the visitor explores the lab.
 * Turnstile tokens are valid for 300 seconds and must be verified once, server-side.
 * A 240-second maximum age leaves a margin for network/verification latency.
 */
const PREPARED_MAX_AGE_MS = 240_000;
function maxChallengeAge() {
  return ["127.0.0.1", "localhost"].includes(window.location.hostname) ? 45_000 : PREPARED_MAX_AGE_MS;
}
type PreparedChallenge = {
  container: HTMLElement;
  startedAt: number;
  promise: Promise<string>;
};
let preparedChallenge: PreparedChallenge | undefined;

export function prepareAgentChallenge(container: HTMLElement): void {
  if (preparedChallenge?.container === container &&
      Date.now() - preparedChallenge.startedAt < maxChallengeAge()) return;

  const challenge: PreparedChallenge = {
    container,
    startedAt: Date.now(),
    promise: executeAgentChallenge(container),
  };
  preparedChallenge = challenge;
  // Background challenges may fail (e.g. blocked scripts). Retry on user action.
  void challenge.promise.catch(() => {
    if (preparedChallenge === challenge) preparedChallenge = undefined;
  });
}

export function getAgentChallenge(container: HTMLElement): Promise<string> {
  const ready = preparedChallenge;
  preparedChallenge = undefined; // Consume once; never reuse a Turnstile token.
  if (ready?.container === container &&
      Date.now() - ready.startedAt < maxChallengeAge()) {
    return ready.promise;
  }
  return executeAgentChallenge(container);
}
