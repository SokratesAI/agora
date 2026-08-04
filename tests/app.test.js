/** @vitest-environment jsdom */

// The first tests `public/app.js` has ever had.
//
// It is a classic script, not a module: 2400 lines that read the DOM at load
// and export nothing. That is why four separate frontend fixes have been
// deferred with "app.js has no test setup and I won't ship a frontend change
// I can't verify" -- and why two of the ones that did ship had to be fixed
// again afterwards.
//
// The harness is three steps: parse `index.html` into jsdom so every
// `getElementById` at load finds its element, stub the handful of things
// `boot()` touches, then INDIRECT-eval the source. Indirect eval runs the
// code as global code, so its top-level `function` declarations become
// properties of `globalThis` and the tests can call them. (Its `const`/`let`
// stay lexical and invisible, which is why the eval happens exactly once and
// the tests reach for DOM nodes rather than module state.)

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Resolved from the project root, not `import.meta.url`: under the jsdom
// environment that is an http:// URL, so the usual relative-to-this-file
// trick silently resolves to `/public/index.html` on disk.
const file = (name) => readFileSync(resolve(process.cwd(), "public", name), "utf8");

let messagesEl;
let idSeq = 0;

/** Distinct ids per message, because renderMessages() early-returns when the
 * rendered key is unchanged -- two tests rendering identical input would
 * silently assert against the previous test's DOM. */
const say = (text, extra = {}) => ({
  id: `m${++idSeq}`,
  sender: "Nova",
  text,
  ts: "2026-08-04T09:00:00.000Z",
  ...extra,
});
const chip = (capability, detail = "") =>
  say("", { activity: { capability, detail } });
const thought = (text) => say(text, { thinking: true });

beforeAll(() => {
  document.documentElement.innerHTML = file("index.html");
  // `boot()` fires on load and fetches the model catalog, the conversation
  // list and the personas. One empty-collection body satisfies all three;
  // without it they reject asynchronously and vitest reports an unhandled
  // error next to eleven green tests.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ models: [], conversations: [], personas: [], messages: [] }),
    })),
  );
  vi.stubGlobal("setInterval", () => 0);
  // eslint-disable-next-line no-eval -- see header: this is the point.
  (0, eval)(file("app.js"));
  messagesEl = document.getElementById("messages");
  expect(messagesEl).toBeTruthy();
});

beforeEach(() => {
  globalThis.renderedKey = "";
});

const drawers = () => [...messagesEl.querySelectorAll(".msg-narration")];
const toggleOf = (drawer) => drawer.querySelector(".msg-narration-toggle");
const bodyOf = (drawer) => drawer.querySelector(".msg-narration-body");
const visibleText = () =>
  [...messagesEl.children]
    .filter((el) => !el.classList.contains("msg-narration"))
    .map((el) => el.textContent)
    .join("\n");

describe("groupNarration", () => {
  it("collects consecutive tool calls and thinking into one group", () => {
    const messages = [
      say("do the thing"),
      thought("let me look at the file"),
      chip("vault_read", "notes.md"),
      chip("vault_write", "notes.md"),
      say("done"),
    ];
    const groups = globalThis.groupNarration(messages);
    expect(groups.map((g) => [g.narration, g.messages.length])).toEqual([
      [false, 1],
      [true, 3],
      [false, 1],
    ]);
  });

  it("does not merge narration across the reply that separates it", () => {
    const groups = globalThis.groupNarration([
      chip("vault_read", "a.md"),
      say("first answer"),
      chip("vault_read", "b.md"),
    ]);
    expect(groups.map((g) => g.narration)).toEqual([true, false, true]);
  });

  it("leaves a conversation with no narration completely ungrouped", () => {
    const groups = globalThis.groupNarration([say("hi"), say("hello")]);
    expect(groups.every((g) => !g.narration)).toBe(true);
    expect(groups).toHaveLength(2);
  });
});

