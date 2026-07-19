import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface Message {
  id: string;
  sender: string;
  text: string;
  ts: string;
}

/**
 * Chat history — every /reply and /notify call lands here, not just a log
 * line, so the frontend can render a real thread instead of a fire-and-forget
 * form. Same file-on-PVC, atomic-write shape as SubscriptionStore.
 *
 * Appends are chained through `writeQueue` because both the public app
 * (/reply) and internal app (/notify) run in the same process and could
 * otherwise race a read-modify-write on the same file.
 */
export class MessageStore {
  private readonly filePath: string;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "messages.json");
  }

  async list(): Promise<Message[]> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return JSON.parse(raw) as Message[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  async append(sender: string, text: string): Promise<Message> {
    const message: Message = { id: randomUUID(), sender, text, ts: new Date().toISOString() };
    const write = this.writeQueue.then(() => this.writeWith(message));
    this.writeQueue = write.catch(() => undefined);
    await write;
    return message;
  }

  private async writeWith(message: Message): Promise<void> {
    const messages = await this.list();
    messages.push(message);
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${randomUUID()}.tmp`;
    const handle = await fs.open(tmpPath, "w", 0o600);
    try {
      await handle.writeFile(JSON.stringify(messages, null, 2));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmpPath, this.filePath);
  }
}
