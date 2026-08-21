import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Metadata for one uploaded file (Issues.md: "Sending files, images...
 * does not work"). Content lives in AttachmentStore, keyed by `id`; a
 * message only carries the metadata, never the bytes. */
export interface MessageAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

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
  /** "Forget this" (Feature-Ideas #24) — excluded from every LLM context
   * the runner builds, still rendered (struck through) in the UI. */
  forgotten?: boolean;
  /** Files/images sent with this message — undefined/empty for the
   * overwhelming majority of messages, which carry no attachment. */
  attachments?: MessageAttachment[];
  /** A runner-generated control-plane notice (e.g. the auto-pause
   * message), not real conversation content -- excluded from every LLM
   * context the runner builds, same as `forgotten`, but still rendered
   * normally in the UI (Edvard should see it; the model shouldn't).
   * 2026-07-24: found live that without this, a persona asked "what's
   * this?" about an unrelated image answered about the PRECEDING
   * auto-pause notice instead, having read it as if it were a real
   * previous reply. Sender-name matching ("Agora") can't distinguish
   * this from a real persona literally named Agora (migrate.ts creates
   * exactly one, for the legacy Main thread) -- needs its own flag. */
  system?: boolean;
  /** Inline capability-use indicator (Activity feed made inline in-chat,
   * 2026-07-24) -- posted the moment a persona's tool call completes, same
   * shape as AuditEntry minus ts/personaName (those are just `ts`/`sender`
   * on the Message itself). Excluded from every LLM context AND from
   * turn-taking (decide_turn/consecutive_ai_turns), same as `system`, but
   * for a stronger reason: it isn't conversation content at all, just a UI
   * event marker -- a persona must never see its own or another's tool use
   * reported back as if it were something someone *said*. Rendered as a
   * clickable chip, not a text bubble; before/after (vault_write only)
   * feed the same diff view as the standalone Activity tab. */
  activity?: {
    capability: string;
    detail: string;
    before?: string;
    after?: string;
    /** Pairs the chip written when a tool call starts with the one written
     * when it returns. The client renders the pair as a single chip, so a
     * `pytest` still appears the moment it is launched and fills in its
     * output four minutes later, in place. */
    toolUseId?: string;
    output?: string;
    isError?: boolean;
  };
  /** Extended-thinking chunk (2026-07-31) -- a persona's own thought-summary
   * text (Anthropic's native thinking blocks; Gemini's when includeThoughts
   * is on), not something anyone "said". Excluded from every LLM context
   * the runner builds and from turn-taking, same as `system`/`activity` --
   * rendered distinctly (dimmed/collapsible) rather than as a normal reply
   * bubble. */
  thinking?: boolean;
}

/** Exactly one "curator" per conversation; listeners reply only when
 * @mentioned. Turn engine: Architecture §3. */
export interface PersonaLink {
  personaId: string;
  role: "curator" | "listener";
}

export interface Conversation {
  id: string;
  name: string;
  /** Legacy inline persona fields — superseded by `personas` after the
   * one-time startup migration (see migrate.ts); kept in the type so old
   * files parse and the migration can read them. API responses join the
   * curator persona's live values instead. */
  personality: string;
  model: string;
  thinking: boolean;
  /** Persona list — undefined only on records the startup migration
   * hasn't rewritten yet (its "unmigrated" signal, deliberately NOT
   * backfilled on read). */
  personas?: PersonaLink[];
  /** paused = the runner never replies here (also the auto-set state when
   * the AI-AI turn cap trips — Architecture §3). */
  status: "active" | "paused";
  /** Gemini rate-limit fallback mode (Agora Issues.md #2, made
   * per-conversation 2026-07-24). false (default): a fallback model's
   * answer is used for that one reply only — the conversation reverts to
   * trying its configured model again next turn ("regular" cascading).
   * true: once a fallback model answers, the runner PATCHes `model` onto
   * this conversation/persona so it STAYS on that model going forward
   * ("sticky") until changed back manually. Heartbeats always run
   * non-sticky regardless of this field (persona-runner enforces that,
   * not this store) — a scheduled proactive message shouldn't
   * permanently downgrade a persona other conversations also use. */
  stickyFallback: boolean;
  /** Per-conversation scratchpad, injected into the system prompt. */
  memory: string;
  /** Agent/search-only metadata — no human-facing editor (Decisions/0004). */
  tags: string[];
  /** Hidden from the default switcher view, not deleted — Phase 5's
   * archive action. */
  archived: boolean;
  /** Lineage id for fork grouping — equals `id` unless forked
   * (Decisions/0004 amendment: group by lineage, not persona). */
  rootId: string;
  /** Folder in the switcher (ideas.md #5), or absent for the top level.
   * Deliberately not validated against FolderStore on read: a folder
   * deleted out from under a conversation leaves it at the top level
   * rather than hiding it, which is the safe direction to fail in. */
  folderId?: string;
  forkedFrom?: { conversationId: string; messageId: string };
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
  personas?: PersonaLink[];
  status?: "active" | "paused";
  memory?: string;
  tags?: string[];
  rootId?: string;
  stickyFallback?: boolean;
  /** `null` moves the conversation back to the top level — distinct from
   * omitting the field, which leaves it where it is. */
  folderId?: string | null;
}