describe("narration drawer", () => {
  it("hides tool calls and thinking by default, leaving only the reply", () => {
    globalThis.renderMessages([
      say("run the tests"),
      thought("I should check the suite first"),
      chip("vault_read", "prompt.md"),
      say("All 42 tests pass."),
    ]);

    const [drawer] = drawers();
    expect(drawer).toBeTruthy();
    expect(bodyOf(drawer).hidden).toBe(true);
    expect(toggleOf(drawer).getAttribute("aria-expanded")).toBe("false");

    // The reply is in the conversation; the narration is not.
    expect(visibleText()).toContain("All 42 tests pass.");
    expect(visibleText()).not.toContain("I should check the suite first");
  });

  it("summarises the group by count and newest step, so it moves during a run", () => {
    globalThis.renderMessages([
      chip("vault_read", "a.md"),
      chip("vault_read", "b.md"),
      chip("vault_write", "c.md"),
    ]);
    expect(toggleOf(drawers()[0]).textContent).toContain("3 steps");
    expect(toggleOf(drawers()[0]).textContent).toContain("Wrote vault file · c.md");
  });

  it("says '1 step', not '1 steps'", () => {
    globalThis.renderMessages([say("go"), chip("web_search", "k3s oom")]);
    expect(toggleOf(drawers()[0]).textContent).toContain("1 step ·");
  });

  it("reveals every step on click, dropping none of them", () => {
    globalThis.renderMessages([
      thought("thinking out loud"),
      chip("vault_read", "one.md"),
      chip("vault_read", "two.md"),
      say("finished"),
    ]);
    const [drawer] = drawers();
    toggleOf(drawer).click();

    expect(bodyOf(drawer).hidden).toBe(false);
    expect(toggleOf(drawer).getAttribute("aria-expanded")).toBe("true");
    expect(bodyOf(drawer).children).toHaveLength(3);
    expect(bodyOf(drawer).textContent).toContain("thinking out loud");
    expect(bodyOf(drawer).textContent).toContain("one.md");
    expect(bodyOf(drawer).textContent).toContain("two.md");
  });

  it("closes again on a second click", () => {
    globalThis.renderMessages([say("go"), chip("vault_read", "a.md")]);
    const [drawer] = drawers();
    toggleOf(drawer).click();
    toggleOf(drawer).click();
    expect(bodyOf(drawer).hidden).toBe(true);
  });

  // The one that actually bites: the conversation re-renders from scratch
  // every 3s poll, and a cycle appends a chip every few seconds. An opened
  // drawer that forgets it was open snaps shut in the reader's face, over and
  // over, for the entire run.
  it("stays open when new messages arrive underneath it", () => {
    const opening = [say("go"), chip("vault_read", "a.md")];
    globalThis.renderMessages(opening);
    toggleOf(drawers()[0]).click();
    expect(bodyOf(drawers()[0]).hidden).toBe(false);

    globalThis.renderedKey = "";
    globalThis.renderMessages([...opening, chip("vault_read", "b.md"), say("done")]);

    const [drawer] = drawers();
    expect(bodyOf(drawer).hidden).toBe(false);
    expect(bodyOf(drawer).children).toHaveLength(2);
    expect(toggleOf(drawer).textContent).toContain("2 steps");
  });

  it("keeps drawers independent -- opening one does not open the next", () => {
    globalThis.renderMessages([
      chip("vault_read", "a.md"),
      say("first answer"),
      chip("vault_read", "b.md"),
      say("second answer"),
    ]);
    const [first, second] = drawers();
    toggleOf(first).click();
    expect(bodyOf(first).hidden).toBe(false);
    expect(bodyOf(second).hidden).toBe(true);
  });

  // Edvard, 2026-08-04, on the 400-chip cap this replaces: "limiting the tool
  // calls (which limits your ability) just because you think it will improve
  // the ui is against everything we stand for."
  it("holds a whole cycle's worth of tool calls without dropping any", () => {
    const flood = Array.from({ length: 400 }, (_, i) => chip("vault_read", `f${i}.md`));
    globalThis.renderMessages([say("go"), ...flood, say("done")]);

    const [drawer] = drawers();
    expect(toggleOf(drawer).textContent).toContain("400 steps");
    expect(bodyOf(drawer).children).toHaveLength(400);
    expect(bodyOf(drawer).textContent).toContain("f399.md");
    // ...and none of it is between him and the answer until he asks for it.
    expect(bodyOf(drawer).hidden).toBe(true);
    expect(visibleText()).toContain("done");
  });
});

// A narrated tool call arrives as two messages -- the call when it starts,
// its output when it returns -- and has to read as one chip. Edvard's issue
// 1, asked three times: "I need to see the command with all metadata and
// also the output from that command, such as the return of a echo command."
const call = (capability, detail, toolUseId) =>
  say("", { activity: { capability, detail, toolUseId } });
const result = (capability, toolUseId, output, isError = false) =>
  say("", { activity: { capability, detail: "", toolUseId, output, isError } });

