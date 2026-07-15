import express, { type Express } from "express";
import type pino from "pino";
import type { Config } from "./config.js";
import type { SubscriptionStore, PushSubscriptionRecord } from "./push/subscription-store.js";
import {
  notificationsSent,
  notificationsFailed,
  repliesReceived,
  subscriptionsRegistered,
} from "./metrics.js";

export interface WebPushSender {
  sendNotification(
    subscription: PushSubscriptionRecord,
    payload: string,
  ): Promise<unknown>;
}

export interface ServerDeps {
  config: Config;
  store: SubscriptionStore;
  webPush: WebPushSender;
  logger: pino.Logger;
}

function isValidSubscription(body: unknown): body is PushSubscriptionRecord {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  if (typeof b.endpoint !== "string" || b.endpoint.length === 0) return false;
  if (typeof b.keys !== "object" || b.keys === null) return false;
  const keys = b.keys as Record<string, unknown>;
  return typeof keys.p256dh === "string" && typeof keys.auth === "string";
}

/**
 * Public app: everything reachable from Edvard's phone via the
 * Tailscale-only Ingress (static PWA assets, health checks, subscribe,
 * reply). Deliberately does NOT include /notify — see createInternalApp.
 * No app-level auth; the Tailscale/NetworkPolicy network boundary is the
 * trust boundary, same as everywhere else on this platform.
 */
export function createPublicApp({ config, store, logger }: Omit<ServerDeps, "webPush">): Express {
  const app = express();
  app.use(express.json());
  app.use(express.static("public"));

  // Process-alive only — deliberately does not depend on VAPID config or
  // subscription state, same "readinessProbe must not depend on external
  // pairing state" lesson WhatsApp Bridge learned the hard way.
  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.get("/health", (_req, res) => {
    const ready = Boolean(config.vapidPublicKey && config.vapidPrivateKey);
    res.status(ready ? 200 : 503).json({ status: ready ? "ok" : "not configured" });
  });

  app.get("/vapid-public-key", (_req, res) => {
    if (!config.vapidPublicKey) {
      res.status(503).json({ error: "VAPID not configured" });
      return;
    }
    res.status(200).json({ publicKey: config.vapidPublicKey });
  });

  app.post("/subscribe", async (req, res) => {
    if (!isValidSubscription(req.body)) {
      res.status(400).json({ error: "invalid subscription" });
      return;
    }
    await store.save(req.body);
    subscriptionsRegistered.add(1);
    logger.info({ endpoint: req.body.endpoint }, "subscription registered");
    res.status(201).json({ status: "subscribed" });
  });

  // v1 scope: logged only, not routed anywhere — same "prove the round
  // trip before building routing" precedent WhatsApp Bridge's inbound
  // handling set.
  app.post("/reply", (req, res) => {
    const { text } = req.body as { text?: unknown };
    if (typeof text !== "string" || text.length === 0) {
      res.status(400).json({ error: "text is required" });
      return;
    }
    repliesReceived.add(1);
    logger.info({ text }, "reply received");
    res.status(200).json({ status: "received" });
  });

  return app;
}

/**
 * Internal app: /notify only, on its own port, with no route mounted on
 * the public app's port at all — the split is what actually enforces
 * "cluster-internal only," not just an Ingress path that happens not to
 * route here. NetworkPolicy allows this port only from agents/infra pods,
 * never from the tailscale namespace. Mirrors whatsapp-bridge's /send
 * staying unreachable from outside the cluster.
 */
export function createInternalApp({ store, webPush, logger }: Omit<ServerDeps, "config">): Express {
  const app = express();
  app.use(express.json());

  app.post("/notify", async (req, res) => {
    const { persona, text } = req.body as { persona?: unknown; text?: unknown };
    if (typeof text !== "string" || text.length === 0) {
      res.status(400).json({ error: "text is required" });
      return;
    }
    const subscription = await store.load();
    if (!subscription) {
      res.status(404).json({ error: "no subscription registered yet" });
      return;
    }
    const title = typeof persona === "string" && persona.length > 0 ? persona : "Agora";
    try {
      await webPush.sendNotification(subscription, JSON.stringify({ title, body: text }));
      notificationsSent.add(1, { persona: title });
      res.status(200).json({ status: "sent" });
    } catch (err) {
      notificationsFailed.add(1, { persona: title });
      logger.error({ err }, "push send failed");
      res.status(502).json({ error: "push send failed" });
    }
  });

  return app;
}
