import { describe, it, expect, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  ConversationStore,
  DEFAULT_MODEL,
  DEFAULT_THINKING,
  DEFAULT_ARCHIVED,
  DEFAULT_STICKY_FALLBACK,
} from "./conversation-store.js";

describe("ConversationStore", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns an empty list when nothing has been created", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-conversations-test-"));
    const store = new ConversationStore(dir);
    expect(await store.list()).toEqual([]);
  });

  it("creates a conversation with an id, name, and personality, defaulting model/thinking", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-conversations-test-"));
    const store = new ConversationStore(dir);
    const conversation = await store.create("Haiku", "You are a helpful assistant.");
    expect(conversation.id).toBeTruthy();
    expect(conversation.name).toBe("Haiku");
    expect(conversation.personality).toBe("You are a helpful assistant.");
    expect(conversation.model).toBe(DEFAULT_MODEL);
    expect(conversation.thinking).toBe(DEFAULT_THINKING);
    expect(conversation.messages).toEqual([]);
  });

  it("creates a conversation with an explicit model and thinking", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-conversations-test-"));
    const store = new ConversationStore(dir);
    const conversation = await store.create("Gemini", "persona", "gemini:gemini-flash-latest", true);
    expect(conversation.model).toBe("gemini:gemini-flash-latest");
    expect(conversation.thinking).toBe(true);
  });

  it("leaves a pre-existing file's missing model empty so it can fall back to its curator, and backfills thinking", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-conversations-test-"));
    const store = new ConversationStore(dir);
    const conversation = await store.create("Haiku", "persona a");
    // Simulate a conversation file written before model/thinking existed.
    const filePath = path.join(dir, "conversations", `${conversation.id}.json`);
    const { model: _model, thinking: _thinking, ...withoutNewFields } = conversation;
    await fs.writeFile(filePath, JSON.stringify(withoutNewFields));

    const reloaded = await store.get(conversation.id);
    // Empty, not DEFAULT_MODEL. Since #65 the joined view resolves
    // `conversation.model || persona.model`, so backfilling a concrete
    // default here pinned every legacy conversation to hardcoded haiku
    // before the fallback could see it — silently, because the field then
    // looked populated. Empty is the honest representation of "this record
    // has no model of its own", and it is what reaches the curator.
    expect(reloaded?.model).toBe("");
    expect(reloaded?.model).not.toBe(DEFAULT_MODEL);
    expect(reloaded?.thinking).toBe(DEFAULT_THINKING);
  });

  it("lists conversation summaries without messages", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-conversations-test-"));
    const store = new ConversationStore(dir);
    await store.create("Haiku", "persona a");
    await store.create("Marcus", "persona b");
    const summaries = await store.list();
    expect(summaries.map((s) => s.name).sort()).toEqual(["Haiku", "Marcus"]);
    expect((summaries[0] as unknown as { messages?: unknown }).messages).toBeUndefined();
  });

  it("finds a conversation by name", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-conversations-test-"));
    const store = new ConversationStore(dir);
    const created = await store.create("Haiku", "persona a");
    const found = await store.findByName("Haiku");
    expect(found?.id).toBe(created.id);
  });

  it("returns null for an unknown name or id", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-conversations-test-"));
    const store = new ConversationStore(dir);
    expect(await store.findByName("nope")).toBeNull();
    expect(await store.get("nope")).toBeNull();
  });

  it("appends a message and persists it", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-conversations-test-"));
    const store = new ConversationStore(dir);
    const conversation = await store.create("Haiku", "persona a");
    const message = await store.appendMessage(conversation.id, "Edvard", "hi");
    expect(message?.sender).toBe("Edvard");
    const reloaded = await store.get(conversation.id);
    expect(reloaded?.messages).toEqual([message]);
  });

  it("preserves append order across multiple messages", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-conversations-test-"));
    const store = new ConversationStore(dir);
    const conversation = await store.create("Haiku", "persona a");
    await store.appendMessage(conversation.id, "Edvard", "one");
    await store.appendMessage(conversation.id, "Haiku", "two");
    await store.appendMessage(conversation.id, "Edvard", "three");
    const reloaded = await store.get(conversation.id);
    expect(reloaded?.messages.map((m) => m.text)).toEqual(["one", "two", "three"]);
  });

  it("returns null when appending to a conversation that doesn't exist", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-conversations-test-"));
    const store = new ConversationStore(dir);
    expect(await store.appendMessage("nope", "Edvard", "hi")).toBeNull();
  });

  it("updates only the fields given", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-conversations-test-"));
    const store = new ConversationStore(dir);
    const conversation = await store.create("Haiku", "persona a");
    const updated = await store.update(conversation.id, { model: "gemini:gemini-flash-latest" });
    expect(updated?.model).toBe("gemini:gemini-flash-latest");
    expect(updated?.name).toBe("Haiku");
    expect(updated?.personality).toBe("persona a");
  });

  it("update persists across a fresh read", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-conversations-test-"));
    const store = new ConversationStore(dir);
    const conversation = await store.create("Haiku", "persona a");
    await store.update(conversation.id, { thinking: true, personality: "new persona" });
    const reloaded = await store.get(conversation.id);
    expect(reloaded?.thinking).toBe(true);
    expect(reloaded?.personality).toBe("new persona");
  });

  it("returns null when updating a conversation that doesn't exist", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-conversations-test-"));
    const store = new ConversationStore(dir);
    expect(await store.update("nope", { model: "x" })).toBeNull();
  });

  it("defaults archived to false and can update it", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-conversations-test-"));
    const store = new ConversationStore(dir);
    const conversation = await store.create("Haiku", "persona a");
    expect(conversation.archived).toBe(DEFAULT_ARCHIVED);
    const updated = await store.update(conversation.id, { archived: true });
    expect(updated?.archived).toBe(true);
  });

  it("backfills archived when reading a pre-existing file that lacks it", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-conversations-test-"));
    const store = new ConversationStore(dir);
    const conversation = await store.create("Haiku", "persona a");
    const filePath = path.join(dir, "conversations", `${conversation.id}.json`);
    const { archived: _archived, ...withoutArchived } = conversation;
    await fs.writeFile(filePath, JSON.stringify(withoutArchived));
    const reloaded = await store.get(conversation.id);
    expect(reloaded?.archived).toBe(DEFAULT_ARCHIVED);
  });

  it("defaults stickyFallback to false and can update it", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-conversations-test-"));
    const store = new ConversationStore(dir);
    const conversation = await store.create("Haiku", "persona a");
    expect(conversation.stickyFallback).toBe(DEFAULT_STICKY_FALLBACK);
    const updated = await store.update(conversation.id, { stickyFallback: true });
    expect(updated?.stickyFallback).toBe(true);
  });

  it("backfills stickyFallback when reading a pre-existing file that lacks it", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-conversations-test-"));
    const store = new ConversationStore(dir);
    const conversation = await store.create("Haiku", "persona a");
    const filePath = path.join(dir, "conversations", `${conversation.id}.json`);
    const { stickyFallback: _stickyFallback, ...withoutSticky } = conversation;
    await fs.writeFile(filePath, JSON.stringify(withoutSticky));
    const reloaded = await store.get(conversation.id);
    expect(reloaded?.stickyFallback).toBe(DEFAULT_STICKY_FALLBACK);
  });

  it("carries stickyFallback over when forking a conversation", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-conversations-test-"));
    const store = new ConversationStore(dir);
    const conversation = await store.create("Haiku", "persona a");
    await store.update(conversation.id, { stickyFallback: true });
    const forked = await store.fork(conversation.id);
    expect(forked?.stickyFallback).toBe(true);
  });

  it("lists conversations sorted by most recent message activity, undated ones last", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-conversations-test-"));
    const store = new ConversationStore(dir);
    const stale = await store.create("Stale", "persona");
    await store.appendMessage(stale.id, "Edvard", "old message");
    const empty = await store.create("Empty", "persona");
    const fresh = await store.create("Fresh", "persona");
    await store.appendMessage(fresh.id, "Edvard", "new message");
    const names = (await store.list()).map((c) => c.name);
    expect(names).toEqual(["Fresh", "Stale", "Empty"]);
    expect(empty).toBeTruthy();
  });

  it("stores a per-message model override on appendMessage", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-conversations-test-"));
    const store = new ConversationStore(dir);
    const conversation = await store.create("Haiku", "persona a");
    const message = await store.appendMessage(
      conversation.id,
      "Edvard",
      "hi",
      "anthropic:claude-opus-4-8",
    );
    expect(message?.modelOverride).toBe("anthropic:claude-opus-4-8");
  });

  it("stores system:true on appendMessage, and omits it entirely when not passed", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-conversations-test-"));
    const store = new ConversationStore(dir);
    const conversation = await store.create("Test", "persona a");
    const systemMsg = await store.appendMessage(
      conversation.id, "Agora", "paused", undefined, undefined, true,
    );
    expect(systemMsg?.system).toBe(true);

    const normalMsg = await store.appendMessage(conversation.id, "Edvard", "hi");
    expect(normalMsg?.system).toBeUndefined();
  });

  it("stores thinking:true on appendMessage, and omits it entirely when not passed", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-conversations-test-"));
    const store = new ConversationStore(dir);
    const conversation = await store.create("Test", "persona a");
    const thinkingMsg = await store.appendMessage(
      conversation.id, "Gemini", "pondering...", undefined, undefined, undefined, undefined, true,
    );
    expect(thinkingMsg?.thinking).toBe(true);

    const normalMsg = await store.appendMessage(conversation.id, "Edvard", "hi");
    expect(normalMsg?.thinking).toBeUndefined();
  });

  it("deletes a message from a conversation", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-conversations-test-"));
    const store = new ConversationStore(dir);
    const conversation = await store.create("Haiku", "persona a");
    const first = await store.appendMessage(conversation.id, "Edvard", "one");
    const second = await store.appendMessage(conversation.id, "Haiku", "two");
    expect(await store.deleteMessage(conversation.id, first!.id)).toBe(true);
    const reloaded = await store.get(conversation.id);
    expect(reloaded?.messages).toEqual([second]);
  });

  it("returns false deleting a message from an unknown conversation or unknown message", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-conversations-test-"));
    const store = new ConversationStore(dir);
    expect(await store.deleteMessage("nope", "nope")).toBe(false);
    const conversation = await store.create("Haiku", "persona a");
    expect(await store.deleteMessage(conversation.id, "nope")).toBe(false);
  });

  it("edits a message and drops everything sent after it (edit-and-resend)", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-conversations-test-"));
    const store = new ConversationStore(dir);
    const conversation = await store.create("Haiku", "persona a");
    const first = await store.appendMessage(conversation.id, "Edvard", "typo");
    await store.appendMessage(conversation.id, "Haiku", "reply to the typo");
    const edited = await store.editMessage(conversation.id, first!.id, "fixed");
    expect(edited?.text).toBe("fixed");
    const reloaded = await store.get(conversation.id);
    expect(reloaded?.messages.map((m) => m.text)).toEqual(["fixed"]);
  });

  it("deletes a whole conversation", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-conversations-test-"));
    const store = new ConversationStore(dir);
    const conversation = await store.create("Haiku", "persona a");
    expect(await store.delete(conversation.id)).toBe(true);
    expect(await store.get(conversation.id)).toBeNull();
    expect(await store.list()).toEqual([]);
  });

  it("returns false deleting a conversation that doesn't exist", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-conversations-test-"));
    const store = new ConversationStore(dir);
    expect(await store.delete("nope")).toBe(false);
  });

  it("searches across conversations, case-insensitively", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-conversations-test-"));
    const store = new ConversationStore(dir);
    const haiku = await store.create("Haiku", "persona a");
    const marcus = await store.create("Marcus", "persona b");
    await store.appendMessage(haiku.id, "Edvard", "let's talk about TRAINING today");
    await store.appendMessage(marcus.id, "Marcus", "how was training yesterday?");
    await store.appendMessage(marcus.id, "Edvard", "unrelated message");
    const results = await store.search("training");
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.conversationName).sort()).toEqual(["Haiku", "Marcus"]);
  });

  it("returns no results searching for a term that doesn't appear anywhere", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-conversations-test-"));
    const store = new ConversationStore(dir);
    const conversation = await store.create("Haiku", "persona a");
    await store.appendMessage(conversation.id, "Edvard", "hello");
    expect(await store.search("xyzzy")).toEqual([]);
  });

  it("backfills status/memory/tags/rootId but never personas", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-conversations-test-"));
    const store = new ConversationStore(dir);
    const conversation = await store.create("Old", "p");
    const filePath = path.join(dir, "conversations", `${conversation.id}.json`);
    const { status: _s, memory: _m, tags: _t, rootId: _r, ...older } = conversation;
    await fs.writeFile(filePath, JSON.stringify(older));
    const reloaded = await store.get(conversation.id);
    expect(reloaded?.status).toBe("active");
    expect(reloaded?.memory).toBe("");
    expect(reloaded?.tags).toEqual([]);
    expect(reloaded?.rootId).toBe(conversation.id);
    // absence of personas is the migration's "unmigrated" signal
    expect(reloaded?.personas).toBeUndefined();
  });

  it("forks a conversation at a message, keeping lineage and the one persona", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-conversations-test-"));
    const store = new ConversationStore(dir);
    const source = await store.create("Marcus", "trainer", undefined, undefined, [
      { personaId: "p1", role: "curator" },
    ]);
    const first = await store.appendMessage(source.id, "Edvard", "one");
    await store.appendMessage(source.id, "Marcus", "two");

    const forked = await store.fork(source.id, first!.id);
    expect(forked?.name).toBe("Marcus (fork)");
    expect(forked?.rootId).toBe(source.id);
    expect(forked?.forkedFrom).toEqual({ conversationId: source.id, messageId: first!.id });
    expect(forked?.messages.map((m) => m.text)).toEqual(["one"]);
    expect(forked?.personas).toEqual([{ personaId: "p1", role: "curator" }]);
    expect(forked?.memory).toBe(source.memory);

    // second fork gets a numbered name, same lineage
    const second = await store.fork(source.id);
    expect(second?.name).toBe("Marcus (fork 2)");
    expect(second?.rootId).toBe(source.id);
    expect(second?.messages).toHaveLength(2);
  });

  it("fork returns null for unknown conversation or message", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-conversations-test-"));
    const store = new ConversationStore(dir);
    expect(await store.fork("nope")).toBeNull();
    const conversation = await store.create("A", "p");
    expect(await store.fork(conversation.id, "missing-message")).toBeNull();
  });

  it("toggles forgotten on a message", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-conversations-test-"));
    const store = new ConversationStore(dir);
    const conversation = await store.create("A", "p");
    const message = await store.appendMessage(conversation.id, "Edvard", "secret");
    expect(await store.setForgotten(conversation.id, message!.id, true)).toBe(true);
    let reloaded = await store.get(conversation.id);
    expect(reloaded?.messages[0].forgotten).toBe(true);
    expect(await store.setForgotten(conversation.id, message!.id, false)).toBe(true);
    reloaded = await store.get(conversation.id);
    expect(reloaded?.messages[0].forgotten).toBeUndefined();
    expect(await store.setForgotten(conversation.id, "nope", true)).toBe(false);
  });

  it("bulk-imports messages preserving order and ids", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-conversations-test-"));
    const store = new ConversationStore(dir);
    const conversation = await store.create("Main", "");
    const ok = await store.importMessages(conversation.id, [
      { id: "m1", sender: "Edvard", text: "a", ts: "2026-01-01T00:00:00.000Z" },
      { id: "m2", sender: "Claude", text: "b", ts: "2026-01-01T00:01:00.000Z" },
    ]);
    expect(ok).toBe(true);
    const reloaded = await store.get(conversation.id);
    expect(reloaded?.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  // list() is called by the runner's poll loop every 5s and awaited by every
  // UI action; before the summary cache it re-parsed every conversation file
  // each time (measured live: 66 files, 15.4 MB, ~1.2s a call).
  describe("list() summary caching", () => {
    it("does not re-read a conversation file that has not changed", async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-conversations-test-"));
      const store = new ConversationStore(dir);
      await store.create("One", "");
      await store.create("Two", "");

      const first = await store.list();
      const spy = vi.spyOn(fs, "readFile");
      try {
        const second = await store.list();
        expect(spy).not.toHaveBeenCalled();
        expect(second).toEqual(first);
      } finally {
        spy.mockRestore();
      }
    });

    it("re-reads only the conversation that changed", async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-conversations-test-"));
      const store = new ConversationStore(dir);
      const one = await store.create("One", "");
      await store.create("Two", "");
      await store.list();

      await store.appendMessage(one.id, "Edvard", "hello");
      const spy = vi.spyOn(fs, "readFile");
      let summaries;
      try {
        summaries = await store.list();
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
      const changed = summaries.find((c) => c.id === one.id);
      expect(changed?.lastMessageAt).not.toBeNull();
      expect(summaries.find((c) => c.name === "Two")?.lastMessageAt).toBeNull();
    });

    it("picks up a conversation file edited behind the store's back", async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-conversations-test-"));
      const store = new ConversationStore(dir);
      const conversation = await store.create("One", "");
      await store.list();

      const filePath = path.join(dir, "conversations", `${conversation.id}.json`);
      const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
      raw.name = "Renamed externally";
      raw.messages = [{ id: "m1", sender: "Edvard", text: "hi", ts: "2026-02-02T00:00:00.000Z" }];
      await fs.writeFile(filePath, JSON.stringify(raw, null, 2));

      const summaries = await store.list();
      expect(summaries[0].name).toBe("Renamed externally");
      expect(summaries[0].lastMessageAt).toBe("2026-02-02T00:00:00.000Z");
    });

    it("drops a deleted conversation from the list", async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-conversations-test-"));
      const store = new ConversationStore(dir);
      const one = await store.create("One", "");
      await store.create("Two", "");
      expect(await store.list()).toHaveLength(2);

      expect(await store.delete(one.id)).toBe(true);
      const summaries = await store.list();
      expect(summaries.map((c) => c.name)).toEqual(["Two"]);
    });

    // The stat key alone would leave correctness resting on the data
    // volume's mtime resolution, which this store has no way to check.
    it("reflects a write even when the file's stat cannot distinguish it", async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-conversations-test-"));
      const store = new ConversationStore(dir);
      const one = await store.create("One", "");
      await store.list();

      const frozen = await fs.stat(path.join(dir, "conversations", `${one.id}.json`), {
        bigint: true,
      });
      const spy = vi.spyOn(fs, "stat").mockResolvedValue(frozen as never);
      try {
        await store.appendMessage(one.id, "Edvard", "hello");
        const summaries = await store.list();
        expect(summaries[0].lastMessageAt).not.toBeNull();
      } finally {
        spy.mockRestore();
      }
    });

    it("forgets a deleted conversation instead of caching it forever", async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-conversations-test-"));
      const store = new ConversationStore(dir);
      const one = await store.create("One", "");
      await store.create("Two", "");
      const cache = (store as unknown as { summaryCache: Map<string, unknown> }).summaryCache;

      await store.list();
      expect(cache.size).toBe(2);
      await store.delete(one.id);
      await store.list();
      expect(cache.size).toBe(1);
    });

    it("hands out an independent copy, so a caller cannot corrupt the cache", async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-conversations-test-"));
      const store = new ConversationStore(dir);
      await store.create("One", "");

      const first = await store.list();
      first[0].name = "mutated by a caller";
      const second = await store.list();
      expect(second[0].name).toBe("One");
    });
  });
});
