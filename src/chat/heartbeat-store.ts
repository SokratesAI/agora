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
  /** "daily@HH:MM" (Europe/Oslo), "every@N[m|h]", or "every@N[m|h]@HH:MM"
   * — validated at the route by isValidSchedule. */
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

const HHMM = "([01]?\\d|2[0-3]):[0-5]\\d";
/** Note that `cron@` is matched loosely here on purpose — the fields are
 * checked by isValidCron, not by this regex. So matching SCHEDULE_RE no
 * longer implies a schedule is valid; isValidSchedule is the only answer,
 * and it is what both routes call. */
export const SCHEDULE_RE = new RegExp(
  `^(daily@${HHMM}|every@\\d+[mh](@${HHMM})?|cron@.+)$`,
);

export const SCHEDULE_ERROR =
  "schedule must be daily@HH:MM, every@N[m|h], every@N[m|h]@HH:MM " +
  "(anchored — the interval must divide 24h evenly), or " +
  "cron@<minute hour day-of-month month day-of-week>";

/** Cron field bounds, in field order. Day-of-week runs to 7 because 0 and 7
 * both mean Sunday — the runner's parse_cron_field folds 7 back to 0. */
const CRON_BOUNDS: ReadonlyArray<readonly [number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

/** Whether one cron field parses, to exactly the grammar the runner accepts:
 * `*`, `N`, `a-b`, any of those with a `/step` suffix, comma-separated.
 *
 * This is a second implementation of agora-persona-runner's
 * parse_cron_field, and the two are only useful if this one is not looser —
 * anything accepted here reaches a runner that has to make sense of it. It is
 * deliberately a validator rather than a parser: it answers yes/no and never
 * has to expand a range, which is the half that would actually drift. */
function isValidCronField(field: string, index: number): boolean {
  const [low, high] = CRON_BOUNDS[index];
  const parts = field.split(",");
  return parts.every((part) => {
    const slash = part.indexOf("/");
    const spec = slash === -1 ? part : part.slice(0, slash);
    const stepText = slash === -1 ? "" : part.slice(slash + 1);
    if (slash !== -1 && !/^\d+$/.test(stepText)) return false;
    if (stepText && Number(stepText) < 1) return false;
    if (spec === "*") return true;
    const dash = spec.indexOf("-");
    if (dash === -1) {
      // A bare value with a step ("5/15") has no range to step through.
      return /^\d+$/.test(spec) && !stepText && inBounds(Number(spec), low, high);
    }
    const start = spec.slice(0, dash);
    const end = spec.slice(dash + 1);
    if (!/^\d+$/.test(start) || !/^\d+$/.test(end)) return false;
    return (
      inBounds(Number(start), low, high) &&
      inBounds(Number(end), low, high) &&
      Number(start) <= Number(end)
    );
  });
}

function inBounds(value: number, low: number, high: number): boolean {
  return Number.isInteger(value) && value >= low && value <= high;
}

/** Whether a bare 5-field cron expression (no "cron@" prefix) is valid. */
export function isValidCron(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5 || expr.trim() === "") return false;
  return fields.every((field, i) => isValidCronField(field, i));
}

/** An anchored interval ("every@6h@12:00" = 12:00, 18:00, 00:00, 06:00) only
 * has a stable meaning when the interval divides 24h. Each day lays its slots
 * out from the anchor, so with a non-dividing interval the two sides of
 * midnight disagree — "every@7h@12:00" is 05:00/12:00/19:00, but at 00:30 the
 * last slot reads as 22:00 the night before, which did not exist at 23:30, so
 * it fires an extra time every midnight. Rejecting it here is what lets the
 * runner keep that logic to three lines — see last_anchored_occurrence in
 * agora-persona-runner's turns.py. */
export function isValidSchedule(schedule: string): boolean {
  if (!SCHEDULE_RE.test(schedule)) return false;
  if (schedule.startsWith("cron@")) {
    return isValidCron(schedule.slice("cron@".length));
  }
  if (!schedule.startsWith("every@")) return true;
  const [amount, anchor] = schedule.slice("every@".length).split("@");
  const value = Number(amount.slice(0, -1));
  const minutes = amount.endsWith("h") ? value * 60 : value;
  // Zero is checked for every `every@` schedule, anchored or not. It used to
  // sit below the `anchor === undefined` return, so `every@0m` and `every@0h`
  // were accepted while `every@0m@12:00` was rejected -- and SCHEDULE_RE's
  // `\d+` matches `0` happily, so nothing else caught it. An accepted
  // `every@0m` gives the runner a zero interval, which makes its due check
  // `now >= lastRun` and therefore true on every pass of a poll loop that
  // ticks every POLL_INTERVAL_SECONDS (5 by default). One typo in this field
  // dispatches a persona every five seconds forever, against a metered
  // quota, with no error shown anywhere. Found from the runner side,
  // 2026-08-14; agora-persona-runner#166 makes the runner refuse to act on
  // it, but a schedule that silently never fires is its own bad failure and
  // the honest place to say no is here, at creation, where SCHEDULE_ERROR
  // already tells the caller what a schedule looks like.
  if (!(minutes > 0)) return false;
  if (anchor === undefined) return true;
  return 1440 % minutes === 0;
}

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
