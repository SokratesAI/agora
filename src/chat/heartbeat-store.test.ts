import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { HeartbeatStore, SCHEDULE_RE, isValidSchedule } from "./heartbeat-store.js";

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
    for (const ok of [
      "daily@08:00", "daily@23:59", "daily@7:05", "every@30m", "every@2h",
      "every@6h@12:00", "every@30m@00:00",
    ]) {
      expect(ok).toMatch(SCHEDULE_RE);
    }
    for (const bad of [
      "daily@24:00", "daily@8", "every@m", "every@30", "cron:* * * * *", "",
      "every@6h@24:00", "every@6h@12", "daily@08:00@12:00", "every@6h@12:00@13:00",
    ]) {
      expect(bad).not.toMatch(SCHEDULE_RE);
    }
  });

  it("isValidSchedule only anchors intervals that divide 24h evenly", () => {
    // An anchor promises the same clock times every day. 7h can't keep that
    // promise -- the runner lays slots out from midnight, so a non-dividing
    // interval leaves a short wrap gap and fires an extra time at midnight.
    for (const ok of ["every@6h@12:00", "every@1h@00:00", "every@12h@06:00", "every@90m@00:00"]) {
      expect(isValidSchedule(ok)).toBe(true);
    }
    for (const bad of ["every@7h@12:00", "every@5h@12:00", "every@25m@12:00", "every@36h@12:00"]) {
      expect(isValidSchedule(bad)).toBe(false);
    }
  });

  it("isValidSchedule leaves unanchored and daily schedules alone", () => {
    for (const ok of ["daily@08:00", "every@7h", "every@25m", "every@6h"]) {
      expect(isValidSchedule(ok)).toBe(true);
    }
    expect(isValidSchedule("nonsense")).toBe(false);
  });

  // cron@ -- Edvard's issues.md #37, second half. The three things an
  // anchored interval cannot say are weekdays only, twice a day, and a
  // daytime-only window; all three are one cron expression.
  it("isValidSchedule accepts the cron forms the picker generates", () => {
    for (const ok of [
      "cron@0 8 * * 1-5",        // weekdays at 08:00
      "cron@0 8,20 * * *",       // twice a day
      "cron@0 8-22/2 * * *",     // every 2h through the day, none at night
      "cron@*/15 * * * *",       // every quarter hour
      "cron@0 0 1 * *",          // the 1st of the month
      "cron@30 6 * * 0",         // Sundays -- 0 is Sunday
      "cron@30 6 * * 7",         // and so is 7
      "cron@0 8 * 1-6 1,3,5",
    ]) {
      expect(isValidSchedule(ok)).toBe(true);
    }
  });

  it("isValidSchedule rejects cron the runner could not evaluate", () => {
    for (const bad of [
      "cron@0 8 * *",            // four fields
      "cron@0 8 * * * *",        // six
      "cron@60 8 * * *",         // minute out of range
      "cron@0 24 * * *",         // hour out of range
      "cron@0 8 0 * *",          // day-of-month is 1-based
      "cron@0 8 * * 8",          // day-of-week tops out at 7
      "cron@0 8-2 * * *",        // backwards range
      "cron@0 */0 * * *",        // step of zero
      "cron@0 5/15 * * *",       // a step needs a range to walk
      "cron@0 eight * * *",
      "cron@",
      "cron@     ",
    ]) {
      expect(isValidSchedule(bad)).toBe(false);
    }
  });
});
