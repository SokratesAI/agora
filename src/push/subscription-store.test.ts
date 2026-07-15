import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { SubscriptionStore } from "./subscription-store.js";

describe("SubscriptionStore", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns null when no subscription has been saved", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-test-"));
    const store = new SubscriptionStore(dir);
    expect(await store.load()).toBeNull();
  });

  it("round-trips a saved subscription", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-test-"));
    const store = new SubscriptionStore(dir);
    const record = {
      endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
      keys: { p256dh: "pubkey", auth: "authsecret" },
    };
    await store.save(record);
    expect(await store.load()).toEqual(record);
  });

  it("overwrites the previous subscription on save", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-test-"));
    const store = new SubscriptionStore(dir);
    await store.save({ endpoint: "https://example.com/1", keys: { p256dh: "a", auth: "b" } });
    await store.save({ endpoint: "https://example.com/2", keys: { p256dh: "c", auth: "d" } });
    const loaded = await store.load();
    expect(loaded?.endpoint).toBe("https://example.com/2");
  });

  it("creates the data directory if it doesn't exist yet", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-test-"));
    const nested = path.join(dir, "nested", "deeper");
    const store = new SubscriptionStore(nested);
    await store.save({ endpoint: "https://example.com/1", keys: { p256dh: "a", auth: "b" } });
    expect(await store.load()).not.toBeNull();
  });
});
