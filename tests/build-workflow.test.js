// The build workflow must serialise pipelines per ref.
//
// `update-manifest` in .github/workflows/build.yaml is a blind `sed` of
// whichever image digest its own run produced, so two pipelines running in
// parallel deploy whichever one *finished last*, which is not the same as
// whichever commit is newest.
//
// Measured 2026-08-12 in agora-claude-bridge, which has the identical job:
// #41 and #40 merged four seconds apart, #40 was the newer commit, and #41's
// build pushed its digest one second later and overwrote it -- pinning the
// config repo to the commit before the endpoint #40 had just added. Both CI
// runs were green, the image built, ArgoCD synced, and the deployed pod
// served a 404 for a feature that was merged in main. Nothing reported an
// error anywhere.
//
// Scope: this guards *this repo's* build.yaml only. The Crossplane
// Composition that seeds new services got the same block separately;
// nothing automatically checks the two against each other.
//
// Parsed by hand rather than with a YAML library on purpose -- the only YAML
// parser in this tree is a transitive dependency of vitest, and a guard test
// that breaks when an unrelated package moves is worse than no guard.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WORKFLOW = resolve(__dirname, "..", ".github", "workflows", "build.yaml");

/** Lines of the top-level `concurrency:` mapping, comments and blanks dropped. */
function concurrencyBlock() {
  const lines = readFileSync(WORKFLOW, "utf8").split("\n");
  const start = lines.findIndex((l) => l === "concurrency:");
  if (start === -1) return null;
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) break; // dedented back to a top-level key
    body.push(line.trim());
  }
  return body;
}

function group() {
  return (concurrencyBlock() ?? []).find((l) => l.startsWith("group:"));
}

describe("build.yaml", () => {
  it("declares a concurrency group", () => {
    expect(
      concurrencyBlock(),
      "build.yaml declares no top-level concurrency group -- two pushes to " +
        "main run update-manifest in parallel and the last to finish wins, " +
        "not the newest commit",
    ).not.toBeNull();
    expect(group(), "concurrency block has no group").toBeDefined();
  });

  it("puts every ref that deploys into one lane", () => {
    // build-push runs for `main` AND for `v*` tags, and update-manifest
    // inherits that condition -- so those are two different refs writing the
    // same agora-config manifest.yaml. A per-ref group (which is what the
    // bridge and the runner correctly use, because neither builds tags)
    // would leave a release tag free to race a push to main.
    expect(
      group(),
      `concurrency group ${group()} is per-ref, so a v* tag build and a main ` +
        "build run in parallel and both sed the same manifest.yaml",
    ).toContain("'deploy'");
  });

  it("still gives each pull request its own lane", () => {
    expect(
      group(),
      `concurrency group ${group()} does not vary by ref for pull requests, ` +
        "so every PR build queues behind every other one",
    ).toContain("github.event_name == 'pull_request' && github.ref");
  });

  it("never cancels an in-flight build", () => {
    // Killing a run partway through update-manifest is the failure the
    // concurrency group exists to prevent, not an optimisation to add later.
    expect(concurrencyBlock()).toContain("cancel-in-progress: false");
  });
});
