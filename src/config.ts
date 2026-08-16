import { parseQuietHours, type QuietHours } from "./push/quiet-hours.js";

export interface Config {
  port: number;
  internalPort: number;
  dataDir: string;
  vapidPublicKey: string | undefined;
  vapidPrivateKey: string | undefined;
  vapidSubject: string;
  /** Base URL of agora-persona-runner's sync /invoke server (Decisions/0005).
   * Unset → /ask and /personas/preview return 503 rather than hanging. */
  runnerUrl: string | undefined;
  /** Shared agent token (ADR 0007). Unset → internal app stays open (logged
   * as a warning at startup) so a missing secret can't wedge a deploy. */
  agentToken: string | undefined;
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
    dataDir: env.DATA_DIR ?? "/data",
    vapidPublicKey: env.VAPID_PUBLIC_KEY,
    vapidPrivateKey: env.VAPID_PRIVATE_KEY,
    vapidSubject: env.VAPID_SUBJECT ?? DEFAULT_VAPID_SUBJECT,
    runnerUrl: env.RUNNER_URL,
    agentToken: env.AGORA_AGENT_TOKEN,
    quietHours: parseQuietHours(
      env.QUIET_HOURS_START ?? "22:00",
      env.QUIET_HOURS_END ?? "07:00",
    ),
    quietHoursTimeZone: env.QUIET_HOURS_TZ ?? "Europe/Oslo",
  };
}
