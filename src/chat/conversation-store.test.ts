import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  ConversationStore,
  DEFAULT_MODEL,
  DEFAULT_THINKING,
  DEFAULT_ARCHIVED,
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

  it("backfills model/thinking defaults when reading a pre-existing file that lacks them", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-conversations-test-"));
    const store = new ConversationStore(dir);
    const conversation = await store.create("Haiku", "persona a");
    // Simulate a conversation file written before model/thinking existed.
    const filePath = path.join(dir, "conversations", `${conversation.id}.json`);
    const { model: _model, thinking: _thinking, ...withoutNewFields } = conversation;
    await fs.writeFile(filePath, JSON.stringify(withoutNewFields));

    const reloaded = await store.get(conversation.id);
    expect(reloaded?.model).toBe(DEFAULT_MODEL);
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
});
