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
}

// Single JSON array capped to the newest MAX_ENTRIES — bounded by design,
// this is an operational trail, not the durable archive (that's
// Decisions/0003's backup once built).
const MAX_ENTRIES = 500;

// before/after content is the one field here that can be arbitrarily large
// (a whole vault file) — cap it independently of MAX_ENTRIES so one big
// note can't dominate the 500-entry budget's on-disk size.
export const CONTENT_CHARS_MAX = 20_000;

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
    const write = this.writeQueue.then(async () => {
      const entries = await this.readAll();
      entries.push(full);
      await this.persist(entries.slice(-MAX_ENTRIES));
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
