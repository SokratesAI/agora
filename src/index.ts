// Must be the first import — auto-instrumentations-node patches http/express
// at require time, so instrumentation has to load before anything it patches.
import "./instrumentation.js";

import pino from "pino";
import webpush from "web-push";
import { loadConfig } from "./config.js";
import { SubscriptionStore } from "./push/subscription-store.js";
import { createPublicApp, createInternalApp } from "./server.js";

const logger = pino();
const config = loadConfig();
const store = new SubscriptionStore(config.dataDir);

if (config.vapidPublicKey && config.vapidPrivateKey) {
  webpush.setVapidDetails(config.vapidSubject, config.vapidPublicKey, config.vapidPrivateKey);
} else {
  logger.warn("VAPID keys not configured — /health will report not-ready");
}

const publicApp = createPublicApp({ config, store, logger });
const internalApp = createInternalApp({ store, webPush: webpush, logger });

const servers = [
  publicApp.listen(config.port, () => {
    logger.info({ port: config.port }, "agora public listener up");
  }),
  internalApp.listen(config.internalPort, () => {
    logger.info({ port: config.internalPort }, "agora internal listener up (/notify)");
  }),
];

function shutdown(signal: string): void {
  logger.info({ signal }, "shutting down");
  for (const server of servers) server.close();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
