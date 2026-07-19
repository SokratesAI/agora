import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import pino from "pino";
import type { Express } from "express";
import { createPublicApp, createInternalApp, type WebPushSender } from "./server.js";
import { SubscriptionStore, type PushSubscriptionRecord } from "./push/subscription-store.js";
import { MessageStore } from "./chat/message-store.js";
import { ConversationStore } from "./chat/conversation-store.js";
import type { Config } from "./config.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const validSubscription: PushSubscriptionRecord = {
  endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
  keys: { p256dh: "pubkey", auth: "authsecret" },
};

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 8080,
    internalPort: 8081,
    dataDir: "/tmp/unused",
    vapidPublicKey: "test-public-key",
    vapidPrivateKey: "test-private-key",
    vapidSubject: "mailto:test@example.com",
    ...overrides,
  };
}

describe("agora public app", () => {
  let app: Express;
  let store: SubscriptionStore;
  let messages: MessageStore;
  let conversations: ConversationStore;
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-server-test-"));
    store = new SubscriptionStore(dir);
    messages = new MessageStore(dir);
    conversations = new ConversationStore(dir);
    app = createPublicApp({
      config: makeConfig(),
      store,
      messages,
      conversations,
      logger: pino({ enabled: false }),
    });
  });

  it("GET /healthz always returns 200", async () => {
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
  });

  it("GET /health returns 200 when VAPID is configured", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
  });

  it("GET /health returns 503 when VAPID is not configured", async () => {
    const unconfigured = createPublicApp({
      config: makeConfig({ vapidPublicKey: undefined, vapidPrivateKey: undefined }),
      store,
      messages,
      conversations,
      logger: pino({ enabled: false }),
    });
    const res = await request(unconfigured).get("/health");
    expect(res.status).toBe(503);
  });

  it("GET /vapid-public-key returns the configured public key", async () => {
    const res = await request(app).get("/vapid-public-key");
    expect(res.status).toBe(200);
    expect(res.body.publicKey).toBe("test-public-key");
  });

  it("POST /subscribe rejects an invalid body", async () => {
    const res = await request(app).post("/subscribe").send({ nope: true });
    expect(res.status).toBe(400);
  });

  it("POST /subscribe stores a valid subscription", async () => {
    const res = await request(app).post("/subscribe").send(validSubscription);
    expect(res.status).toBe(201);
    expect(await store.load()).toEqual(validSubscription);
  });

  it("POST /reply logs, stores, and returns 200", async () => {
    const res = await request(app).post("/reply").send({ text: "sounds good" });
    expect(res.status).toBe(200);
    expect(res.body.message).toMatchObject({ sender: "Edvard", text: "sounds good" });
    expect(await messages.list()).toMatchObject([{ sender: "Edvard", text: "sounds good" }]);
  });

  it("POST /reply rejects a missing text field", async () => {
    const res = await request(app).post("/reply").send({});
    expect(res.status).toBe(400);
  });

  it("GET /messages returns an empty list before anything is sent", async () => {
    const res = await request(app).get("/messages");
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
  });

  it("GET /messages returns stored messages in order", async () => {
    await request(app).post("/reply").send({ text: "first" });
    await request(app).post("/reply").send({ text: "second" });
    const res = await request(app).get("/messages");
    expect(res.body.messages.map((m: { text: string }) => m.text)).toEqual(["first", "second"]);
  });

  it("does not mount /notify at all — that's the internal app's job", async () => {
    const res = await request(app).post("/notify").send({ text: "hi" });
    expect(res.status).toBe(404);
  });

  it("GET /conversations returns an empty list before any conversation exists", async () => {
    const res = await request(app).get("/conversations");
    expect(res.status).toBe(200);
    expect(res.body.conversations).toEqual([]);
  });

  it("GET /conversations lists summaries without messages", async () => {
    await conversations.create("Haiku", "a helpful persona");
    const res = await request(app).get("/conversations");
    expect(res.body.conversations).toMatchObject([{ name: "Haiku", personality: "a helpful persona" }]);
    expect(res.body.conversations[0].messages).toBeUndefined();
  });

  it("GET /conversations/:id/messages 404s for an unknown id", async () => {
    const res = await request(app).get("/conversations/nope/messages");
    expect(res.status).toBe(404);
  });

  it("GET /conversations/:id/messages returns the personality and thread", async () => {
    const conversation = await conversations.create("Haiku", "a helpful persona");
    await conversations.appendMessage(conversation.id, "Edvard", "hi");
    const res = await request(app).get(`/conversations/${conversation.id}/messages`);
    expect(res.status).toBe(200);
    expect(res.body.personality).toBe("a helpful persona");
    expect(res.body.messages).toMatchObject([{ sender: "Edvard", text: "hi" }]);
  });

  it("POST /conversations/:id/reply appends as Edvard", async () => {
    const conversation = await conversations.create("Haiku", "a helpful persona");
    const res = await request(app)
      .post(`/conversations/${conversation.id}/reply`)
      .send({ text: "hello" });
    expect(res.status).toBe(200);
    expect(res.body.message).toMatchObject({ sender: "Edvard", text: "hello" });
  });

  it("POST /conversations/:id/reply 404s for an unknown id", async () => {
    const res = await request(app).post("/conversations/nope/reply").send({ text: "hi" });
    expect(res.status).toBe(404);
  });

  it("POST /conversations/:id/reply rejects a missing text field", async () => {
    const conversation = await conversations.create("Haiku", "a helpful persona");
    const res = await request(app).post(`/conversations/${conversation.id}/reply`).send({});
    expect(res.status).toBe(400);
  });

  it("POST /conversations creates a new conversation (Edvard creating from the phone UI)", async () => {
    const res = await request(app)
      .post("/conversations")
      .send({ name: "Haiku", personality: "a helpful persona" });
    expect(res.status).toBe(201);
    expect(res.body.conversation).toMatchObject({ name: "Haiku", personality: "a helpful persona" });
  });

  it("POST /conversations returns the existing conversation on a repeat name", async () => {
    const first = await request(app)
      .post("/conversations")
      .send({ name: "Haiku", personality: "a helpful persona" });
    const second = await request(app).post("/conversations").send({ name: "Haiku" });
    expect(second.status).toBe(200);
    expect(second.body.conversation.id).toBe(first.body.conversation.id);
  });

  it("POST /conversations rejects a missing name", async () => {
    const res = await request(app).post("/conversations").send({});
    expect(res.status).toBe(400);
  });
});

