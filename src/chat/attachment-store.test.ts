import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { AttachmentStore } from "./attachment-store.js";

describe("AttachmentStore", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  async function makeStore() {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-attachments-test-"));
    return new AttachmentStore(dir);
  }

  it("returns null metadata and content for an unknown id", async () => {
    const store = await makeStore();
    expect(await store.getMeta("nope")).toBeNull();
    expect(await store.getContent("nope")).toBeNull();
  });

  it("round-trips filename, mimeType, size, and content", async () => {
    const store = await makeStore();
    const content = Buffer.from("hello world");
    const meta = await store.save("notes.txt", "text/plain", content);

    expect(meta.filename).toBe("notes.txt");
    expect(meta.mimeType).toBe("text/plain");
    expect(meta.size).toBe(content.length);
    expect(meta.id).toMatch(/^[0-9a-f-]{36}$/);

    expect(await store.getMeta(meta.id)).toEqual(meta);
    const roundTripped = await store.getContent(meta.id);
    expect(roundTripped?.equals(content)).toBe(true);
  });

  it("round-trips binary content (e.g. an image) without corruption", async () => {
    const store = await makeStore();
    // Non-UTF8-safe bytes — would corrupt if anything along the path
    // treated the buffer as a string at any point.
    const content = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x00, 0x01]);
    const meta = await store.save("photo.jpg", "image/jpeg", content);
    const roundTripped = await store.getContent(meta.id);
    expect(roundTripped?.equals(content)).toBe(true);
  });

  it("assigns distinct ids to two uploads with the same filename", async () => {
    const store = await makeStore();
    const a = await store.save("same.txt", "text/plain", Buffer.from("a"));
    const b = await store.save("same.txt", "text/plain", Buffer.from("b"));
    expect(a.id).not.toBe(b.id);
    expect((await store.getContent(a.id))?.toString()).toBe("a");
    expect((await store.getContent(b.id))?.toString()).toBe("b");
  });

  it("creates the attachments directory on demand", async () => {
    const store = await makeStore();
    // No files written yet — the directory itself shouldn't need to
    // pre-exist for a fresh DATA_DIR (same posture as the other stores).
    await expect(fs.access(path.join(dir, "attachments"))).rejects.toThrow();
    await store.save("f.txt", "text/plain", Buffer.from("x"));
    await expect(fs.access(path.join(dir, "attachments"))).resolves.toBeUndefined();
  });
});
