import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { WorkflowStore, wouldCreateCycle, type Workflow, type Step } from "./workflow-store.js";

describe("WorkflowStore", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  async function makeStore() {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-workflows-test-"));
    return new WorkflowStore(dir);
  }

  it("creates with sane defaults", async () => {
    const store = await makeStore();
    const workflow = await store.create({ name: "Discuss" });
    expect(workflow.description).toBe("");
    expect(workflow.steps).toEqual([]);
    expect(workflow.createdAt).toBe(workflow.updatedAt);
  });

  it("creates with steps and preserves them on reload", async () => {
    const store = await makeStore();
    const steps: Step[] = [
      { prompt: "Critique the prior turn.", loopCount: 3, toolWhitelist: ["vault_read", "web_search"] },
    ];
    const workflow = await store.create({ name: "Discuss", description: "critique loop", steps });
    const reloaded = await store.get(workflow.id);
    expect(reloaded?.steps).toEqual(steps);
  });

  it("update bumps updatedAt and preserves createdAt", async () => {
    const store = await makeStore();
    const workflow = await store.create({ name: "Plan" });
    await new Promise((r) => setTimeout(r, 5));
    const updated = await store.update(workflow.id, { description: "now with a description" });
    expect(updated?.createdAt).toBe(workflow.createdAt);
    expect(updated?.updatedAt).not.toBe(workflow.createdAt);
    expect(updated?.description).toBe("now with a description");
  });

  it("deletes and reports missing", async () => {
    const store = await makeStore();
    const workflow = await store.create({ name: "Exec" });
    expect(await store.delete(workflow.id)).toBe(true);
    expect(await store.delete(workflow.id)).toBe(false);
  });

  it("backfills steps/description for records written before those fields existed", async () => {
    const store = await makeStore();
    const workflow = await store.create({ name: "Old" });
    // Simulate an old on-disk record missing the newer fields entirely.
    const filePath = path.join(dir, "workflows", `${workflow.id}.json`);
    const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
    delete raw.steps;
    delete raw.description;
    await fs.writeFile(filePath, JSON.stringify(raw));
    const reloaded = await store.get(workflow.id);
    expect(reloaded?.steps).toEqual([]);
    expect(reloaded?.description).toBe("");
  });
});

describe("wouldCreateCycle", () => {
  function wf(id: string, refs: (string | undefined)[]): Workflow {
    return {
      id,
      name: id,
      description: "",
      steps: refs.map((r) => ({ prompt: "", loopCount: 1, toolWhitelist: [], workflowRef: r })),
      createdAt: "",
      updatedAt: "",
    };
  }

  it("detects a direct self-reference", () => {
    const steps: Step[] = [{ prompt: "", loopCount: 1, toolWhitelist: [], workflowRef: "a" }];
    expect(wouldCreateCycle([], "a", steps)).toBe(true);
  });

  it("detects an indirect cycle A -> B -> A", () => {
    const workflows = [wf("b", ["a"])];
    const steps: Step[] = [{ prompt: "", loopCount: 1, toolWhitelist: [], workflowRef: "b" }];
    expect(wouldCreateCycle(workflows, "a", steps)).toBe(true);
  });

  it("allows a non-cyclic chain A -> B -> C", () => {
    const workflows = [wf("b", ["c"]), wf("c", [])];
    const steps: Step[] = [{ prompt: "", loopCount: 1, toolWhitelist: [], workflowRef: "b" }];
    expect(wouldCreateCycle(workflows, "a", steps)).toBe(false);
  });

  it("allows a workflow with no references at all", () => {
    const steps: Step[] = [{ prompt: "hello", loopCount: 2, toolWhitelist: [] }];
    expect(wouldCreateCycle([], "a", steps)).toBe(false);
  });
});
