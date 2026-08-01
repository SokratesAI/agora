import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Capability grants (Decisions/0002 + 0007) — enforced by the runner
 * server-side from this record for every invocation, never from client
 * payloads. Defaults per Edvard's explicit triage calls. */
export interface PersonaCapabilities {
  webSearch: boolean;
  vaultRead: boolean;
  vaultWrite: boolean;
  codeExecution: boolean;
  /** Read-only cluster introspection via the runner's kubectl_read tool
   * (get/describe/logs/top; Secrets refused at both the tool and RBAC
   * level). Issues.md #3. */
  kubectlRead: boolean;
  /** Read-only GitHub queries via the runner's github_read tool
   * (issues/PRs/runs/releases; GET-only for `gh api`). Issues.md #3. */
  githubRead: boolean;
  /** Lets the persona create new personas/conversations/heartbeats/workflows
   * via the runner's create_* tools (calling the internal app's create
   * routes, ADR 0007) — platform-management, not just vault/cluster/web
   * reads, so this defaults off unlike webSearch/vaultRead. */
  manageAgora: boolean;
  /** Lets the persona open real GitHub PRs via the runner's create_pr tool
   * (GitHub REST API directly — no git binary, no local clone — mirrors
   * platform-workers/pr-drone's pattern). Uses the shared bot account, not
   * a per-repo allowlist: any repo the bot token can reach. Separate from
   * githubMerge on purpose — same separation of duties a human PR review
   * gives: a persona can be allowed to propose changes without also being
   * allowed to merge its own (or anyone else's) work. */
  githubWrite: boolean;
  /** Lets the persona merge an existing PR via the runner's merge_pr tool.
   * The runner refuses unless every check-run on the PR's head commit is
   * green — deliberately no "did this bot/persona open it" check, since
   * every agent shares the same GitHub account so that distinction carries
   * no signal. */
  githubMerge: boolean;
  /** Lets the persona run arbitrary shell commands in the runner pod via
   * its terminal_exec tool (bash -lc, unrestricted — no verb/flag allowlist
   * like kubectlRead/githubRead). Issues.md #1: the runner's purpose-built
   * tools (vault/kubectl/github) have bugs and gaps of their own; this lets
   * a persona skip them and fix things directly instead of waiting on a
   * human to ship a runner change. Same pod as every other capability here,
   * so it carries the union of this pod's kubectl RBAC and GitHub bot token
   * — the highest blast-radius capability in this list. Defaults off. */
  terminalExec: boolean;
}

