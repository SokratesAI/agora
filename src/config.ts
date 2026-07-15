export interface Config {
  port: number;
  internalPort: number;
  dataDir: string;
  vapidPublicKey: string | undefined;
  vapidPrivateKey: string | undefined;
  vapidSubject: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT ?? 8080),
    internalPort: Number(env.INTERNAL_PORT ?? 8081),
    dataDir: env.DATA_DIR ?? "/data",
    vapidPublicKey: env.VAPID_PUBLIC_KEY,
    vapidPrivateKey: env.VAPID_PRIVATE_KEY,
    vapidSubject: env.VAPID_SUBJECT ?? "mailto:edvardgbakken@gmail.com",
  };
}
