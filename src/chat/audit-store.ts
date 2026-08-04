import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Capability-usage audit (Architecture §5, ADR 0007's consequence note):
 * who used vault_write / ran a heartbeat, when, on what. Entries carry the
 * persona name the runner claims — acceptable while the runner is the only
 * agent caller, documented in ADR 0007 with a revisit trigger. */
export interface AuditEntry {
  ts: string;
  personaName: string;
  conversationId: string | null;
  capability: string;
  detail: string;
  /** Full file content before/after a vault_write, for the Activity diff
   * view. Undefined for every other capability. Capped by the caller
   * (CONTENT_CHARS_MAX below), not here — this store just persists what
   * it's given. */
  before?: string;
  after?: string;
  /** Live tool-use narration from a claude-cli persona: one entry per Read,
   * Bash, Grep… as the session runs. Retained on its own budget — see
   * MAX_EPHEMERAL_ENTRIES. */
  ephemeral?: boolean;
  /** Correlates the two halves of one narrated tool call: the entry written
   * when it starts (detail, no output) and the one written when it returns
   * (output, no detail). The client pairs them into a single chip; the
   * bridge sends both under the same id. Undefined for everything else. */
  toolUseId?: string;
  /** What the tool returned. Capped here rather than by the caller, unlike
   * before/after: this arrives from agora-claude-bridge over two hops and
   * is routinely enormous (one `cat` of a log), so the ceiling has to hold
   * even if a caller forgets it. */
  output?: string;
  /** The tool call failed — a non-zero exit, a missing file. Rendered as a
   * failed chip rather than a normal one. */
  isError?: boolean;
}

// Single JSON array capped to the newest MAX_ENTRIES — bounded by design,
// this is an operational trail, not the durable archive (that's
// Decisions/0003's backup once built).
const MAX_ENTRIES = 500;

// Narration chips get their own budget instead of competing for the one
// above, because the two classes differ in volume by two orders of
// magnitude. A capability audit is a handful of entries per day —
// vault_write with its before/after diff, merge_pr, a heartbeat. One
// claude-cli cycle emits up to TOOL_ACTIVITY_MAX_PER_CALL (400) chips,
// four times a day. Sharing a single count budget meant a single cycle
// evicted ~80% of the trail, so what survived was Nova's own `Bash` lines
// and nothing else: measured 2026-08-04, 448 of 500 slots held by one
// conversation. Nothing is lost by capping them separately — every chip is
// also appended to its conversation (server.ts POST /audit), which is
// durable and is where they are actually read.
//
// Sized at slightly more than one cycle's 400 so the whole of the most
// recent run is always visible, and no further: the two budgets together
// bound the file at 1000 entries, and append rewrites the whole file.
const MAX_EPHEMERAL_ENTRIES = 500;

// before/after content is the one field here that can be arbitrarily large
// (a whole vault file) — cap it independently of MAX_ENTRIES so one big
// note can't dominate the 500-entry budget's on-disk size.
export const CONTENT_CHARS_MAX = 20_000;

/** The retention policy: newest MAX_ENTRIES durable entries plus newest
 * MAX_EPHEMERAL_ENTRIES narration entries, left in their original
 * chronological order.
 *
 * Exported because this — not the file I/O around it — is the part with a
 * rule in it worth pinning down.
 */
export function trim(entries: AuditEntry[]): AuditEntry[] {
  let durable = 0;
  let ephemeral = 0;
  for (const entry of entries) {
    if (entry.ephemeral) ephemeral += 1;
    else durable += 1;
  }
  let dropDurable = Math.max(0, durable - MAX_ENTRIES);
  let dropEphemeral = Math.max(0, ephemeral - MAX_EPHEMERAL_ENTRIES);
  if (dropDurable === 0 && dropEphemeral === 0) return entries;
  // Oldest first, dropping only from whichever class is actually over its
  // budget — which is what stops a burst of chips evicting a vault_write.
  const kept: AuditEntry[] = [];
  for (const entry of entries) {
    if (entry.ephemeral) {
      if (dropEphemeral > 0) {
        dropEphemeral -= 1;
        continue;
      }
    } else if (dropDurable > 0) {
      dropDurable -= 1;
      continue;
    }
    kept.push(entry);
  }
  return kept;
}

export class AuditStore {
  private readonly filePath: string;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "audit.json");
  }

  async list(limit = 100): Promise<AuditEntry[]> {
    const entries = await this.readAll();
    return entries.slice(-limit).reverse();
  }

  async append(entry: Omit<AuditEntry, "ts">): Promise<AuditEntry> {
    const full: AuditEntry = { ts: new Date().toISOString(), ...entry };
    if (full.before !== undefined) full.before = full.before.slice(0, CONTENT_CHARS_MAX);
    if (full.after !== undefined) full.after = full.after.slice(0, CONTENT_CHARS_MAX);
    if (full.output !== undefined) full.output = full.output.slice(0, CONTENT_CHARS_MAX);
    const write = this.writeQueue.then(async () => {
      const entries = await this.readAll();
      entries.push(full);
      await this.persist(trim(entries));
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return full;
  }

  private async readAll(): Promise<AuditEntry[]> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return JSON.parse(raw) as AuditEntry[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  private async persist(entries: AuditEntry[]): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${randomUUID()}.tmp`;
    const handle = await fs.open(tmpPath, "w", 0o600);
    try {
      await handle.writeFile(JSON.stringify(entries, null, 2));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmpPath, this.filePath);
  }
}
