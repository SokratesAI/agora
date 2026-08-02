import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** A heartbeat is a trigger config bound to one conversation
 * (Decisions/0006) — the runner's poll loop evaluates `schedule`
 * (idempotently, from lastRunAt alone) and performs one curator-style turn
 * by `personaId` in `conversationId`, with `task` + fetched `vaultPaths`
 * content layered into that turn's context. */
export interface Heartbeat {
  id: string;
  name: string;
  personaId: string;
  conversationId: string;
  /** "daily@HH:MM" (Europe/Oslo) or "every@N[m|h]" — validated at the route. */
  schedule: string;
  task: string;
  /** Decisions/0009 — when set, firing runs this Workflow's steps
   * instead of a single curator turn. `personaId` is still required and
   * still validated, but is unused by the runner in this mode —
   * participants come from the bound conversation's own personas[]. */
  workflowId: string | null;
  /** Vault doc paths; trailing "/" = folder prefix. Fetched fresh at
   * trigger time, injected capped (~24k chars, Architecture §4). */
  vaultPaths: string[];
  enabled: boolean;
  /** "Run now" sets this; the runner clears it after the forced run. */
  forceRun: boolean;
  lastRunAt: string | null;
  /** One status line for the Studio list ("replied 214 chars", "failed:
   * ..."), written back by the runner. */
  lastResult: string | null;
  /** Workflow-mode only (2026-08-02): when true, the runner creates a
   * fresh conversation for every cycle instead of reusing `conversationId`
   * forever -- carries the same persona list forward, points this
   * heartbeat at the new one, and archives older cycle-conversations
   * beyond `conversationRetention`. Keeps the (verbose, tool-call-heavy)
   * per-cycle transcript bounded and human-browsable, same reasoning as
   * why the evolution journal is a curated summary and not the raw
   * transcript. Off by default -- an ordinary heartbeat wants its one
   * conversation to keep accumulating, same as before. */
  rotateConversationEachRun?: boolean;
  /** How many of the most recent rotated conversations to keep active;
   * older ones get archived (not deleted). Only meaningful when
   * `rotateConversationEachRun` is true; defaults to 5 if unset. */
  conversationRetention?: number;
  createdAt: string;
}

export interface HeartbeatUpdate {
  name?: string;
  personaId?: string;
  conversationId?: string;
  schedule?: string;
  task?: string;
  workflowId?: string | null;
  vaultPaths?: string[];
  enabled?: boolean;
  forceRun?: boolean;
  lastRunAt?: string | null;
  lastResult?: string | null;
  rotateConversationEachRun?: boolean;
  conversationRetention?: number;
}

export const SCHEDULE_RE = /^(daily@([01]?\d|2[0-3]):[0-5]\d|every@\d+[mh])$/;

export class HeartbeatStore {
  private readonly dir: string;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "heartbeats");
  }

  private filePath(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  async list(): Promise<Heartbeat[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const heartbeats: Heartbeat[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const heartbeat = await this.readFile(path.join(this.dir, entry));
      if (heartbeat) heartbeats.push(heartbeat);
    }
    heartbeats.sort((a, b) => a.name.localeCompare(b.name));
    return heartbeats;
  }

  async get(id: string): Promise<Heartbeat | null> {
    return this.readFile(this.filePath(id));
  }

  async create(fields: {
    name: string;
    personaId: string;
    conversationId: string;
    schedule: string;
    task?: string;
    workflowId?: string;
    vaultPaths?: string[];
    enabled?: boolean;
    rotateConversationEachRun?: boolean;
    conversationRetention?: number;
  }): Promise<Heartbeat> {
    const heartbeat: Heartbeat = {
      id: randomUUID(),
      name: fields.name,
      personaId: fields.personaId,
      conversationId: fields.conversationId,
      schedule: fields.schedule,
      task: fields.task ?? "",
      workflowId: fields.workflowId ?? null,
      vaultPaths: fields.vaultPaths ?? [],
      enabled: fields.enabled ?? true,
      forceRun: false,
      lastRunAt: null,
      lastResult: null,
      ...(fields.rotateConversationEachRun !== undefined
        ? { rotateConversationEachRun: fields.rotateConversationEachRun }
        : {}),
      ...(fields.conversationRetention !== undefined
        ? { conversationRetention: fields.conversationRetention }
        : {}),
      createdAt: new Date().toISOString(),
    };
    await this.enqueue(() => this.writeFile(heartbeat));
    return heartbeat;
  }

  async update(id: string, updates: HeartbeatUpdate): Promise<Heartbeat | null> {
    return this.enqueue(async () => {
      const heartbeat = await this.get(id);
      if (!heartbeat) return null;
      Object.assign(heartbeat, updates);
      await this.writeFile(heartbeat);
      return heartbeat;
    });
  }

  async delete(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      try {
        await fs.unlink(this.filePath(id));
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw err;
      }
    });
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(work);
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  private async readFile(filePath: string): Promise<Heartbeat | null> {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const heartbeat = JSON.parse(raw) as Heartbeat;
      heartbeat.workflowId ??= null;
      heartbeat.vaultPaths ??= [];
      heartbeat.enabled ??= true;
      heartbeat.forceRun ??= false;
      heartbeat.lastRunAt ??= null;
      heartbeat.lastResult ??= null;
      return heartbeat;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  private async writeFile(heartbeat: Heartbeat): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const target = this.filePath(heartbeat.id);
    const tmpPath = `${target}.${randomUUID()}.tmp`;
    const handle = await fs.open(tmpPath, "w", 0o600);
    try {
      await handle.writeFile(JSON.stringify(heartbeat, null, 2));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmpPath, target);
  }
}
