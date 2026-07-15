// Must be the first import — auto-instrumentations-node patches http/express
// at require time, so instrumentation has to load before anything it patches.
import "./instrumentation.js";

import pino from "pino";
import webpush from "web-push";
import { loadConfig } from "./config.js";
import { SubscriptionStore } from "./push/subscription-store.js";
import { createServer } from "./server.js";

const logger = pino();
const config = loadConfig();
const store = new SubscriptionStore(config.dataDir);

if (config.vapidPublicKey && config.vapidPrivateKey) {
  webpush.setVapidDetails(config.vapidSubject, config.vapidPublicKey, config.vapidPrivateKey);
} else {
  logger.warn("VAPID keys not configured — /health will report not-ready");
}

const app = createServer({ config, store, webPush: webpush, logger });

app.listen(config.port, () => {
  logger.info({ port: config.port }, "agora listening");
});

function shutdown(signal: string): void {
  logger.info({ signal }, "shutting down");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
