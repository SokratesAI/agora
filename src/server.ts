import express, { type Express } from "express";
import type pino from "pino";
import type { Config } from "./config.js";
import type { SubscriptionStore, PushSubscriptionRecord } from "./push/subscription-store.js";
import type { MessageStore } from "./chat/message-store.js";
import type { ConversationStore, ConversationUpdate } from "./chat/conversation-store.js";
import { MODEL_CATALOG } from "./models.js";
import {
  notificationsSent,
  notificationsFailed,
  repliesReceived,
  subscriptionsRegistered,
} from "./metrics.js";

const VALID_MODEL_IDS = new Set(MODEL_CATALOG.map((m) => m.id));

export interface WebPushSender {
  sendNotification(
    subscription: PushSubscriptionRecord,
    payload: string,
  ): Promise<unknown>;
}

export interface ServerDeps {
  config: Config;
  store: SubscriptionStore;
  messages: MessageStore;
  conversations: ConversationStore;
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
 * Create-or-get by name — shared by both apps. Edvard creates conversations
 * from the phone UI (public); a persona's own poll loop resolves its
 * conversation id the same way (internal). Same handler, same trust level
 * either side needs for this action — no auth model beyond network
 * boundary exists yet for either caller (see Multi-Persona-Conversations.md's
 * open questions).
 */
function registerCreateConversationRoute(app: Express, conversations: ConversationStore): void {
  app.post("/conversations", async (req, res) => {
    const { name, personality, model, thinking } = req.body as {
      name?: unknown;
      personality?: unknown;
      model?: unknown;
      thinking?: unknown;
    };
    if (typeof name !== "string" || name.length === 0) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    if (model !== undefined && !VALID_MODEL_IDS.has(model as string)) {
      res.status(400).json({ error: "unknown model" });
      return;
    }
    const existing = await conversations.findByName(name);
    if (existing) {
      res.status(200).json({ status: "exists", conversation: existing });
      return;
    }
    const conversation = await conversations.create(
      name,
      typeof personality === "string" ? personality : "",
      typeof model === "string" ? model : undefined,
      typeof thinking === "boolean" ? thinking : undefined,
    );
    res.status(201).json({ status: "created", conversation });
  });
}

/** Edit an existing conversation's settings (name/personality/model/thinking/
 * archived) later, or backfill model/thinking on a conversation created
 * before those fields existed — see conversation-store.ts's readFile()
 * defaulting. */
function registerUpdateConversationRoute(app: Express, conversations: ConversationStore): void {
  app.patch("/conversations/:id", async (req, res) => {
    const { name, personality, model, thinking, archived } = req.body as {
      name?: unknown;
      personality?: unknown;
      model?: unknown;
      thinking?: unknown;
      archived?: unknown;
    };
    if (model !== undefined && !VALID_MODEL_IDS.has(model as string)) {
      res.status(400).json({ error: "unknown model" });
      return;
    }
    const updates: ConversationUpdate = {};
    if (typeof name === "string") updates.name = name;
    if (typeof personality === "string") updates.personality = personality;
    if (typeof model === "string") updates.model = model;
    if (typeof thinking === "boolean") updates.thinking = thinking;
    if (typeof archived === "boolean") updates.archived = archived;

    const conversation = await conversations.update(req.params.id, updates);
    if (!conversation) {
      res.status(404).json({ error: "conversation not found" });
      return;
    }
    res.status(200).json({ status: "updated", conversation });
  });
}

/**
 * Public app: everything reachable from Edvard's phone via the
 * Tailscale-only Ingress (static PWA assets, health checks, subscribe,
 * reply). Deliberately does NOT include /notify — see createInternalApp.
 * No app-level auth; the Tailscale/NetworkPolicy network boundary is the
 * trust boundary, same as everywhere else on this platform.
 */
export function createPublicApp({
  config,
  store,
  messages,
  conversations,
  logger,
}: Omit<ServerDeps, "webPush">): Express {
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

  // Chat history for the frontend's bubble UI — every persona's /notify and
  // every one of Edvard's /reply calls lands in the same ordered thread.
  app.get("/messages", async (_req, res) => {
    res.status(200).json({ messages: await messages.list() });
  });

  app.post("/reply", async (req, res) => {
    const { text, model } = req.body as { text?: unknown; model?: unknown };
    if (typeof text !== "string" || text.length === 0) {
      res.status(400).json({ error: "text is required" });
      return;
    }
    if (model !== undefined && !VALID_MODEL_IDS.has(model as string)) {
      res.status(400).json({ error: "unknown model" });
      return;
    }
    const message = await messages.append("Edvard", text, typeof model === "string" ? model : undefined);
    repliesReceived.add(1);
    logger.info({ text }, "reply received");
    res.status(200).json({ status: "received", message });
  });

  // Delete/edit-and-resend for the legacy global thread (Phase 5) — mirrors
  // the per-conversation routes below so "Main" gets the same chat-UX
  // primitives as named conversations, not a second-class experience.
  app.delete("/messages/:messageId", async (req, res) => {
    const deleted = await messages.deleteMessage(req.params.messageId);
    if (!deleted) {
      res.status(404).json({ error: "message not found" });
      return;
    }
    res.status(200).json({ status: "deleted" });
  });

  app.patch("/messages/:messageId", async (req, res) => {
    const { text } = req.body as { text?: unknown };
    if (typeof text !== "string" || text.length === 0) {
      res.status(400).json({ error: "text is required" });
      return;
    }
    const message = await messages.editMessage(req.params.messageId, text);
    if (!message) {
      res.status(404).json({ error: "message not found" });
      return;
    }
    res.status(200).json({ status: "updated", message });
  });

  // Search across every named conversation plus the legacy global thread —
  // a flat GET so the frontend doesn't need to know which store a hit came
  // from ahead of time.
  app.get("/search", async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q) {
      res.status(200).json({ results: [] });
      return;
    }
    const needle = q.toLowerCase();
    const mainResults = (await messages.list())
      .filter((m) => m.text.toLowerCase().includes(needle))
      .map((message) => ({ conversationId: null, conversationName: "Main", message }));
    const conversationResults = await conversations.search(q);
    res.status(200).json({ results: [...mainResults, ...conversationResults] });
  });

  // Multi-conversation PoC (2026-07-19) — additive alongside the global
  // thread above, not a replacement. See the vault's
  // Ideas/Multi-Persona-Conversations.md for the full design; this is the
  // first slice: conversations as first-class objects a persona can be
  // driven by, proven with agora-haiku-poc before any UI is built for it.
  registerCreateConversationRoute(app, conversations);
  registerUpdateConversationRoute(app, conversations);

  // Static — doesn't depend on which provider API keys are actually
  // mounted anywhere; a persona-runner that can't reach a given provider
  // fails loudly in its own logs rather than this endpoint trying to
  // reflect live availability.
  app.get("/models", (_req, res) => {
    res.status(200).json({ models: MODEL_CATALOG });
  });

  app.get("/conversations", async (_req, res) => {
    res.status(200).json({ conversations: await conversations.list() });
  });

  // Delete a whole conversation (Phase 5 — no DELETE existed before this).
  app.delete("/conversations/:id", async (req, res) => {
    const deleted = await conversations.delete(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: "conversation not found" });
      return;
    }
    res.status(200).json({ status: "deleted" });
  });

  app.get("/conversations/:id/messages", async (req, res) => {
    const conversation = await conversations.get(req.params.id);
    if (!conversation) {
      res.status(404).json({ error: "conversation not found" });
      return;
    }
    res.status(200).json({
      id: conversation.id,
      name: conversation.name,
      personality: conversation.personality,
      model: conversation.model,
      thinking: conversation.thinking,
      archived: conversation.archived,
      messages: conversation.messages,
    });
  });

  app.post("/conversations/:id/reply", async (req, res) => {
    const { text, model } = req.body as { text?: unknown; model?: unknown };
    if (typeof text !== "string" || text.length === 0) {
      res.status(400).json({ error: "text is required" });
      return;
    }
    if (model !== undefined && !VALID_MODEL_IDS.has(model as string)) {
      res.status(400).json({ error: "unknown model" });
      return;
    }
    const message = await conversations.appendMessage(
      req.params.id,
      "Edvard",
      text,
      typeof model === "string" ? model : undefined,
    );
    if (!message) {
      res.status(404).json({ error: "conversation not found" });
      return;
    }
    res.status(200).json({ status: "received", message });
  });

  // Retract a message (delete) — regenerate reuses this on a persona's own
  // last reply, since removing it makes the conversation's last sender
  // Edvard again and the runner regenerates on its next poll.
  app.delete("/conversations/:id/messages/:messageId", async (req, res) => {
    const deleted = await conversations.deleteMessage(req.params.id, req.params.messageId);
    if (!deleted) {
      res.status(404).json({ error: "conversation or message not found" });
      return;
    }
    res.status(200).json({ status: "deleted" });
  });

  // Edit-and-resend — edits a message's text and drops everything sent
  // after it in this conversation (see conversation-store.ts's editMessage).
  app.patch("/conversations/:id/messages/:messageId", async (req, res) => {
    const { text } = req.body as { text?: unknown };
    if (typeof text !== "string" || text.length === 0) {
      res.status(400).json({ error: "text is required" });
      return;
    }
    const message = await conversations.editMessage(req.params.id, req.params.messageId, text);
    if (!message) {
      res.status(404).json({ error: "conversation or message not found" });
      return;
    }
    res.status(200).json({ status: "updated", message });
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
export function createInternalApp({
  store,
  messages,
  conversations,
  webPush,
  logger,
}: Omit<ServerDeps, "config">): Express {
  const app = express();
  app.use(express.json());

  // Also exposed on the public app (Edvard creates from the phone UI) —
  // mounted here too so a persona's own poll loop can resolve its
  // conversation id without depending on the public port being reachable
  // from inside the cluster.
  registerCreateConversationRoute(app, conversations);
  registerUpdateConversationRoute(app, conversations);

  app.post("/conversations/:id/notify", async (req, res) => {
    const { text } = req.body as { text?: unknown };
    if (typeof text !== "string" || text.length === 0) {
      res.status(400).json({ error: "text is required" });
      return;
    }
    const conversation = await conversations.get(req.params.id);
    if (!conversation) {
      res.status(404).json({ error: "conversation not found" });
      return;
    }
    const message = await conversations.appendMessage(conversation.id, conversation.name, text);

    const subscription = await store.load();
    if (!subscription) {
      res.status(404).json({ error: "no subscription registered yet", message });
      return;
    }
    try {
      // conversationId lets the service worker route a tapped notification
      // straight to this conversation instead of defaulting to Main — see
      // sw.js/app.js.
      await webPush.sendNotification(
        subscription,
        JSON.stringify({ title: conversation.name, body: text, conversationId: conversation.id }),
      );
      notificationsSent.add(1, { persona: conversation.name });
      res.status(200).json({ status: "sent", message });
    } catch (err) {
      notificationsFailed.add(1, { persona: conversation.name });
      logger.error({ err }, "push send failed");
      res.status(502).json({ error: "push send failed", message });
    }
  });

  app.post("/notify", async (req, res) => {
    const { persona, text } = req.body as { persona?: unknown; text?: unknown };
    if (typeof text !== "string" || text.length === 0) {
      res.status(400).json({ error: "text is required" });
      return;
    }
    const title = typeof persona === "string" && persona.length > 0 ? persona : "Agora";
    // Recorded in the thread regardless of push-delivery outcome below — the
    // message genuinely happened even if the phone doesn't have a
    // subscription registered yet.
    const message = await messages.append(title, text);

    const subscription = await store.load();
    if (!subscription) {
      res.status(404).json({ error: "no subscription registered yet", message });
      return;
    }
    try {
      await webPush.sendNotification(subscription, JSON.stringify({ title, body: text }));
      notificationsSent.add(1, { persona: title });
      res.status(200).json({ status: "sent", message });
    } catch (err) {
      notificationsFailed.add(1, { persona: title });
      logger.error({ err }, "push send failed");
      res.status(502).json({ error: "push send failed", message });
    }
  });

  return app;
}
