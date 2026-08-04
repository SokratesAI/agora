import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { AuditStore, trim, CONTENT_CHARS_MAX, type AuditEntry } from "./audit-store.js";

function entry(capability: string, ephemeral?: boolean): AuditEntry {
  return {
    ts: "2026-08-04T00:00:00.000Z",
    personaName: "Nova",
    conversationId: "c1",
    capability,
    detail: "",
    ...(ephemeral ? { ephemeral: true } : {}),
  };
}

describe("trim", () => {
  it("keeps everything while both classes are under budget", () => {
    const entries = [entry("vault_write"), entry("Bash", true)];
    expect(trim(entries)).toBe(entries);
  });

  it("evicts the oldest durable entries once over budget", () => {
    const entries = Array.from({ length: 505 }, (_, i) => entry(`cap-${i}`));
    const kept = trim(entries);
    expect(kept).toHaveLength(500);
    expect(kept[0].capability).toBe("cap-5");
    expect(kept[499].capability).toBe("cap-504");
  });

  it("a flood of narration chips does not evict the capability trail", () => {
    // The regression this budget exists for, at the shape it actually
    // happens in: a trail built up over days, then one claude-cli cycle
    // emitting up to TOOL_ACTIVITY_MAX_PER_CALL (400) chips. Under the old
    // shared 500-entry budget the 200 + 400 here overflowed by 100 and the
    // oldest 100 capability entries were the ones that went.
    const durable = Array.from({ length: 200 }, (_, i) => entry(`vault_write-${i}`));
    const chips = Array.from({ length: 400 }, () => entry("Bash", true));
    const kept = trim([...durable, ...chips]);
    expect(kept.filter((e) => !e.ephemeral)).toEqual(durable);
    expect(kept.filter((e) => e.ephemeral)).toHaveLength(400);
  });

  it("caps narration on its own budget without touching durable entries", () => {
    const chips = Array.from({ length: 600 }, (_, i) => entry(`chip-${i}`, true));
    const kept = trim([entry("vault_write"), ...chips]);
    const keptChips = kept.filter((e) => e.ephemeral);
    expect(keptChips).toHaveLength(500);
    expect(keptChips[0].capability).toBe("chip-100");
    expect(kept.filter((e) => !e.ephemeral)).toHaveLength(1);
  });

  it("evicts both classes when both are over, and preserves order", () => {
    const entries: AuditEntry[] = [];
    for (let i = 0; i < 600; i += 1) {
      entries.push(entry(`d-${i}`));
      entries.push(entry(`e-${i}`, true));
    }
    const kept = trim(entries);
    expect(kept).toHaveLength(1000);
    // Interleaving (and therefore chronological order) survives: the kept
    // entries appear in the same relative order they were appended in.
    const original = entries.map((e) => e.capability);
    const keptOrder = kept.map((e) => e.capability);
    expect(keptOrder).toEqual(original.filter((c) => keptOrder.includes(c)));
    expect(keptOrder.slice(0, 2)).toEqual(["d-100", "e-100"]);
  });
});

describe("AuditStore", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  async function makeStore() {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-audit-test-"));
    return new AuditStore(dir);
  }

  it("stamps ts and round-trips an entry", async () => {
    const store = await makeStore();
    const written = await store.append({
      personaName: "Nova",
      conversationId: "c1",
      capability: "vault_write",
      detail: "notes.md",
    });
    expect(written.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await store.list()).toEqual([written]);
  });

  it("lists newest first", async () => {
    const store = await makeStore();
    for (const capability of ["one", "two", "three"]) {
      await store.append({ personaName: "Nova", conversationId: null, capability, detail: "" });
    }
    expect((await store.list()).map((e) => e.capability)).toEqual(["three", "two", "one"]);
    expect((await store.list(2)).map((e) => e.capability)).toEqual(["three", "two"]);
  });

  it("truncates before/after but leaves detail to the caller", async () => {
    const store = await makeStore();
    const written = await store.append({
      personaName: "Nova",
      conversationId: null,
      capability: "vault_write",
      detail: "x".repeat(50),
      before: "b".repeat(CONTENT_CHARS_MAX + 100),
      after: "a".repeat(CONTENT_CHARS_MAX + 100),
    });
    expect(written.before).toHaveLength(CONTENT_CHARS_MAX);
    expect(written.after).toHaveLength(CONTENT_CHARS_MAX);
    expect(written.detail).toHaveLength(50);
  });

  it("applies the split budget on append, not just in memory", async () => {
    const store = await makeStore();
    // Seeded rather than appended 500 times: one append is enough to prove
    // the policy is wired into the write path, and 500 round-trips through
    // fsync makes this the slowest test in the suite for no extra coverage.
    // The durable entry is oldest, so a shared budget evicts it first.
    await fs.writeFile(
      path.join(dir, "audit.json"),
      JSON.stringify([
        entry("vault_write"),
        ...Array.from({ length: 500 }, (_, i) => entry(`chip-${i}`, true)),
      ]),
    );
    await store.append({
      personaName: "Nova", conversationId: null, capability: "newest", detail: "",
      ephemeral: true,
    });
    const all = await store.list(2000);
    expect(all.filter((e) => !e.ephemeral).map((e) => e.capability)).toEqual(["vault_write"]);
    const chips = all.filter((e) => e.ephemeral);
    expect(chips).toHaveLength(500);
    // list() is newest-first: the new chip is in, the oldest one is gone.
    expect(chips[0].capability).toBe("newest");
    expect(chips[499].capability).toBe("chip-1");
  });

  it("returns an empty list before anything is written", async () => {
    const store = await makeStore();
    expect(await store.list()).toEqual([]);
  });
});
