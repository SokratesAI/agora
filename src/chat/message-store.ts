import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface Message {
  id: string;
  sender: string;
  text: string;
  ts: string;
  /** "<provider>:<model id>" — set only when Edvard picked a different
   * model than the conversation's default for this one message (Phase 5's
   * per-message override). The runner uses it for just this reply, never
   * persists it back onto the conversation's own `model` field. */
  modelOverride?: string;
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

  async append(sender: string, text: string, modelOverride?: string): Promise<Message> {
    const message: Message = {
      id: randomUUID(),
      sender,
      text,
      ts: new Date().toISOString(),
      ...(modelOverride ? { modelOverride } : {}),
    };
    const write = this.writeQueue.then(() => this.writeWith(message));
    this.writeQueue = write.catch(() => undefined);
    await write;
    return message;
  }

  /** Retract a message (Phase 5's delete/regenerate). Regenerate reuses
   * this on the persona's own last reply — deleting it makes that
   * conversation's last sender Edvard again, so the runner's existing
   * "reply iff last sender is Edvard" rule regenerates on its next poll,
   * no separate regenerate endpoint needed. */
  async deleteMessage(id: string): Promise<boolean> {
    const write = this.writeQueue.then(() => this.deleteWith(id));
    this.writeQueue = write.catch(() => undefined);
    return write;
  }

  private async deleteWith(id: string): Promise<boolean> {
    const messages = await this.list();
    const index = messages.findIndex((m) => m.id === id);
    if (index === -1) return false;
    messages.splice(index, 1);
    await this.persist(messages);
    return true;
  }

  /** Edit-and-resend: changes a message's text and drops everything sent
   * after it, so a persona reply that answered the old text doesn't linger
   * next to the edited question — the runner regenerates against the new
   * text on its next poll, same mechanism as deleteMessage(). */
  async editMessage(id: string, text: string): Promise<Message | null> {
    const write = this.writeQueue.then(() => this.editWith(id, text));
    this.writeQueue = write.catch(() => undefined);
    return write;
  }

  private async editWith(id: string, text: string): Promise<Message | null> {
    const messages = await this.list();
    const index = messages.findIndex((m) => m.id === id);
    if (index === -1) return null;
    messages[index] = { ...messages[index], text };
    const truncated = messages.slice(0, index + 1);
    await this.persist(truncated);
    return truncated[index];
  }

  private async writeWith(message: Message): Promise<void> {
    const messages = await this.list();
    messages.push(message);
    await this.persist(messages);
  }

  private async persist(messages: Message[]): Promise<void> {
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
