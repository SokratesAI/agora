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
   * Defaults to 22:00–07:00 — the hours Edvard told us he sleeps
   * (2026-08-08); set QUIET_HOURS_START to an empty string to turn
   * it off entirely. */
  quietHours: QuietHours | undefined;
  /** Wall clock the window is read against — Edvard lives in Oslo. */
  quietHoursTimeZone: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT ?? 8080),
    internalPort: Number(env.INTERNAL_PORT ?? 8081),
    dataDir: env.DATA_DIR ?? "/data",
    vapidPublicKey: env.VAPID_PUBLIC_KEY,
    vapidPrivateKey: env.VAPID_PRIVATE_KEY,
    vapidSubject: env.VAPID_SUBJECT ?? "mailto:edvardgbakken@gmail.com",
    runnerUrl: env.RUNNER_URL,
    agentToken: env.AGORA_AGENT_TOKEN,
    quietHours: parseQuietHours(
      env.QUIET_HOURS_START ?? "22:00",
      env.QUIET_HOURS_END ?? "07:00",
    ),
    quietHoursTimeZone: env.QUIET_HOURS_TZ ?? "Europe/Oslo",
  };
}
