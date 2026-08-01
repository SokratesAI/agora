import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { PersonaStore, DEFAULT_CAPABILITIES } from "./persona-store.js";

describe("PersonaStore", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  async function makeStore() {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-personas-test-"));
    return new PersonaStore(dir);
  }

  it("returns an empty list when nothing has been created", async () => {
    const store = await makeStore();
    expect(await store.list()).toEqual([]);
  });

  it("creates a persona with capability defaults per the triage", async () => {
    const store = await makeStore();
    const persona = await store.create({ name: "Marcus", model: "anthropic:claude-sonnet-5" });
    expect(persona.capabilities).toEqual(DEFAULT_CAPABILITIES);
    expect(persona.capabilities.webSearch).toBe(true);
    expect(persona.capabilities.vaultRead).toBe(true);
    expect(persona.capabilities.vaultWrite).toBe(false);
    expect(persona.capabilities.codeExecution).toBe(false);
    // Issues.md #3 — cluster/GitHub read tools default off, unlike
    // webSearch/vaultRead. Powerful new capabilities shouldn't silently
    // turn on for personas that predate them.
    expect(persona.capabilities.kubectlRead).toBe(false);
    expect(persona.capabilities.githubRead).toBe(false);
    expect(persona.sharedMemory).toBe("");
    expect(persona.isTemplate).toBe(false);
  });

  it("merges partial capability overrides on create and update", async () => {
    const store = await makeStore();
    const persona = await store.create({
      name: "Writer",
      model: "anthropic:claude-sonnet-5",
      capabilities: { vaultWrite: true },
    });
    expect(persona.capabilities.vaultWrite).toBe(true);
    expect(persona.capabilities.webSearch).toBe(true);

    const updated = await store.update(persona.id, { capabilities: { webSearch: false } });
    expect(updated?.capabilities.webSearch).toBe(false);
    expect(updated?.capabilities.vaultWrite).toBe(true);
  });

  it("toggles kubectlRead/githubRead independently of other capabilities", async () => {
    const store = await makeStore();
    const persona = await store.create({
      name: "Ops",
      model: "anthropic:claude-sonnet-5",
      capabilities: { kubectlRead: true, githubRead: true },
    });
    expect(persona.capabilities.kubectlRead).toBe(true);
    expect(persona.capabilities.githubRead).toBe(true);
    // Everything else stays at its own default, unaffected.
    expect(persona.capabilities.webSearch).toBe(true);
    expect(persona.capabilities.vaultWrite).toBe(false);

    const updated = await store.update(persona.id, { capabilities: { kubectlRead: false } });
    expect(updated?.capabilities.kubectlRead).toBe(false);
    expect(updated?.capabilities.githubRead).toBe(true);
  });

  it("defaults terminalExec to off and toggles it independently of other capabilities", async () => {
    const store = await makeStore();
    const persona = await store.create({ name: "Shell", model: "anthropic:claude-sonnet-5" });
    expect(persona.capabilities.terminalExec).toBe(false);

    const granted = await store.update(persona.id, { capabilities: { terminalExec: true } });
    expect(granted?.capabilities.terminalExec).toBe(true);
    expect(granted?.capabilities.githubWrite).toBe(false);
    expect(granted?.capabilities.githubMerge).toBe(false);

    const revoked = await store.update(persona.id, { capabilities: { terminalExec: false } });
    expect(revoked?.capabilities.terminalExec).toBe(false);
  });

  it("persists updates and bumps updatedAt", async () => {
    const store = await makeStore();
    const persona = await store.create({ name: "A", model: "anthropic:claude-sonnet-5" });
    await store.update(persona.id, { personality: "new", sharedMemory: "remembers things" });
    const reloaded = await store.get(persona.id);
    expect(reloaded?.personality).toBe("new");
    expect(reloaded?.sharedMemory).toBe("remembers things");
  });

  it("clones with capabilities and memory, never as a template", async () => {
    const store = await makeStore();
    const template = await store.create({
      name: "Trainer",
      personality: "coach",
      model: "anthropic:claude-sonnet-5",
      capabilities: { vaultWrite: true },
      isTemplate: true,
    });
    const clone = await store.clone(template.id);
    expect(clone?.name).toBe("Trainer (copy)");
    expect(clone?.personality).toBe("coach");
    expect(clone?.capabilities.vaultWrite).toBe(true);
    expect(clone?.isTemplate).toBe(false);
    expect(clone?.id).not.toBe(template.id);
  });

  it("omits claudeCliRestricted by default and persists it when set", async () => {
    const store = await makeStore();
    const persona = await store.create({ name: "A", model: "claude-cli:claude-haiku-4-5-20251001" });
    expect(persona.claudeCliRestricted).toBeUndefined();

    const created = await store.create({
      name: "B", model: "claude-cli:claude-haiku-4-5-20251001", claudeCliRestricted: true,
    });
    expect(created.claudeCliRestricted).toBe(true);

    await store.update(persona.id, { claudeCliRestricted: true });
    const reloaded = await store.get(persona.id);
    expect(reloaded?.claudeCliRestricted).toBe(true);
  });

  it("carries claudeCliRestricted through clone", async () => {
    const store = await makeStore();
    const source = await store.create({
      name: "A", model: "claude-cli:claude-haiku-4-5-20251001", claudeCliRestricted: true,
    });
    const clone = await store.clone(source.id);
    expect(clone?.claudeCliRestricted).toBe(true);
  });

  it("deletes and reports missing ids", async () => {
    const store = await makeStore();
    const persona = await store.create({ name: "A", model: "anthropic:claude-sonnet-5" });
    expect(await store.delete(persona.id)).toBe(true);
    expect(await store.delete(persona.id)).toBe(false);
    expect(await store.get(persona.id)).toBeNull();
  });

  it("backfills capabilities on records written before the field existed", async () => {
    const store = await makeStore();
    const persona = await store.create({ name: "Old", model: "anthropic:claude-sonnet-5" });
    const filePath = path.join(dir, "personas", `${persona.id}.json`);
    const { capabilities: _c, sharedMemory: _m, isTemplate: _t, ...older } = persona;
    await fs.writeFile(filePath, JSON.stringify(older));
    const reloaded = await store.get(persona.id);
    expect(reloaded?.capabilities).toEqual(DEFAULT_CAPABILITIES);
    expect(reloaded?.sharedMemory).toBe("");
    expect(reloaded?.isTemplate).toBe(false);
  });
});
