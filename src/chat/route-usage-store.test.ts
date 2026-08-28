import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RouteUsageStore } from "./route-usage-store.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "route-usage-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** A flush interval long enough that the timer never fires during a test —
 * every test that wants a file on disk calls flush() itself, which cancels the
 * timer. A 0ms interval here left a write racing afterEach's rm and failed
 * three unrelated tests with ENOENT. */
function store(): RouteUsageStore {
  return new RouteUsageStore(dir, 60_000);
}

describe("RouteUsageStore", () => {
  it("counts by route template, not by URL", async () => {
    const s = store();
    await s.load();
    s.record("GET", "/conversations/:id", "/conversations/abc", "curl/8", 200);
    s.record("GET", "/conversations/:id", "/conversations/def", "curl/8", 200);

    const snap = s.snapshot();
    expect(snap.entries).toHaveLength(1);
    expect(snap.entries[0].key).toBe("GET /conversations/:id");
    expect(snap.entries[0].count).toBe(2);
    // The ids must not be retained — that is the whole reason the template is
    // recorded rather than req.path.
    expect(JSON.stringify(snap)).not.toContain("abc");
  });

  it("records an unmatched request under its raw path and marks it", async () => {
    const s = store();
    await s.load();
    s.record("GET", undefined, "/app.js", "Mozilla/5.0", 200);

    const [entry] = s.snapshot().entries;
    expect(entry.key).toBe("GET /app.js");
    expect(entry.unmatched).toBe(true);
    expect(entry.statuses).toEqual({ "200": 1 });
  });

  it("keeps user-agents apart so a browser is distinguishable from the runner", async () => {
    const s = store();
    await s.load();
    s.record("GET", "/conversations", "/conversations", "Mozilla/5.0 (Linux; Android 10)", 200);
    s.record("GET", "/conversations", "/conversations", "Python-urllib/3.11", 200);
    s.record("GET", "/conversations", "/conversations", undefined, 200);

    const [entry] = s.snapshot().entries;
    expect(entry.agents["Mozilla/5.0 (Linux; Android 10)"]).toBe(1);
    expect(entry.agents["Python-urllib/3.11"]).toBe(1);
    expect(entry.agents["(none)"]).toBe(1);
  });

  it("survives a restart by merging what the previous pod wrote", async () => {
    const first = store();
    await first.load();
    first.record("GET", "/healthz", "/healthz", "kube-probe/1.33", 200);
    await first.flush();

    const second = store();
    await second.load();
    second.record("GET", "/healthz", "/healthz", "kube-probe/1.33", 200);

    const [entry] = second.snapshot().entries;
    expect(entry.count).toBe(2);
    expect(entry.firstSeen).toBe(first.snapshot().entries[0].firstSeen);
  });

  it("never writes over a file it has not read", async () => {
    const seeded = store();
    await seeded.load();
    seeded.record("GET", "/healthz", "/healthz", "kube-probe/1.33", 200);
    await seeded.flush();
    const before = await fs.readFile(path.join(dir, "route-usage.json"), "utf8");

    // A store that skipped load() — the shape a wiring mistake takes — must
    // not blank the week's counts.
    const unloaded = store();
    unloaded.record("GET", "/healthz", "/healthz", "kube-probe/1.33", 200);
    await unloaded.flush();

    expect(await fs.readFile(path.join(dir, "route-usage.json"), "utf8")).toBe(before);
  });

  it("folds keys past the cap into (overflow) rather than dropping them", async () => {
    const s = store();
    await s.load();
    for (let i = 0; i < 405; i += 1) s.record("GET", undefined, `/junk-${i}`, "scanner", 404);

    const snap = s.snapshot();
    // 400 named keys plus the one (overflow) bucket — bounded, which is the
    // point; the bucket is the 401st entry rather than displacing a name.
    expect(snap.entries).toHaveLength(401);
    const overflow = snap.entries.find((e) => e.key === "(overflow)");
    expect(overflow?.count).toBe(5);
    expect(snap.overflowKeys).toContain("GET /junk-404");
    const total = snap.entries.reduce((sum, e) => sum + e.count, 0);
    expect(total).toBe(405); // nothing is lost, only named
  });

  it("folds user-agents past the cap into (other)", async () => {
    const s = store();
    await s.load();
    for (let i = 0; i < 20; i += 1) s.record("GET", "/healthz", "/healthz", `agent-${i}`, 200);

    const [entry] = s.snapshot().entries;
    // 12 named agents plus the (other) bucket.
    expect(Object.keys(entry.agents)).toHaveLength(13);
    expect(entry.agents["(other)"]).toBe(8);
    const total = Object.values(entry.agents).reduce((a, b) => a + b, 0);
    expect(total).toBe(20);
  });

  it("truncates a user-agent long enough to be an attack on the file size", async () => {
    const s = store();
    await s.load();
    s.record("GET", "/healthz", "/healthz", "x".repeat(5000), 200);

    const [key] = Object.keys(s.snapshot().entries[0].agents);
    expect(key).toHaveLength(160);
  });

  it("starts clean rather than refusing to run on a corrupt file", async () => {
    await fs.writeFile(path.join(dir, "route-usage.json"), "{ not json");
    const s = store();
    await expect(s.load()).resolves.toBeUndefined();
    expect(s.snapshot().entries).toEqual([]);
  });
});
