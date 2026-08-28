import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Which routes of the public app anything actually calls, and who calls them.
 *
 * Written for one decision: issue #119 asks whether `agora/public/` — 4,702
 * lines of front end that Nova's own site has replaced — can be deleted. The
 * analysis behind that answer is a grep of route names across two repos, which
 * cannot see a caller living anywhere else. A week of real traffic can.
 *
 * Nothing already here answers it, measured against the live pod on
 * 2026-08-28. `http_server_duration_count` on :9464 carries method, status,
 * scheme and host and **no `http.route` label**, so it separates the owner's
 * phone from cluster traffic and says nothing about which path either asked
 * for. Prometheus does scrape that endpoint and keeps 7 days of it, but
 * `prometheus.infra.svc.cluster.local:9090` answers neither of Nova's two
 * shells — a counter shipped only there is a measurement that cannot be read
 * back, which is the whole failure this is meant to close.
 *
 * So: counts in memory, an aggregate on the same disk as every other store,
 * and `GET /route-usage` to read it. It records the route *template*, not the
 * URL — `/conversations/:id`, never the id — so nothing user-typed and no
 * query string is retained. A request no route matched has no template, so its
 * path is redacted instead: see `redactPath` for exactly what survives. The user-agent string is kept verbatim (truncated)
 * because it is the one field that distinguishes a browser from the runner's
 * urllib, which is the actual question being asked.
 */
export interface RouteUsageEntry {
  /** `GET /conversations/:id` for a matched route, `GET /app.js` for anything
   * express.static or a 404 handled — those carry no route template and are
   * exactly the front-end asset traffic this is trying to see. */
  key: string;
  count: number;
  /** No route template matched: a static file, or a 404. */
  unmatched: boolean;
  firstSeen: string;
  lastSeen: string;
  /** user-agent → count. `(none)` when the caller sent none. */
  agents: Record<string, number>;
  /** HTTP status → count, so a route that only ever 404s is visible as one. */
  statuses: Record<string, number>;
}

interface Persisted {
  startedAt: string;
  /** Keys beyond MAX_KEYS that were folded into `(overflow)`. */
  overflowKeys: string[];
  entries: RouteUsageEntry[];
}

/**
 * Three caps, and each one bounds a file that is rewritten on a timer rather
 * than trimming something worth keeping.
 *
 * `MAX_KEYS` is the one that matters: an unmatched request contributes its
 * raw path, and a scanner asking for 10,000 random URLs would otherwise put
 * 10,000 keys in a JSON file this rewrites every 30 seconds. The public app
 * has ~60 routes and `public/` has ~15 assets, so 400 is several times the
 * real population. Nothing is dropped silently — a key past the cap is counted
 * under `(overflow)` and its name is listed in `overflowKeys`, so a reader can
 * see the cap was reached and what fell into it. The bucket is one entry
 * beyond the cap rather than displacing a named one, so the file holds at most
 * MAX_KEYS + 1 keys.
 */
const MAX_KEYS = 400;
/** Distinct user-agents per key. A phone, the runner, a health probe and a
 * couple of browsers is the real population; the rest fold into `(other)`. */
const MAX_AGENTS_PER_KEY = 12;
/** Long enough for a full mobile Chrome user-agent (~122 chars); anything
 * past it is a caller trying to fill the file. */
const MAX_AGENT_CHARS = 160;
/** A raw path only appears here when nothing matched, so it is attacker
 * controlled. Long enough for every asset in `public/`. */
const MAX_PATH_CHARS = 120;
/** Names in `overflowKeys` are kept only so the cap is legible, not as data. */
const MAX_OVERFLOW_NAMES = 50;

/**
 * How long counts may sit only in memory. Writing on every request would put
 * an fsync in front of the owner's phone for a number that is read once a week;
 * batching means an unclean kill loses at most this much. That is acceptable
 * for a seven-day aggregate and would not be for an audit trail, which is why
 * this is a separate store rather than rows in AuditStore (whose 500-entry cap
 * one day of this traffic would empty).
 */
const FLUSH_MS = 30_000;

const OVERFLOW_KEY = "(overflow)";
const OTHER_AGENT = "(other)";
const NO_AGENT = "(none)";

