import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** One step of a Workflow (Decisions/0009). Executed by the runner as
 * `loopCount` rounds of round-robin turn-taking across the bound
 * conversation's own personas[] — never a new "who's on this" list. */
export interface Step {
  /** Additive — layered onto each participant's own personality for the
   * duration of this step only, never a replacement. */
  prompt: string;
  /** Fixed at authoring time, no runtime override (Decisions/0009 —
   * a multi-step workflow makes "which step does a bare int override"
   * ambiguous, so editing the step is the answer instead). */
  loopCount: number;
  /** Trailing "/" = folder (the runner's `scoped_write` tool locks the
   * first write's filename inside it); otherwise an exact file (every
   * write in the step targets exactly that file). Same "/" convention
   * `Heartbeat.vaultPaths` already uses. Required if `scoped_write` is
   * in `toolWhitelist`. */
  filepath?: string;
  /** Empty/unset = unrestricted (each participant's own capabilities
   * apply, unchanged). Non-empty = a hard allowlist of tool names for
   * this step only, enforced runner-side — never prompt-level trust. */
  toolWhitelist: string[];
  /** Workflow.id — this step runs another workflow's steps in place of
   * prompt/loop, in the same conversation with the same participants
   * (composition). Must not create a cycle — validated at save time. */
  workflowRef?: string;
}

export interface Workflow {
  id: string;
  name: string;
  description: string;
  steps: Step[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowUpdate {
  name?: string;
  description?: string;
  steps?: Step[];
}

/** Walks `workflowRef` chains starting from `steps` (the steps about to
 * be saved for `editingId`) through `workflows`; true if any chain would
 * eventually reach back to `editingId` — a cycle. Pure, no I/O, so it's
 * cheap to call on every create/update. */
export function wouldCreateCycle(
  workflows: Workflow[],
  editingId: string,
  steps: Step[],
): boolean {
  const byId = new Map(workflows.map((w) => [w.id, w]));
  const visit = (refs: string[], seen: Set<string>): boolean => {
    for (const ref of refs) {
      if (ref === editingId) return true;
      if (seen.has(ref)) continue;
      seen.add(ref);
      const target = byId.get(ref);
      if (!target) continue;
      const nextRefs = target.steps
        .map((s) => s.workflowRef)
        .filter((r): r is string => Boolean(r));
      if (visit(nextRefs, seen)) return true;
    }
    return false;
  };
  const directRefs = steps.map((s) => s.workflowRef).filter((r): r is string => Boolean(r));
  return visit(directRefs, new Set());
}

export class WorkflowStore {
  private readonly dir: string;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "workflows");
  }

  private filePath(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  async list(): Promise<Workflow[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const workflows: Workflow[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const workflow = await this.readFile(path.join(this.dir, entry));
      if (workflow) workflows.push(workflow);
    }
    workflows.sort((a, b) => a.name.localeCompare(b.name));
    return workflows;
  }

  async get(id: string): Promise<Workflow | null> {
    return this.readFile(this.filePath(id));
  }

  async create(fields: { name: string; description?: string; steps?: Step[] }): Promise<Workflow> {
    const now = new Date().toISOString();
    const workflow: Workflow = {
      id: randomUUID(),
      name: fields.name,
      description: fields.description ?? "",
      steps: fields.steps ?? [],
      createdAt: now,
      updatedAt: now,
    };
    await this.enqueue(() => this.writeFile(workflow));
    return workflow;
  }

  async update(id: string, updates: WorkflowUpdate): Promise<Workflow | null> {
    return this.enqueue(async () => {
      const workflow = await this.get(id);
      if (!workflow) return null;
      Object.assign(workflow, updates);
      workflow.updatedAt = new Date().toISOString();
      await this.writeFile(workflow);
      return workflow;
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

  private async readFile(filePath: string): Promise<Workflow | null> {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const workflow = JSON.parse(raw) as Workflow;
      workflow.steps ??= [];
      workflow.description ??= "";
      return workflow;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  private async writeFile(workflow: Workflow): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const target = this.filePath(workflow.id);
    const tmpPath = `${target}.${randomUUID()}.tmp`;
    const handle = await fs.open(tmpPath, "w", 0o600);
    try {
      await handle.writeFile(JSON.stringify(workflow, null, 2));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmpPath, target);
  }
}