describe("mergeToolResults", () => {
  it("folds a tool's output into the chip for the call that made it", () => {
    const merged = globalThis.mergeToolResults([
      call("Bash", "echo hi", "toolu_a"),
      result("Bash", "toolu_a", "hi\n"),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].activity.detail).toBe("echo hi");
    expect(merged[0].activity.output).toBe("hi\n");
  });

  it("keeps the call's own id and position, so an open drawer stays open", () => {
    const started = call("Bash", "pytest", "toolu_a");
    const merged = globalThis.mergeToolResults([
      say("go"),
      started,
      result("Bash", "toolu_a", "97 passed"),
      say("done"),
    ]);
    expect(merged.map((m) => m.text)).toEqual(["go", "", "done"]);
    expect(merged[1].id).toBe(started.id);
  });

  it("pairs each call with its own output when several are in flight", () => {
    const merged = globalThis.mergeToolResults([
      call("Bash", "one", "toolu_1"),
      call("Bash", "two", "toolu_2"),
      result("Bash", "toolu_2", "second"),
      result("Bash", "toolu_1", "first"),
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0].activity.output).toBe("first");
    expect(merged[1].activity.output).toBe("second");
  });

  it("leaves a call whose output has not arrived yet alone", () => {
    // The live case: the chip is on screen while the tool is still running.
    const merged = globalThis.mergeToolResults([call("Bash", "pytest", "toolu_a")]);
    expect(merged).toHaveLength(1);
    expect(merged[0].activity.output).toBeUndefined();
  });

  it("shows an orphaned output rather than swallowing it", () => {
    // A conversation opened from the middle, or a lost first half. A chip
    // nobody can explain beats output nobody can see.
    const merged = globalThis.mergeToolResults([result("Bash", "toolu_gone", "orphan")]);
    expect(merged).toHaveLength(1);
    expect(merged[0].activity.output).toBe("orphan");
  });

  it("does not disturb messages that are not tool calls at all", () => {
    const merged = globalThis.mergeToolResults([
      say("hello"),
      chip("vault_read", "a.md"),
      thought("hmm"),
    ]);
    expect(merged).toHaveLength(3);
  });
});

describe("tool output in the conversation", () => {
  it("renders one chip, not two, for a call and its result", () => {
    globalThis.renderMessages([
      say("go"),
      call("Bash", "echo hi", "toolu_a"),
      result("Bash", "toolu_a", "hi\n"),
      say("done"),
    ]);
    const [drawer] = drawers();
    expect(toggleOf(drawer).textContent).toContain("1 step");
    expect(bodyOf(drawer).children).toHaveLength(1);
  });

  it("marks a failed tool call on the chip itself", () => {
    globalThis.renderMessages([
      say("go"),
      call("Bash", "nope", "toolu_b"),
      result("Bash", "toolu_b", "command not found", true),
      say("done"),
    ]);
    const [drawer] = drawers();
    toggleOf(drawer).click();
    const failed = bodyOf(drawer).querySelector(".msg-activity-failed");
    expect(failed).toBeTruthy();
    expect(failed.textContent).toContain("failed");
  });

  it("does not mark a call that succeeded", () => {
    globalThis.renderMessages([
      say("go"),
      call("Bash", "echo hi", "toolu_c"),
      result("Bash", "toolu_c", "hi\n"),
      say("done"),
    ]);
    const [drawer] = drawers();
    toggleOf(drawer).click();
    expect(bodyOf(drawer).querySelector(".msg-activity-failed")).toBeNull();
  });

  it("puts the output verbatim in the detail sheet", () => {
    globalThis.openAuditDetail({
      personaName: "Nova",
      capability: "Bash",
      detail: "echo hi",
      ts: "2026-08-04T09:00:00.000Z",
      conversationId: "c1",
      output: "hi\n  indented\ttabbed",
    });
    const pre = document.querySelector(".audit-output");
    expect(pre).toBeTruthy();
    expect(pre.textContent).toBe("hi\n  indented\ttabbed");
  });

  it("says so when a tool returned nothing, rather than showing a blank box", () => {
    globalThis.openAuditDetail({
      personaName: "Nova", capability: "Bash", detail: "true",
      ts: "2026-08-04T09:00:00.000Z", conversationId: "c1", output: "",
    });
    expect(document.querySelector(".audit-output").textContent).toBe("(no output)");
  });

  it("shows no output box for a capability that has none", () => {
    globalThis.openAuditDetail({
      personaName: "Nova", capability: "vault_read", detail: "a.md",
      ts: "2026-08-04T09:00:00.000Z", conversationId: "c1",
    });
    expect(document.querySelector(".audit-output")).toBeNull();
  });
});
