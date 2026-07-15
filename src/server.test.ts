import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import pino from "pino";
import type { Express } from "express";
import { createServer, type WebPushSender } from "./server.js";
import { SubscriptionStore, type PushSubscriptionRecord } from "./push/subscription-store.js";
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
    dataDir: "/tmp/unused",
    vapidPublicKey: "test-public-key",
    vapidPrivateKey: "test-private-key",
    vapidSubject: "mailto:test@example.com",
    ...overrides,
  };
}

describe("agora server", () => {
  let app: Express;
  let store: SubscriptionStore;
  let webPush: WebPushSender;
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-server-test-"));
    store = new SubscriptionStore(dir);
    webPush = { sendNotification: vi.fn().mockResolvedValue(undefined) };
    app = createServer({ config: makeConfig(), store, webPush, logger: pino({ enabled: false }) });
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
    const unconfigured = createServer({
      config: makeConfig({ vapidPublicKey: undefined, vapidPrivateKey: undefined }),
      store,
      webPush,
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

  it("POST /notify returns 404 when no subscription is registered", async () => {
    const res = await request(app).post("/notify").send({ persona: "Marcus", text: "hi" });
    expect(res.status).toBe(404);
  });

  it("POST /notify sends a push and returns 200 once subscribed", async () => {
    await store.save(validSubscription);
    const res = await request(app).post("/notify").send({ persona: "Marcus", text: "hi" });
    expect(res.status).toBe(200);
    expect(webPush.sendNotification).toHaveBeenCalledWith(
      validSubscription,
      JSON.stringify({ title: "Marcus", body: "hi" }),
    );
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

  it("POST /reply logs and returns 200", async () => {
    const res = await request(app).post("/reply").send({ text: "sounds good" });
    expect(res.status).toBe(200);
  });

  it("POST /reply rejects a missing text field", async () => {
    const res = await request(app).post("/reply").send({});
    expect(res.status).toBe(400);
  });
});
