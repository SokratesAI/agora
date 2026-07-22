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
}

export interface Persona {
  id: string;
  name: string;
  personality: string;
  /** "<provider>:<model id>" */
  model: string;
  thinking: boolean;
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
