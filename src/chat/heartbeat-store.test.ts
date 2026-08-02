import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { HeartbeatStore, SCHEDULE_RE } from "./heartbeat-store.js";

describe("HeartbeatStore", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  async function makeStore() {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-heartbeats-test-"));
    return new HeartbeatStore(dir);
  }

  it("creates with sane defaults", async () => {
    const store = await makeStore();
    const heartbeat = await store.create({
      name: "Morning Marcus",
      personaId: "p1",
      conversationId: "c1",
      schedule: "daily@08:00",
    });
    expect(heartbeat.enabled).toBe(true);
    expect(heartbeat.forceRun).toBe(false);
    expect(heartbeat.lastRunAt).toBeNull();
    expect(heartbeat.vaultPaths).toEqual([]);
    expect(heartbeat.task).toBe("");
  });

  it("updates run bookkeeping fields", async () => {
    const store = await makeStore();
    const heartbeat = await store.create({
      name: "hb",
      personaId: "p1",
      conversationId: "c1",
      schedule: "every@30m",
    });
    await store.update(heartbeat.id, {
      forceRun: true,
      lastRunAt: "2026-07-22T08:00:00.000Z",
      lastResult: "replied 120 chars",
    });
    const reloaded = await store.get(heartbeat.id);
    expect(reloaded?.forceRun).toBe(true);
    expect(reloaded?.lastRunAt).toBe("2026-07-22T08:00:00.000Z");
    expect(reloaded?.lastResult).toBe("replied 120 chars");
  });

  it("deletes and reports missing", async () => {
    const store = await makeStore();
    const heartbeat = await store.create({
      name: "hb",
      personaId: "p1",
      conversationId: "c1",
      schedule: "every@1h",
    });
    expect(await store.delete(heartbeat.id)).toBe(true);
    expect(await store.delete(heartbeat.id)).toBe(false);
  });

  it("omits rotateConversationEachRun/conversationRetention by default and persists them when set", async () => {
    const store = await makeStore();
    const heartbeat = await store.create({
      name: "hb", personaId: "p1", conversationId: "c1", schedule: "every@6h",
    });
    expect(heartbeat.rotateConversationEachRun).toBeUndefined();
    expect(heartbeat.conversationRetention).toBeUndefined();

    const created = await store.create({
      name: "hb2", personaId: "p1", conversationId: "c1", schedule: "every@6h",
      rotateConversationEachRun: true, conversationRetention: 3,
    });
    expect(created.rotateConversationEachRun).toBe(true);
    expect(created.conversationRetention).toBe(3);

    await store.update(heartbeat.id, { rotateConversationEachRun: true, conversationRetention: 4 });
    const reloaded = await store.get(heartbeat.id);
    expect(reloaded?.rotateConversationEachRun).toBe(true);
    expect(reloaded?.conversationRetention).toBe(4);
  });

  it("update can rotate a heartbeat's conversationId", async () => {
    const store = await makeStore();
    const heartbeat = await store.create({
      name: "hb", personaId: "p1", conversationId: "c1", schedule: "every@6h",
    });
    const updated = await store.update(heartbeat.id, { conversationId: "c2" });
    expect(updated?.conversationId).toBe("c2");
  });

  it("SCHEDULE_RE accepts the documented forms and rejects junk", () => {
    for (const ok of ["daily@08:00", "daily@23:59", "daily@7:05", "every@30m", "every@2h"]) {
      expect(ok).toMatch(SCHEDULE_RE);
    }
    for (const bad of ["daily@24:00", "daily@8", "every@m", "every@30", "cron:* * * * *", ""]) {
      expect(bad).not.toMatch(SCHEDULE_RE);
    }
  });
});
