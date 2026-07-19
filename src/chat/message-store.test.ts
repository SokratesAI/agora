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
});