describe("agora internal app", () => {
  let app: Express;
  let store: SubscriptionStore;
  let messages: MessageStore;
  let conversations: ConversationStore;
  let webPush: WebPushSender;
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-internal-test-"));
    store = new SubscriptionStore(dir);
    messages = new MessageStore(dir);
    conversations = new ConversationStore(dir);
    webPush = { sendNotification: vi.fn().mockResolvedValue(undefined) };
    app = createInternalApp({ store, messages, conversations, webPush, logger: pino({ enabled: false }) });
  });

  it("POST /notify returns 404 when no subscription is registered, but still records the message", async () => {
    const res = await request(app).post("/notify").send({ persona: "Marcus", text: "hi" });
    expect(res.status).toBe(404);
    expect(await messages.list()).toMatchObject([{ sender: "Marcus", text: "hi" }]);
  });

  it("POST /notify sends a push, stores the message, and returns 200 once subscribed", async () => {
    await store.save(validSubscription);
    const res = await request(app).post("/notify").send({ persona: "Marcus", text: "hi" });
    expect(res.status).toBe(200);
    expect(webPush.sendNotification).toHaveBeenCalledWith(
      validSubscription,
      JSON.stringify({ title: "Marcus", body: "hi" }),
    );
    expect(await messages.list()).toMatchObject([{ sender: "Marcus", text: "hi" }]);
  });

  it("POST /notify returns 502 when the push send fails", async () => {
    await store.save(validSubscription);
    (webPush.sendNotification as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));
    const res = await request(app).post("/notify").send({ persona: "Marcus", text: "hi" });
    expect(res.status).toBe(502);
  });

  it("POST /notify rejects a missing text field", async () => {
    const res = await request(app).post("/notify").send({ persona: "Marcus" });
    expect(res.status).toBe(400);
  });

  it("does not mount public routes at all", async () => {
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(404);
  });

  it("POST /conversations creates a new conversation", async () => {
    const res = await request(app)
      .post("/conversations")
      .send({ name: "Haiku", personality: "a helpful persona" });
    expect(res.status).toBe(201);
    expect(res.body.conversation).toMatchObject({ name: "Haiku", personality: "a helpful persona" });
  });

  it("POST /conversations returns the existing conversation on a repeat name", async () => {
    const first = await request(app)
      .post("/conversations")
      .send({ name: "Haiku", personality: "a helpful persona" });
    const second = await request(app)
      .post("/conversations")
      .send({ name: "Haiku", personality: "ignored, already exists" });
    expect(second.status).toBe(200);
    expect(second.body.conversation.id).toBe(first.body.conversation.id);
    expect(second.body.conversation.personality).toBe("a helpful persona");
  });

  it("POST /conversations rejects a missing name", async () => {
    const res = await request(app).post("/conversations").send({});
    expect(res.status).toBe(400);
  });

  it("POST /conversations/:id/notify sends a push, stores the message, and returns 200 once subscribed", async () => {
    await store.save(validSubscription);
    const created = await request(app)
      .post("/conversations")
      .send({ name: "Haiku", personality: "a helpful persona" });
    const res = await request(app)
      .post(`/conversations/${created.body.conversation.id}/notify`)
      .send({ text: "hi" });
    expect(res.status).toBe(200);
    expect(webPush.sendNotification).toHaveBeenCalledWith(
      validSubscription,
      JSON.stringify({ title: "Haiku", body: "hi" }),
    );
    expect(res.body.message).toMatchObject({ sender: "Haiku", text: "hi" });
  });

  it("POST /conversations/:id/notify 404s for an unknown id", async () => {
    const res = await request(app).post("/conversations/nope/notify").send({ text: "hi" });
    expect(res.status).toBe(404);
  });

  it("POST /conversations/:id/notify rejects a missing text field", async () => {
    const created = await request(app).post("/conversations").send({ name: "Haiku" });
    const res = await request(app)
      .post(`/conversations/${created.body.conversation.id}/notify`)
      .send({});
    expect(res.status).toBe(400);
  });
});
