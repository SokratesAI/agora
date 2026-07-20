import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface Message {
  id: string;
  sender: string;
  text: string;
  ts: string;
}

export interface Conversation {
  id: string;
  name: string;
  personality: string;
  /** "<provider>:<model id>", e.g. "anthropic:claude-haiku-4-5-20251001". */
  model: string;
  thinking: boolean;
  createdAt: string;
  messages: Message[];
}

export type ConversationSummary = Omit<Conversation, "messages">;

export interface ConversationUpdate {
  name?: string;
  personality?: string;
  model?: string;
  thinking?: boolean;
}

// Applied to conversations created before model/thinking existed — keeps
// old records loadable without a migration step.
export const DEFAULT_MODEL = "anthropic:claude-haiku-4-5-20251001";
export const DEFAULT_THINKING = false;

/**
 * One file per conversation under a dedicated subdirectory, same atomic-write
 * shape as MessageStore. Conversations are looked up by name as well as id —
 * callers (a persona's own poll loop) create-or-fetch by name so they don't
 * need to persist an id anywhere themselves.
 *
 * PoC scope: `list()` reads every conversation file to build the summary
 * list (no separate index) — fine at the handful of conversations this is
 * expected to hold; revisit if that stops being true.
 */
export class ConversationStore {
  private readonly dir: string;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "conversations");
  }

  private filePath(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  async list(): Promise<ConversationSummary[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const summaries: ConversationSummary[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const conversation = await this.readFile(path.join(this.dir, entry));
      if (!conversation) continue;
      const { messages: _messages, ...summary } = conversation;
      summaries.push(summary);
    }
    return summaries;
  }

  async get(id: string): Promise<Conversation | null> {
    return this.readFile(this.filePath(id));
  }

  async findByName(name: string): Promise<Conversation | null> {
    const summaries = await this.list();
    const match = summaries.find((c) => c.name === name);
    return match ? this.get(match.id) : null;
  }

  async create(
    name: string,
    personality: string,
    model: string = DEFAULT_MODEL,
    thinking: boolean = DEFAULT_THINKING,
  ): Promise<Conversation> {
    const conversation: Conversation = {
      id: randomUUID(),
      name,
      personality,
      model,
      thinking,
      createdAt: new Date().toISOString(),
      messages: [],
    };
    await this.writeFile(conversation);
    return conversation;
  }

  async appendMessage(id: string, sender: string, text: string): Promise<Message | null> {
    const message: Message = { id: randomUUID(), sender, text, ts: new Date().toISOString() };
    const write = this.writeQueue.then(() => this.appendWith(id, message));
    this.writeQueue = write.catch(() => undefined);
    return write;
  }

  /** Partial update — only the fields present in `updates` change. Used by
   * the PATCH route (a human editing a conversation's settings later) and
   * to backfill model/thinking on conversations created before those
   * fields existed. */
  async update(id: string, updates: ConversationUpdate): Promise<Conversation | null> {
    const write = this.writeQueue.then(() => this.updateWith(id, updates));
    this.writeQueue = write.catch(() => undefined);
    return write;
  }

  private async updateWith(id: string, updates: ConversationUpdate): Promise<Conversation | null> {
    const conversation = await this.get(id);
    if (!conversation) return null;
    Object.assign(conversation, updates);
    await this.writeFile(conversation);
    return conversation;
  }

  private async appendWith(id: string, message: Message): Promise<Message | null> {
    const conversation = await this.get(id);
    if (!conversation) return null;
    conversation.messages.push(message);
    await this.writeFile(conversation);
    return message;
  }

  private async readFile(filePath: string): Promise<Conversation | null> {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const conversation = JSON.parse(raw) as Conversation;
      conversation.model ??= DEFAULT_MODEL;
      conversation.thinking ??= DEFAULT_THINKING;
      return conversation;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  private async writeFile(conversation: Conversation): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const target = this.filePath(conversation.id);
    const tmpPath = `${target}.${randomUUID()}.tmp`;
    const handle = await fs.open(tmpPath, "w", 0o600);
    try {
      await handle.writeFile(JSON.stringify(conversation, null, 2));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmpPath, target);
  }
}
