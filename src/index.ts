// Must be the first import — auto-instrumentations-node patches http/express
// at require time, so instrumentation has to load before anything it patches.
import "./instrumentation.js";

import pino from "pino";
import webpush from "web-push";
import { loadConfig } from "./config.js";
import { SubscriptionStore } from "./push/subscription-store.js";
import { MessageStore } from "./chat/message-store.js";
import { ConversationStore } from "./chat/conversation-store.js";
import { PersonaStore } from "./chat/persona-store.js";
import { HeartbeatStore } from "./chat/heartbeat-store.js";
import { WorkflowStore } from "./chat/workflow-store.js";
import { AuditStore } from "./chat/audit-store.js";
import { AttachmentStore } from "./chat/attachment-store.js";
import { runStartupMigration } from "./migrate.js";
import { createPublicApp, createInternalApp, type InvokePayload, type ServerDeps } from "./server.js";

const logger = pino();
const config = loadConfig();
const store = new SubscriptionStore(config.dataDir);
const messages = new MessageStore(config.dataDir);
const conversations = new ConversationStore(config.dataDir);
const personas = new PersonaStore(config.dataDir);
const heartbeats = new HeartbeatStore(config.dataDir);
const workflows = new WorkflowStore(config.dataDir);
const audit = new AuditStore(config.dataDir);
const attachments = new AttachmentStore(config.dataDir);

if (config.vapidPublicKey && config.vapidPrivateKey) {
  webpush.setVapidDetails(config.vapidSubject, config.vapidPublicKey, config.vapidPrivateKey);
} else {
  logger.warn("VAPID keys not configured — /health will report not-ready");
}
if (!config.agentToken) {
  logger.warn("AGORA_AGENT_TOKEN not set — internal app is unguarded (ADR 0007)");
}
if (!config.runnerUrl) {
  logger.warn("RUNNER_URL not set — /ask and /personas/preview will return 503");
}

const invokeRunner = config.runnerUrl
  ? async (payload: InvokePayload): Promise<string> => {
      const res = await fetch(`${config.runnerUrl}/invoke`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(config.agentToken ? { "x-agora-token": config.agentToken } : {}),
        },
        body: JSON.stringify(payload),
        // Sync LLM call — generous, but bounded; a hung runner must not
        // pin request handlers forever (Decisions/0005's consequence note).
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) throw new Error(`runner /invoke returned ${res.status}`);
      const data = (await res.json()) as { reply?: string };
      if (typeof data.reply !== "string") throw new Error("runner /invoke returned no reply");
      return data.reply;
    }
  : undefined;

const deps: ServerDeps = {
  config,
  store,
  messages,
  conversations,
  personas,
  heartbeats,
  workflows,
  audit,
  attachments,
  webPush: webpush,
  logger,
  invokeRunner,
};

// Idempotent — see migrate.ts. Runs to completion before either listener
// opens so no request ever sees a half-migrated store.
await runStartupMigration({ conversations, personas, messages, logger });

const publicApp = createPublicApp(deps);
const internalApp = createInternalApp(deps);

const servers = [
  publicApp.listen(config.port, () => {
    logger.info({ port: config.port }, "agora public listener up");
  }),
  internalApp.listen(config.internalPort, () => {
    logger.info({ port: config.internalPort }, "agora internal listener up (agent surface)");
  }),
];

function shutdown(signal: string): void {
  logger.info({ signal }, "shutting down");
  for (const server of servers) server.close();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
