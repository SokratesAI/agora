import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** A folder in the conversation switcher (Edvard, ideas.md #5: "It quickly
 * becomes a long list, so organizing them into folders would be nice.
 * Heartbeat generated conversations should be auto created in the same
 * folder by default."). */
export interface Folder {
  id: string;
  name: string;
  createdAt: string;
}

/**
 * All folders in one JSON file, unlike the one-file-per-record stores
 * beside it. A folder is three short fields and there will be a handful of
 * them, so the per-file `stat` machinery ConversationStore needs to stay
 * fast buys nothing here — and the whole list is read on every drawer
 * render, which one file answers in a single read.
 *
 * Flat on purpose: nesting is cheap in this store and expensive in the
 * drawer, and 30 heartbeat conversations in one folder is the problem
 * actually being solved. `parentId` can be added without a migration if a
 * tree turns out to be wanted.
 */
export class FolderStore {
  private readonly file: string;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "folders.json");
  }

  async list(): Promise<Folder[]> {
    const folders = await this.readFile();
    return folders
      .map((f) => ({ ...f }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id: string): Promise<Folder | null> {
    const folders = await this.readFile();
    const found = folders.find((f) => f.id === id);
    return found ? { ...found } : null;
  }

  /** Find-or-create by exact name. The runner files each cycle's
   * conversation into a folder named after its heartbeat and has nowhere
   * to persist an id, so it needs to be able to ask for the folder by name
   * every cycle without creating a duplicate — same reasoning as
   * ConversationStore's create-or-fetch-by-name path. */
  async ensure(name: string): Promise<{ folder: Folder; created: boolean }> {
    const write = this.writeQueue.then(async () => {
      const folders = await this.readFile();
      const existing = folders.find((f) => f.name === name);
      if (existing) return { folder: { ...existing }, created: false };
      const folder: Folder = {
        id: randomUUID(),
        name,
        createdAt: new Date().toISOString(),
      };
      folders.push(folder);
      await this.writeFile(folders);
      return { folder: { ...folder }, created: true };
    });
    this.writeQueue = write.catch(() => undefined);
    return write;
  }

  async rename(id: string, name: string): Promise<Folder | null> {
    const write = this.writeQueue.then(async () => {
      const folders = await this.readFile();
      const folder = folders.find((f) => f.id === id);
      if (!folder) return null;
      folder.name = name;
      await this.writeFile(folders);
      return { ...folder };
    });
    this.writeQueue = write.catch(() => undefined);
    return write;
  }

  /** Deletes the folder only — conversations inside it are the caller's
   * problem, because this store knows nothing about them. The route moves
   * them back to the top level first. */
  async delete(id: string): Promise<boolean> {
    const write = this.writeQueue.then(async () => {
      const folders = await this.readFile();
      const index = folders.findIndex((f) => f.id === id);
      if (index === -1) return false;
      folders.splice(index, 1);
      await this.writeFile(folders);
      return true;
    });
    this.writeQueue = write.catch(() => undefined);
    return write;
  }

  private async readFile(): Promise<Folder[]> {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as Folder[]) : [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  private async writeFile(folders: Folder[]): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmpPath = `${this.file}.${randomUUID()}.tmp`;
    const handle = await fs.open(tmpPath, "w", 0o600);
    try {
      await handle.writeFile(JSON.stringify(folders, null, 2));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmpPath, this.file);
  }
}
