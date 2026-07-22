import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface AttachmentMeta {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

/** Per-file cap — generous enough for phone photos/short voice notes,
 * small enough that one upload can't exhaust the PVC. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * Uploaded chat attachments (Issues.md: "Sending files, images or voice
 * does not work"). Same DATA_DIR-backed PVC as every other store here.
 * One directory per attachment (rather than a flat file + separate index)
 * so the original filename and content live together and neither can
 * exist without the other.
 */
export class AttachmentStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "attachments");
  }

  private entryDir(id: string): string {
    return path.join(this.dir, id);
  }

  async save(filename: string, mimeType: string, content: Buffer): Promise<AttachmentMeta> {
    const id = randomUUID();
    const dir = this.entryDir(id);
    await fs.mkdir(dir, { recursive: true });
    const meta: AttachmentMeta = { id, filename, mimeType, size: content.length };
    await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify(meta));
    await fs.writeFile(path.join(dir, "content"), content);
    return meta;
  }

  async getMeta(id: string): Promise<AttachmentMeta | null> {
    try {
      const raw = await fs.readFile(path.join(this.entryDir(id), "meta.json"), "utf8");
      return JSON.parse(raw) as AttachmentMeta;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async getContent(id: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(path.join(this.entryDir(id), "content"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }
}