export interface SearchResult {
  conversationId: string;
  conversationName: string;
  message: Message;
}

// Applied to conversations created before model/thinking/archived existed —
// keeps old records loadable without a migration step.
//
// 2026-08-10: was `anthropic:claude-haiku-4-5-20251001`, i.e. any conversation
// created without an explicit model silently billed the prepaid metered API.
// Edvard's hard rule (issues.md) is that production never spends that balance,
// so the default is now the identical model reached through the subscription.
// Same model, same context window, no per-token cost.
export const DEFAULT_MODEL = "claude-cli:claude-haiku-4-5-20251001";
export const DEFAULT_THINKING = false;
export const DEFAULT_ARCHIVED = false;
export const DEFAULT_STICKY_FALLBACK = false;

/**
 * One file per conversation under a dedicated subdirectory, same atomic-write
 * shape as MessageStore. Conversations are looked up by name as well as id —
 * callers (a persona's own poll loop) create-or-fetch by name so they don't
 * need to persist an id anywhere themselves.
 *
 * `list()` builds the summary list from the conversation files themselves
 * rather than a separate index, but parses each one only when it has
 * changed on disk (see `summaryCache`) — so the steady-state cost is one
 * `stat` per conversation, not one full parse.
 */
export class ConversationStore {
  private readonly dir: string;
  private writeQueue: Promise<unknown> = Promise.resolve();
  /** Parsed summaries, keyed by file path, so `list()` only re-reads a
   * conversation that actually changed. The "revisit if that stops being
   * true" above came due: measured 2026-08-09, `list()` was parsing 66
   * files / 15.4 MB to recover 66 timestamps, ~1.2s per call. The runner
   * polls it every 5s and every UI action awaits it, which is where the
   * server's ~220m idle CPU was going.
   *
   * The cache key is the file's size and mtime, so an edit made by
   * anything at all invalidates it — `writeFile()` renames a freshly
   * written temp file into place, which always moves both. `writeFile()`
   * also drops the entry directly, so a write through this store is exact
   * regardless of the filesystem's mtime granularity. */
  private readonly summaryCache = new Map<string, { key: string; summary: ConversationSummary }>();

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
    const present = new Set<string>();
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const filePath = path.join(this.dir, entry);
      const summary = await this.readSummary(filePath);
      if (!summary) continue;
      present.add(filePath);
      // A fresh object per call, as callers have always got — the cached
      // one is this store's own copy and must not escape.
      summaries.push({ ...summary });
    }
    for (const cached of this.summaryCache.keys()) {
      if (!present.has(cached)) this.summaryCache.delete(cached);
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
    personas?: PersonaLink[],
  ): Promise<Conversation> {
    const id = randomUUID();
    const conversation: Conversation = {
      id,
      name,
      personality,
      model,
      thinking,
      ...(personas ? { personas } : {}),
      status: "active",
      memory: "",
      tags: [],
      archived: DEFAULT_ARCHIVED,
      stickyFallback: DEFAULT_STICKY_FALLBACK,
      rootId: id,
      createdAt: new Date().toISOString(),
      messages: [],
    };
    await this.writeFile(conversation);
    return conversation;
  }

  /** Fork (Decisions/0004): a full persisted copy of persona links +
   * messages up to (and including) `atMessageId`, same lineage `rootId`,
   * with optional extra personas injected as listeners in the same call
   * (the @mention flow's `addPersonas` fix from 0004's amendment). */
  async fork(
    id: string,
    atMessageId?: string,
    addPersonaIds?: string[],
  ): Promise<Conversation | null> {
    const source = await this.get(id);
    if (!source) return null;
    let messages = source.messages;
    if (atMessageId) {
      const index = source.messages.findIndex((m) => m.id === atMessageId);
      if (index === -1) return null;
      messages = source.messages.slice(0, index + 1);
    }
    const personas: PersonaLink[] = (source.personas ?? []).map((p) => ({ ...p }));
    for (const personaId of addPersonaIds ?? []) {
      if (!personas.some((p) => p.personaId === personaId)) {
        personas.push({ personaId, role: "listener" });
      }
    }
    // Name uniqueness is only cosmetic, but "X (fork)" colliding on a
    // second fork of the same thread would be confusing in the drawer.
    let name = `${source.name} (fork)`;
    for (let n = 2; await this.findByName(name); n++) name = `${source.name} (fork ${n})`;

    const newId = randomUUID();
    const forked: Conversation = {
      id: newId,
      name,
      personality: source.personality,
      model: source.model,
      thinking: source.thinking,
      ...(source.personas ? { personas } : {}),
      status: "active",
      memory: source.memory,
      tags: [...source.tags],
      archived: false,
      stickyFallback: source.stickyFallback,
      rootId: source.rootId,
      // A fork stays in its root's folder. Missed on the first pass, and the
      // drawer made it worse rather than obvious: it buckets by folder before
      // grouping by lineage, so a fork that fell out of the folder also lost
      // its "↳" and read as an unrelated conversation.
      ...(source.folderId ? { folderId: source.folderId } : {}),
      forkedFrom: {
        conversationId: source.id,
        messageId: atMessageId ?? source.messages[source.messages.length - 1]?.id ?? "",
      },
      createdAt: new Date().toISOString(),
      messages: messages.map((m) => ({ ...m })),
    };
    await this.enqueueWrite(forked);
    return forked;
  }

  /** Bulk-append used only by the one-time startup migration (importing
   * the legacy Main thread) — per-message appendMessage would re-read and
   * rewrite the file once per historical message. */
  async importMessages(id: string, imported: Message[]): Promise<boolean> {
    const write = this.writeQueue.then(async () => {
      const conversation = await this.get(id);
      if (!conversation) return false;
      conversation.messages.push(...imported.map((m) => ({ ...m })));
      await this.writeFile(conversation);
      return true;
    });
    this.writeQueue = write.catch(() => undefined);
    return write;
  }

  /** "Forget this" — toggles a message out of (or back into) every LLM
   * context the runner builds; the message itself stays. */
  async setForgotten(id: string, messageId: string, forgotten: boolean): Promise<boolean> {
    const write = this.writeQueue.then(async () => {
      const conversation = await this.get(id);
      if (!conversation) return false;
      const message = conversation.messages.find((m) => m.id === messageId);
      if (!message) return false;
      if (forgotten) message.forgotten = true;
      else delete message.forgotten;
      await this.writeFile(conversation);
      return true;
    });
    this.writeQueue = write.catch(() => undefined);
    return write;
  }

  private async enqueueWrite(conversation: Conversation): Promise<void> {
    const write = this.writeQueue.then(() => this.writeFile(conversation));
    this.writeQueue = write.catch(() => undefined);
    await write;
  }

  async appendMessage(
    id: string,
    sender: string,
    text: string,
    modelOverride?: string,
    attachments?: MessageAttachment[],
    system?: boolean,
    activity?: Message["activity"],
    thinking?: boolean,
  ): Promise<Message | null> {
    const message: Message = {
      id: randomUUID(),
      sender,
      text,
      ts: new Date().toISOString(),
      ...(modelOverride ? { modelOverride } : {}),
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
      ...(system ? { system: true } : {}),
      ...(activity ? { activity } : {}),
      ...(thinking ? { thinking: true } : {}),
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
    const { folderId, ...rest } = updates;
    Object.assign(conversation, rest);
    // `null` is "move to the top level", which is an absent key rather than
    // a stored null — Object.assign cannot express the difference.
    if (folderId === null) delete conversation.folderId;
    else if (folderId !== undefined) conversation.folderId = folderId;
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

  /** One conversation's summary, parsed only if the file changed since
   * the last call. Returns the cached instance; `list()` copies it. */
  private async readSummary(filePath: string): Promise<ConversationSummary | null> {
    let key: string;
    try {
      const stat = await fs.stat(filePath, { bigint: true });
      key = `${stat.size}:${stat.mtimeNs}`;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    const cached = this.summaryCache.get(filePath);
    if (cached && cached.key === key) return cached.summary;
    const conversation = await this.readFile(filePath);
    if (!conversation) return null;
    const { messages, ...rest } = conversation;
    const summary: ConversationSummary = {
      ...rest,
      lastMessageAt: messages.length > 0 ? messages[messages.length - 1].ts : null,
    };
    this.summaryCache.set(filePath, { key, summary });
    return summary;
  }

  private async readFile(filePath: string): Promise<Conversation | null> {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const conversation = JSON.parse(raw) as Conversation;
      // Empty, not DEFAULT_MODEL. A record written before `model` existed
      // has no model of its own, and since #65 that is a meaningful state:
      // the joined view resolves `conversation.model || persona.model`, so
      // an empty string is what lets a legacy conversation fall back to its
      // curator persona. Backfilling a concrete default here instead pinned
      // every one of them to hardcoded haiku before the fallback could ever
      // see them — and did it silently, because the field looked populated.
      // Every conversation created since the create route started copying
      // the persona's model has a real value here and is untouched by this.
      conversation.model ??= "";
      conversation.thinking ??= DEFAULT_THINKING;
      conversation.archived ??= DEFAULT_ARCHIVED;
      conversation.status ??= "active";
      conversation.memory ??= "";
      conversation.tags ??= [];
      conversation.stickyFallback ??= DEFAULT_STICKY_FALLBACK;
      conversation.rootId ??= conversation.id;
      // Deliberately NOT backfilling `personas` — its absence is how the
      // startup migration recognizes an unmigrated record (critique #7:
      // no record creation as a side effect of reads).
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
    this.summaryCache.delete(target);
  }
}
