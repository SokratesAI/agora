import { describe, it, expect } from "vitest";
import { MODEL_CATALOG } from "./models.js";
import { DEFAULT_MODEL } from "./chat/conversation-store.js";

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

  // 2026-08-10, Edvard's hard rule in issues.md: "We must never use the
  // metered api for other than testing... We only use the subscription based
  // model for production code!" These pin the two halves of that — which
  // models cost money, and that nothing reaches one of them by default.
  it("marks every raw-API Anthropic model as metered and no CLI model as metered", () => {
    for (const model of MODEL_CATALOG) {
      if (model.provider === "anthropic") expect(model.metered).toBe(true);
      if (model.provider === "claude-cli") expect(model.metered).toBeUndefined();
    }
  });

  it("defaults new conversations to a model that is not metered", () => {
    // This is the one that actually had teeth: DEFAULT_MODEL used to be
    // `anthropic:claude-haiku-4-5-20251001`, so any conversation created
    // without an explicit model silently billed the prepaid balance.
    // conversation-store.test.ts compares against the DEFAULT_MODEL symbol,
    // so it passes whatever the value is and cannot catch a regression here.
    const chosen = MODEL_CATALOG.find((m) => m.id === DEFAULT_MODEL);
    expect(chosen).toBeDefined();
    expect(chosen?.metered).toBeUndefined();
  });
});
