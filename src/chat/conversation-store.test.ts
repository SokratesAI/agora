import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ConversationStore, DEFAULT_MODEL, DEFAULT_THINKING } from "./conversation-store.js";

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
});
