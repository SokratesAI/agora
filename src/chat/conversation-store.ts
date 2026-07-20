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

export interface Conversation {
  id: string;
  name: string;
  personality: string;
  /** "<provider>:<model id>", e.g. "anthropic:claude-haiku-4-5-20251001". */
  model: string;
  thinking: boolean;
  /** Hidden from the default switcher view, not deleted — Phase 5's
   * archive action. */
  archived: boolean;
  createdAt: string;
  messages: Message[];
}

export type ConversationSummary = Omit<Conversation, "messages"> & {
  /** Timestamp of the last message, or null if none yet — drives the
   * switcher's activity sort (Decisions/0004: no manual pin). */
  lastMessageAt: string | null;
};

export interface ConversationUpdate {
  name?: string;
  personality?: string;
  model?: string;
  thinking?: boolean;
  archived?: boolean;
}

export interface SearchResult {
  conversationId: string;
  conversationName: string;
  message: Message;
}

// Applied to conversations created before model/thinking/archived existed —
// keeps old records loadable without a migration step.
export const DEFAULT_MODEL = "anthropic:claude-haiku-4-5-20251001";
export const DEFAULT_THINKING = false;
export const DEFAULT_ARCHIVED = false;

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
      const { messages, ...summary } = conversation;
      const lastMessageAt = messages.length > 0 ? messages[messages.length - 1].ts : null;
      summaries.push({ ...summary, lastMessageAt });
    }
    // Most recently active first; conversations with no messages yet sort
    // last rather than by creation order (Decisions/0004).
    summaries.sort((a, b) => {
      if (a.lastMessageAt === b.lastMessageAt) return 0;
      if (a.lastMessageAt === null) return 1;
      if (b.lastMessageAt === null) return -1;
      return b.lastMessageAt.localeCompare(a.lastMessageAt);
    });
    return summaries;
  }

  /** Case-insensitive substring match over every conversation's message
   * text. Reads every conversation file, same PoC-scale tradeoff list()
   * already accepts — fine at a handful of conversations. */
  async search(query: string): Promise<SearchResult[]> {
    const needle = query.toLowerCase();
    const results: SearchResult[] = [];
    for (const summary of await this.list()) {
      const conversation = await this.get(summary.id);
      if (!conversation) continue;
      for (const message of conversation.messages) {
        if (message.text.toLowerCase().includes(needle)) {
          results.push({
            conversationId: conversation.id,
            conversationName: conversation.name,
            message,
          });
        }
      }
    }
    return results;
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
      archived: DEFAULT_ARCHIVED,
      createdAt: new Date().toISOString(),
      messages: [],
    };
    await this.writeFile(conversation);
    return conversation;
  }

  async appendMessage(
    id: string,
    sender: string,
    text: string,
    modelOverride?: string,
  ): Promise<Message | null> {
    const message: Message = {
      id: randomUUID(),
      sender,
      text,
      ts: new Date().toISOString(),
      ...(modelOverride ? { modelOverride } : {}),
    };
    const write = this.writeQueue.then(() => this.appendWith(id, message));
    this.writeQueue = write.catch(() => undefined);
    return write;
  }

  /** Retract a message (Phase 5). Regenerate reuses this on a persona's
   * own last reply — deleting it makes the conversation's last sender
   * Edvard again, so the runner's existing turn-taking rule regenerates
   * on its next poll without a separate regenerate endpoint. */
  async deleteMessage(id: string, messageId: string): Promise<boolean> {
    const write = this.writeQueue.then(() => this.deleteMessageWith(id, messageId));
    this.writeQueue = write.catch(() => undefined);
    return write;
  }

  private async deleteMessageWith(id: string, messageId: string): Promise<boolean> {
    const conversation = await this.get(id);
    if (!conversation) return false;
    const index = conversation.messages.findIndex((m) => m.id === messageId);
    if (index === -1) return false;
    conversation.messages.splice(index, 1);
    await this.writeFile(conversation);
    return true;
  }

  /** Edit-and-resend: changes a message's text and drops everything sent
   * after it in this conversation, so a stale reply doesn't linger next
   * to the edited question — the runner regenerates against the new text
   * on its next poll, same mechanism as deleteMessage(). */
  async editMessage(id: string, messageId: string, text: string): Promise<Message | null> {
    const write = this.writeQueue.then(() => this.editMessageWith(id, messageId, text));
    this.writeQueue = write.catch(() => undefined);
    return write;
  }

  private async editMessageWith(
    id: string,
    messageId: string,
    text: string,
  ): Promise<Message | null> {
    const conversation = await this.get(id);
    if (!conversation) return null;
    const index = conversation.messages.findIndex((m) => m.id === messageId);
    if (index === -1) return null;
    conversation.messages[index] = { ...conversation.messages[index], text };
    conversation.messages = conversation.messages.slice(0, index + 1);
    await this.writeFile(conversation);
    return conversation.messages[index];
  }

  /** Delete a whole conversation (Phase 5 — no DELETE existed before this). */
  async delete(id: string): Promise<boolean> {
    const write = this.writeQueue.then(() => this.deleteConversationWith(id));
    this.writeQueue = write.catch(() => undefined);
    return write;
  }

  private async deleteConversationWith(id: string): Promise<boolean> {
    try {
      await fs.unlink(this.filePath(id));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
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
      conversation.archived ??= DEFAULT_ARCHIVED;
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