export class RouteUsageStore {
  private readonly file: string;
  private readonly flushMs: number;
  private entries = new Map<string, RouteUsageEntry>();
  private overflowKeys = new Set<string>();
  private startedAt = new Date().toISOString();
  private loaded = false;
  private timer: NodeJS.Timeout | null = null;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string, flushMs: number = FLUSH_MS) {
    this.file = path.join(dataDir, "route-usage.json");
    this.flushMs = flushMs;
  }

  /**
   * Read what previous pods counted. Called once before the listener opens —
   * the process is the only writer, so after this the in-memory map is
   * authoritative and a flush can write it whole. Without it every deploy
   * would reset the week, and this pod is redeployed several times a day.
   */
  async load(): Promise<void> {
    this.loaded = true;
    let raw: string;
    try {
      raw = await fs.readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    let parsed: Persisted;
    try {
      parsed = JSON.parse(raw) as Persisted;
    } catch {
      // A truncated file loses the window rather than the pod: this is an
      // aggregate, and refusing to start over it would be the wrong trade.
      return;
    }
    if (!Array.isArray(parsed.entries)) return;
    if (typeof parsed.startedAt === "string") this.startedAt = parsed.startedAt;
    for (const name of Array.isArray(parsed.overflowKeys) ? parsed.overflowKeys : []) {
      if (typeof name === "string") this.overflowKeys.add(name);
    }
    for (const entry of parsed.entries) {
      if (!entry || typeof entry.key !== "string") continue;
      this.entries.set(entry.key, {
        key: entry.key,
        count: typeof entry.count === "number" ? entry.count : 0,
        unmatched: entry.unmatched === true,
        firstSeen: typeof entry.firstSeen === "string" ? entry.firstSeen : this.startedAt,
        lastSeen: typeof entry.lastSeen === "string" ? entry.lastSeen : this.startedAt,
        agents: isCountMap(entry.agents) ? { ...entry.agents } : {},
        statuses: isCountMap(entry.statuses) ? { ...entry.statuses } : {},
      });
    }
  }

  /**
   * @param routeTemplate the matched express route (`/conversations/:id`), or
   *   undefined when nothing matched — a static asset or a 404.
   * @param rawPath `req.path`, used only when `routeTemplate` is undefined.
   */
  record(
    method: string,
    routeTemplate: string | undefined,
    rawPath: string,
    userAgent: string | undefined,
    statusCode: number,
  ): void {
    const unmatched = routeTemplate === undefined;
    const target = unmatched ? redactPath(rawPath) : routeTemplate;
    const wanted = `${method} ${target}`;
    const now = new Date().toISOString();

    let entry = this.entries.get(wanted);
    if (!entry) {
      if (this.entries.size >= MAX_KEYS) {
        if (this.overflowKeys.size < MAX_OVERFLOW_NAMES) this.overflowKeys.add(wanted);
        entry = this.entries.get(OVERFLOW_KEY);
        if (!entry) {
          entry = blank(OVERFLOW_KEY, true, now);
          this.entries.set(OVERFLOW_KEY, entry);
        }
      } else {
        entry = blank(wanted, unmatched, now);
        this.entries.set(wanted, entry);
      }
    }

    entry.count += 1;
    entry.lastSeen = now;
    bump(entry.statuses, String(statusCode), Number.POSITIVE_INFINITY, OTHER_AGENT);
    const agent = userAgent ? userAgent.slice(0, MAX_AGENT_CHARS) : NO_AGENT;
    bump(entry.agents, agent, MAX_AGENTS_PER_KEY, OTHER_AGENT);

    this.scheduleFlush();
  }

  /** Newest counts, busiest first. */
  snapshot(): { startedAt: string; overflowKeys: string[]; entries: RouteUsageEntry[] } {
    return {
      startedAt: this.startedAt,
      overflowKeys: [...this.overflowKeys],
      entries: [...this.entries.values()]
        .map((e) => ({ ...e, agents: { ...e.agents }, statuses: { ...e.statuses } }))
        .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)),
    };
  }

  /** Write now rather than on the timer. Tests and shutdown call this. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const write = this.writeQueue.then(() => this.writeFile());
    this.writeQueue = write.catch(() => undefined);
    return write;
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    // `unref` so a pod with no traffic still exits on SIGTERM, and so a test
    // that records without flushing does not hold vitest open.
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.flushMs);
    this.timer.unref?.();
  }

  private async writeFile(): Promise<void> {
    if (!this.loaded) return; // never overwrite a file we have not read
    const payload: Persisted = {
      startedAt: this.startedAt,
      overflowKeys: [...this.overflowKeys],
      entries: [...this.entries.values()],
    };
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmpPath = `${this.file}.${randomUUID()}.tmp`;
    const handle = await fs.open(tmpPath, "w", 0o600);
    try {
      await handle.writeFile(JSON.stringify(payload, null, 2));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmpPath, this.file);
  }
}

/**
 * An unmatched path is whatever the caller sent, so it cannot be stored raw.
 * Express leaves `req.route` unset when the *method* does not match as well as
 * when the path does not, so `PUT /conversations/<real id>` from a stale
 * client — the exact caller this whole store exists to find — lands here
 * carrying a real conversation id.
 *
 * The rule: keep the first segment, which is a collection name in every route
 * this app has and never an id, and replace every later segment with `*`
 * unless it carries a file extension. That keeps the only thing being
 * measured — `/app.js`, `/assets/main.css`, whether anything still fetches
 * `public/` — and turns `/conversations/<id>` into `/conversations/*`, which
 * still says a stale client is calling that API without saying what it asked
 * for.
 */
export function redactPath(rawPath: string): string {
  // A path always starts with "/", so split() yields a leading "" that is the
  // separator, not a segment. Keeping it is what makes the join round-trip.
  const parts = rawPath.slice(0, MAX_PATH_CHARS).split("/");
  let seen = 0;
  return parts
    .map((seg) => {
      if (seg === "") return seg;
      seen += 1;
      if (seen === 1) return /^[A-Za-z0-9._-]{1,40}$/.test(seg) ? seg : "*";
      return seg.includes(".") && /^[A-Za-z0-9._-]{1,40}$/.test(seg) ? seg : "*";
    })
    .join("/");
}

function blank(key: string, unmatched: boolean, now: string): RouteUsageEntry {
  return { key, count: 0, unmatched, firstSeen: now, lastSeen: now, agents: {}, statuses: {} };
}

/** Adds one to `map[name]`, folding into `overflowName` once `max` distinct
 * names are held — so the count survives even when the name does not. */
function bump(map: Record<string, number>, name: string, max: number, overflowName: string): void {
  if (map[name] === undefined && Object.keys(map).length >= max) {
    map[overflowName] = (map[overflowName] ?? 0) + 1;
    return;
  }
  map[name] = (map[name] ?? 0) + 1;
}

function isCountMap(value: unknown): value is Record<string, number> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
