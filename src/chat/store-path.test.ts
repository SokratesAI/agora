import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { storePath, UnsafeStoreIdError } from "./store-path.js";
import { PersonaStore } from "./persona-store.js";
import { ConversationStore } from "./conversation-store.js";
import { AttachmentStore } from "./attachment-store.js";

describe("storePath", () => {
  const dir = "/data/personas";

  it("joins an ordinary id, with and without a suffix", () => {
    expect(storePath(dir, "abc-123")).toBe(path.join(dir, "abc-123"));
    expect(storePath(dir, "abc-123", ".json")).toBe(path.join(dir, "abc-123.json"));
  });

  it("takes a real randomUUID, which is every id these stores mint", () => {
    expect(storePath(dir, "3f2504e0-4f89-11d3-9a0c-0305e82c3301", ".json")).toBe(
      path.join(dir, "3f2504e0-4f89-11d3-9a0c-0305e82c3301.json"),
    );
  });

  it.each([
    ["a parent reference", ".."],
    ["a single dot", "."],
    ["a relative escape", "../secrets"],
    ["a backslash escape", "..\\secrets"],
    ["an absolute path", "/etc/passwd"],
    ["a nested segment", "a/b"],
    ["an empty id", ""],
    ["a NUL byte", `abc${String.fromCharCode(0)}`],
    ["a trailing space", "abc "],
    ["a space", "my conversation"],
  ])("refuses %s", (_label, id) => {
    expect(storePath(dir, id, ".json")).toBeNull();
  });

  it("never returns a path outside the directory it was given", () => {
    // The property, rather than the nine cases above: whatever comes back is
    // a direct child of `dir`. A future widening of the character class that
    // let an escape through would fail here even if it added no new case.
    const attempts = ["..", "../..", "../../etc/passwd", "./..", "a/../..", " "];
    for (const id of attempts) {
      const result = storePath(dir, id, ".json");
      if (result !== null) expect(path.dirname(path.resolve(result))).toBe(path.resolve(dir));
    }
  });
});

describe("stores refuse a traversing id instead of reading past their own directory", () => {
  let root: string;

  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  // Every store appends its own subdirectory to the dataDir it is handed --
  // `personas`, `conversations`, `attachments` -- so `../secret` from inside
  // one of them lands in the dataDir itself. The decoy goes there, and not one
  // level higher: an escape aimed at a path where no file exists returns null
  // whether or not the guard is present, which is a test that can only pass.
  // The first draft of this file made exactly that mistake and a mutation that
  // removed the guard from `PersonaStore.get` survived all of it.
  async function sandbox() {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "agora-traversal-test-"));
    await fs.writeFile(
      path.join(root, "secret.json"),
      JSON.stringify({ id: "secret", name: "not yours" }),
    );
    return root;
  }

  it("the decoy really is reachable by the escape under test", async () => {
    const dataDir = await sandbox();
    // The control for every case below: `../secret.json` from the personas
    // directory resolves onto a file that exists and parses. If this ever
    // stops holding, the nulls below stop meaning anything.
    const escaped = path.join(dataDir, "personas", "..", "secret.json");
    const raw = await fs.readFile(escaped, "utf8");
    expect(JSON.parse(raw).name).toBe("not yours");
  });

  it("PersonaStore.get returns null rather than the file above it", async () => {
    const store = new PersonaStore(await sandbox());
    expect(await store.get("../secret")).toBeNull();
  });

  it("PersonaStore.delete returns false and leaves the file above it alone", async () => {
    const store = new PersonaStore(await sandbox());
    expect(await store.delete("../secret")).toBe(false);
    await expect(fs.stat(path.join(root, "secret.json"))).resolves.toBeTruthy();
  });

  it("ConversationStore.get returns null rather than the file above it", async () => {
    const store = new ConversationStore(await sandbox());
    expect(await store.get("../secret")).toBeNull();
  });

  it("AttachmentStore.getMeta and getContent return null for a traversing id", async () => {
    const dataDir = await sandbox();
    // This one reads `<dir>/<id>/meta.json`, so the escape has to climb one
    // level further than the flat stores to reach the same decoy.
    await fs.mkdir(path.join(dataDir, "secret"), { recursive: true });
    await fs.writeFile(path.join(dataDir, "secret", "meta.json"), JSON.stringify({ id: "secret" }));
    await fs.writeFile(path.join(dataDir, "secret", "content"), "not yours");
    const store = new AttachmentStore(dataDir);
    expect(await store.getMeta("../secret")).toBeNull();
    expect(await store.getContent("../secret")).toBeNull();
  });

  it("still round-trips a real record, so the guard is not just refusing everything", async () => {
    const store = new PersonaStore(await sandbox());
    const created = await store.create({ name: "Nova", model: "claude-cli:claude-opus-5" });
    const read = await store.get(created.id);
    expect(read?.name).toBe("Nova");
    expect(await store.delete(created.id)).toBe(true);
  });
});

describe("UnsafeStoreIdError", () => {
  it("names the id it refused", () => {
    const err = new UnsafeStoreIdError("../etc/passwd");
    expect(err.name).toBe("UnsafeStoreIdError");
    expect(err.message).toContain("../etc/passwd");
  });
});
