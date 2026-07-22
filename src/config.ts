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
  };
}
