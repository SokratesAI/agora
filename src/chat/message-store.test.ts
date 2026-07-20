import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { MessageStore } from "./message-store.js";

describe("MessageStore", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns an empty list when nothing has been appended", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-messages-test-"));
    const store = new MessageStore(dir);
    expect(await store.list()).toEqual([]);
  });

  it("appends a message and returns it with an id and timestamp", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-messages-test-"));
    const store = new MessageStore(dir);
    const message = await store.append("Edvard", "hello");
    expect(message.sender).toBe("Edvard");
    expect(message.text).toBe("hello");
    expect(message.id).toBeTruthy();
    expect(message.ts).toBeTruthy();
    expect(await store.list()).toEqual([message]);
  });

  it("preserves append order across multiple messages", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-messages-test-"));
    const store = new MessageStore(dir);
    await store.append("Claude", "one");
    await store.append("Edvard", "two");
    await store.append("Claude", "three");
    const list = await store.list();
    expect(list.map((m) => m.text)).toEqual(["one", "two", "three"]);
  });

  it("does not lose messages from concurrent appends", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-messages-test-"));
    const store = new MessageStore(dir);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.append("Claude", `msg-${i}`)),
    );
    const list = await store.list();
    expect(list).toHaveLength(20);
  });

  it("creates the data directory if it doesn't exist yet", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-messages-test-"));
    const nested = path.join(dir, "nested", "deeper");
    const store = new MessageStore(nested);
    await store.append("Edvard", "hi");
    expect(await store.list()).toHaveLength(1);
  });

  it("stores a per-message model override when given", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-messages-test-"));
    const store = new MessageStore(dir);
    const message = await store.append("Edvard", "hi", "anthropic:claude-opus-4-8");
    expect(message.modelOverride).toBe("anthropic:claude-opus-4-8");
    const withoutOverride = await store.append("Edvard", "hi again");
    expect(withoutOverride.modelOverride).toBeUndefined();
  });

  it("deletes a message by id", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-messages-test-"));
    const store = new MessageStore(dir);
    const first = await store.append("Edvard", "one");
    const second = await store.append("Claude", "two");
    expect(await store.deleteMessage(first.id)).toBe(true);
    const remaining = await store.list();
    expect(remaining).toEqual([second]);
  });

  it("returns false when deleting a message that doesn't exist", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-messages-test-"));
    const store = new MessageStore(dir);
    expect(await store.deleteMessage("nope")).toBe(false);
  });

  it("edits a message's text and drops everything sent after it", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-messages-test-"));
    const store = new MessageStore(dir);
    const first = await store.append("Edvard", "origina text");
    await store.append("Claude", "a reply to the typo");
    const edited = await store.editMessage(first.id, "original text");
    expect(edited?.text).toBe("original text");
    const remaining = await store.list();
    expect(remaining.map((m) => m.text)).toEqual(["original text"]);
  });

  it("returns null when editing a message that doesn't exist", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-messages-test-"));
    const store = new MessageStore(dir);
    expect(await store.editMessage("nope", "text")).toBeNull();
  });
});
