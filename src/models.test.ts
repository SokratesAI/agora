import { describe, it, expect } from "vitest";
import { MODEL_CATALOG } from "./models.js";

describe("MODEL_CATALOG", () => {
  it("gives every id a provider prefix matching its provider", () => {
    // `VALID_MODEL_IDS` in server.ts is built from these ids and the runner
    // splits on the prefix to route, so a mismatch here is a model that
    // shows up in the picker and then fails on use.
    for (const model of MODEL_CATALOG) {
      expect(model.id.startsWith(`${model.provider}:`)).toBe(true);
    }
  });

  it("has no duplicate ids", () => {
    const ids = MODEL_CATALOG.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("offers every anthropic model through the CLI as well", () => {
    // The claude-cli block documents itself as "same underlying models as
    // the anthropic: entries above", and that invariant had silently
    // broken: Fable 5 was reachable through the raw API but not through
    // the CLI, so no tool-using persona could be put on it at all.
    const cliIds = new Set(
      MODEL_CATALOG.filter((m) => m.provider === "claude-cli").map((m) =>
        m.id.slice("claude-cli:".length),
      ),
    );
    const missing = MODEL_CATALOG.filter((m) => m.provider === "anthropic")
      .map((m) => m.id.slice("anthropic:".length))
      .filter((bare) => !cliIds.has(bare));

    expect(missing).toEqual([]);
  });
});