export interface Persona {
  id: string;
  name: string;
  personality: string;
  /** "<provider>:<model id>" */
  model: string;
  thinking: boolean;
  /** claude-cli personas only (2026-08-01): requests the bridge's full
   * known-tool denylist for this persona's calls -- unrestricted (false)
   * is the default, same as an interactive Claude Code session; Agora's
   * usual capability checkboxes don't apply to this provider at all (its
   * tools, if any, live entirely inside the CLI's own session). Ignored
   * by every other provider. */
  claudeCliRestricted?: boolean;
  /** claude-cli personas only (2026-08-01): when true, the bridge never
   * reads or writes this conversation's stored CLI session -- every turn
   * gets the full system+prompt and starts fresh, with no --resume. Built
   * for the Evolve workflow's steps, which should only see their own
   * prompt's context, not an ever-accumulating session across cycles
   * (cross-cycle memory belongs in the vault journal, not CLI replay).
   * Off by default -- an ordinary chat persona wants turn-to-turn
   * continuity, the opposite of this. Ignored by every other provider. */
  claudeCliStateless?: boolean;
  capabilities: PersonaCapabilities;
  /** Cross-conversation memory (Architecture §2) — editable in the Studio
   * and writable by the persona itself via the runner's save_memory tool. */
  sharedMemory: string;
  /** Templates are ordinary editable records, not code constants —
   * critique finding #10. Never auto-attached to conversations. */
  isTemplate: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PersonaUpdate {
  name?: string;
  personality?: string;
  model?: string;
  thinking?: boolean;
  claudeCliRestricted?: boolean;
  claudeCliStateless?: boolean;
  capabilities?: Partial<PersonaCapabilities>;
  sharedMemory?: string;
  isTemplate?: boolean;
}

export const DEFAULT_CAPABILITIES: PersonaCapabilities = {
  webSearch: true,
  vaultRead: true,
  vaultWrite: false,
  codeExecution: false,
  kubectlRead: false,
  githubRead: false,
  manageAgora: false,
  githubWrite: false,
  githubMerge: false,
  terminalExec: false,
};

/** Same one-file-per-record, atomic-write + write-queue shape as
 * ConversationStore. */
export class PersonaStore {
  private readonly dir: string;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "personas");
  }

  private filePath(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  async list(): Promise<Persona[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const personas: Persona[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const persona = await this.readFile(path.join(this.dir, entry));
      if (persona) personas.push(persona);
    }
    personas.sort((a, b) => a.name.localeCompare(b.name));
    return personas;
  }

  async get(id: string): Promise<Persona | null> {
    return this.readFile(this.filePath(id));
  }

  async findByName(name: string): Promise<Persona | null> {
    const personas = await this.list();
    return personas.find((p) => p.name === name) ?? null;
  }

  async create(fields: {
    name: string;
    personality?: string;
    model: string;
    thinking?: boolean;
    claudeCliRestricted?: boolean;
    claudeCliStateless?: boolean;
    capabilities?: Partial<PersonaCapabilities>;
    sharedMemory?: string;
    isTemplate?: boolean;
  }): Promise<Persona> {
    const now = new Date().toISOString();
    const persona: Persona = {
      id: randomUUID(),
      name: fields.name,
      personality: fields.personality ?? "",
      model: fields.model,
      thinking: fields.thinking ?? false,
      ...(fields.claudeCliRestricted !== undefined ? { claudeCliRestricted: fields.claudeCliRestricted } : {}),
      ...(fields.claudeCliStateless !== undefined ? { claudeCliStateless: fields.claudeCliStateless } : {}),
      capabilities: { ...DEFAULT_CAPABILITIES, ...fields.capabilities },
      sharedMemory: fields.sharedMemory ?? "",
      isTemplate: fields.isTemplate ?? false,
      createdAt: now,
      updatedAt: now,
    };
    await this.enqueue(() => this.writeFile(persona));
    return persona;
  }

  async update(id: string, updates: PersonaUpdate): Promise<Persona | null> {
    return this.enqueue(async () => {
      const persona = await this.get(id);
      if (!persona) return null;
      const { capabilities, ...rest } = updates;
      Object.assign(persona, rest);
      if (capabilities) persona.capabilities = { ...persona.capabilities, ...capabilities };
      persona.updatedAt = new Date().toISOString();
      await this.writeFile(persona);
      return persona;
    });
  }

  /** Clone-for-divergence (Architecture §2 / Decisions/0004 lineage of the
   * edit-vs-clone rule): editing a persona changes it everywhere it's
   * used; cloning is how one conversation gets its own variant. */
  async clone(id: string, newName?: string): Promise<Persona | null> {
    const source = await this.get(id);
    if (!source) return null;
    return this.create({
      name: newName ?? `${source.name} (copy)`,
      personality: source.personality,
      model: source.model,
      thinking: source.thinking,
      claudeCliRestricted: source.claudeCliRestricted,
      claudeCliStateless: source.claudeCliStateless,
      capabilities: { ...source.capabilities },
      sharedMemory: source.sharedMemory,
      isTemplate: false,
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

  private async readFile(filePath: string): Promise<Persona | null> {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const persona = JSON.parse(raw) as Persona;
      persona.capabilities = { ...DEFAULT_CAPABILITIES, ...persona.capabilities };
      persona.sharedMemory ??= "";
      persona.isTemplate ??= false;
      return persona;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  private async writeFile(persona: Persona): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const target = this.filePath(persona.id);
    const tmpPath = `${target}.${randomUUID()}.tmp`;
    const handle = await fs.open(tmpPath, "w", 0o600);
    try {
      await handle.writeFile(JSON.stringify(persona, null, 2));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmpPath, target);
  }
}
