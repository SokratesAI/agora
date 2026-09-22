import { parseQuietHours, type QuietHours } from "./push/quiet-hours.js";

export interface Config {
  port: number;
  internalPort: number;
  /** Second listener for the same public app, meant to be reachable only from
   * the Tailscale proxy (a NetworkPolicy names this port for the tailscale
   * namespace and nothing else). Issue #287: once his browser reaches Agora
   * through this port, :8080 can refuse a request with no agent token without
   * locking him out. 0 turns the listener off. */
  tailnetPort: number;
  dataDir: string;
  vapidPublicKey: string | undefined;
  vapidPrivateKey: string | undefined;
  vapidSubject: string;
  /** Base URL of agora-persona-runner's sync /invoke server (Decisions/0005).
   * Unset → /ask returns 503 rather than hanging. */
  runnerUrl: string | undefined;
  /** Shared agent token (ADR 0007). Unset → internal app stays open (logged
   * as a warning at startup) so a missing secret can't wedge a deploy. */
  agentToken: string | undefined;
  /** Per-app tokens (issue #286), token -> the one app name that token may
   * speak as. An app token reaches only the routes an app needs and cannot
   * choose its own sender. Read from AGORA_APP_TOKENS, a JSON object of
   * `{"<app name>": "<token>"}`; unset or empty means no app tokens. */
  appTokens: Map<string, string>;
  /** Window in which a notification is recorded but not pushed to the phone.
   * Defaults to the configured overnight hours; set QUIET_HOURS_START to an
   * empty string to turn it off entirely. */
  quietHours: QuietHours | undefined;
  /** Wall clock the window is read against. */
  quietHoursTimeZone: string;
}

/** Contact address the push service is given for this deployment.
 * This repo is public, so the fallback must not be anyone's personal
 * mailbox — it used to be Edvard's, which meant his private address was
 * readable by anyone and permanently in the git history. The project
 * account is already visible in every commit's metadata, so exposing it
 * here costs nothing. Set VAPID_SUBJECT to override per deployment. */
export const DEFAULT_VAPID_SUBJECT = "mailto:sokratesai.mail@gmail.com";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT ?? 8080),
    internalPort: Number(env.INTERNAL_PORT ?? 8081),
    tailnetPort: Number(env.TAILNET_PORT ?? 8085),
    dataDir: env.DATA_DIR ?? "/data",
    vapidPublicKey: env.VAPID_PUBLIC_KEY,
    vapidPrivateKey: env.VAPID_PRIVATE_KEY,
    vapidSubject: env.VAPID_SUBJECT ?? DEFAULT_VAPID_SUBJECT,
    runnerUrl: env.RUNNER_URL,
    agentToken: env.AGORA_AGENT_TOKEN,
    appTokens: parseAppTokens(env.AGORA_APP_TOKENS),
    quietHours: parseQuietHours(
      env.QUIET_HOURS_START ?? "22:00",
      env.QUIET_HOURS_END ?? "07:00",
    ),
    quietHoursTimeZone: env.QUIET_HOURS_TZ ?? "Europe/Oslo",
  };
}

/** Parse AGORA_APP_TOKENS (`{"Lyceum": "<token>"}`) into token -> app name.
 * Refuses a malformed value, an empty name or token, and a token equal to
 * another app's, rather than starting with a guard that half-works. */
export function parseAppTokens(raw: string | undefined): Map<string, string> {
  const tokens = new Map<string, string>();
  if (raw === undefined || raw.trim() === "") return tokens;
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("AGORA_APP_TOKENS must be a JSON object of app name -> token");
  }
  for (const [app, token] of Object.entries(parsed)) {
    if (app === "" || typeof token !== "string" || token === "") {
      throw new Error(`AGORA_APP_TOKENS: app "${app}" needs a non-empty token`);
    }
    if (tokens.has(token)) {
      throw new Error(`AGORA_APP_TOKENS: "${app}" shares a token with "${tokens.get(token)}"`);
    }
    tokens.set(token, app);
  }
  return tokens;
}
