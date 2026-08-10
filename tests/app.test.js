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

  // issues.md #48. The client asks for `?limit=200` and the server answers
  // `slice(-200)`, so once a run outgrows that window every poll drops a
  // message off the FRONT. The group's first message was its expanded-state
  // key, so the key moved under the reader roughly once per poll and the
  // drawer collapsed itself seconds after being opened. Replayed against
  // Cycle 68's real 338-message conversation the old key changed on 119 of
  // 120 consecutive polls.
  it("stays open while the loaded window slides past its first message", () => {
    const run = Array.from({ length: 12 }, (_, i) => chip("vault_read", `w${i}.md`));
    // One message object reused across renders: a real poll returns the same
    // message with the same id, and regenerating it here would move the anchor
    // for reasons the server never would.
    const anchorMessage = say("go");
    const windowOf = (start) => [anchorMessage, ...run.slice(start, start + 6)];

    globalThis.renderMessages(windowOf(0), true);
    toggleOf(drawers()[0]).click();
    expect(bodyOf(drawers()[0]).hidden).toBe(false);

    // The reply anchoring the group is still loaded, but its own first, second
    // and third chips have all fallen out of the window.
    for (const start of [1, 2, 3]) {
      globalThis.renderedKey = "";
      globalThis.renderMessages(windowOf(start), true);
      expect(bodyOf(drawers()[0]).hidden).toBe(false);
    }
  });

  it("anchors a group to the message it follows, not to its own first message", () => {
    const groups = globalThis.groupNarration([
      chip("vault_read", "before-any-reply.md"),
      say("first answer"),
      chip("vault_read", "b.md"),
    ]);
    const [head, reply, tail] = groups;
    // A group at the window's front has no preceding message and takes the
    // sentinel; the one after the reply is anchored to that reply's id, which
    // does not move when the window slides.
    expect(head.anchor).toBe("#narration-head");
    expect(tail.anchor).toBe(reply.messages[0].id);
  });

  // Starts on a message rather than mid-narration, which is what a whole
  // conversation looks like: only a window that cut the front produces a
  // group with nothing before it, and there can be at most one of those.
  it("keeps drawers independent -- opening one does not open the next", () => {
    globalThis.renderMessages([
      say("go"),
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

// Edvard, issues.md #48: "does not count more steps, it actually goes
// downwards to 117??". Nothing counts down -- but the drawer was reporting
// the length of a sliding window, and that does. Each poll drops one message
// off the front, and when the arriving message is a tool RESULT it merges
// into its call instead of adding a chip, so the window's merged length falls
// by one. Against Cycle 68's real conversation it went backwards 36 times.
describe("narration step count under a windowed view", () => {
  const stepsIn = (text) => Number(text.match(/(\d+)\+? steps?/)[1]);

  it("is exact, with no '+', when the whole run is loaded", () => {
    globalThis.renderMessages([
      say("go"),
      chip("vault_read", "a.md"),
      chip("vault_read", "b.md"),
    ]);
    expect(toggleOf(drawers()[0]).textContent).toContain("2 steps");
    expect(toggleOf(drawers()[0]).textContent).not.toContain("+");
  });

  it("reports a windowed count as a lower bound rather than as a fact", () => {
    const run = Array.from({ length: 5 }, (_, i) => chip("vault_read", `t${i}.md`));
    globalThis.renderMessages(run, true);
    expect(toggleOf(drawers()[0]).textContent).toContain("5+ steps");
  });

  it("never counts downwards when the window slides", () => {
    // Interleaved calls and results, because the merge is the whole mechanism:
    // a window of plain chips has a constant merged length and would pass this
    // test against the unfixed code. A result arriving costs the window one
    // message off the front and adds no chip, so the count falls by one.
    const run = [];
    for (let i = 0; i < 40; i++) {
      run.push(call("Bash", `cmd ${i}`, `toolu_${i}`), result("Bash", `toolu_${i}`, "ok"));
    }
    const width = 20;
    const seen = [];
    for (let start = 0; start + width <= run.length; start++) {
      globalThis.renderedKey = "";
      globalThis.renderMessages(run.slice(start, start + width), true);
      seen.push(stepsIn(toggleOf(drawers()[0]).textContent));
    }
    expect(seen.length).toBeGreaterThan(10);
    expect(seen.some((n, i) => i > 0 && n < seen[i - 1])).toBe(false);
  });

  it("says where the missing steps went instead of letting them look deleted", () => {
    globalThis.renderMessages([chip("vault_read", "a.md")], true);
    toggleOf(drawers()[0]).click();
    expect(bodyOf(drawers()[0]).textContent).toContain("outside the loaded window");
  });
});

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

// The drawer this suite already covers shipped unable to hide anything, and
// every test above passed the whole time. jsdom's getComputedStyle
// special-cases the `hidden` attribute and reports `display: none` no matter
// what the stylesheet says, so the one thing that was broken -- an author
// `display: flex` outweighing the UA rule in a real browser -- is exactly the
// thing this environment cannot see. Asserting on the stylesheet instead is
// not a workaround for a missing browser: the invariant genuinely is a
// property of the CSS, and checking it here is what would have caught it.
describe("the hidden attribute actually hides", () => {
  // Comments stripped first: this file documents the rule in prose right
  // above it, and a scan of the raw text finds the explanation as readily as
  // the code.
  const styleText = () =>
    [...document.querySelectorAll("style")]
      .map((el) => el.textContent)
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "");

  const hiddenSelectors = () =>
    [...styleText().matchAll(/([^{}]*?)\[hidden\][^{}]*\{([^}]*)\}/g)].map((m) => ({
      prefix: m[1].trim(),
      body: m[2],
    }));

  it("overrides author display rules globally, not per selector", () => {
    const global = hiddenSelectors().filter((r) => r.prefix === "");
    expect(global).toHaveLength(1);
    expect(global[0].body).toMatch(/display:\s*none\s*!important/);
  });

  it("leaves no selector relying on a per-selector [hidden] workaround", () => {
    // Thirteen of these existed, and the three selectors that needed one and
    // never got it were the live bugs -- including the narration drawer
    // Edvard reported. A new one appearing means someone hit the trap again
    // and patched their own case instead of trusting the rule above.
    expect(hiddenSelectors().map((r) => r.prefix).filter(Boolean)).toEqual([]);
  });
});

describe("narration text", () => {
  const passage = (text) => say("", { activity: { capability: "assistant_text", detail: text } });

  it("renders as prose, not as a one-line chip", () => {
    globalThis.renderMessages([say("go"), passage("Let me check the deploy first."), say("done")]);
    const [drawer] = drawers();
    toggleOf(drawer).click();
    const prose = bodyOf(drawer).querySelector(".msg-narration-text");
    expect(prose).toBeTruthy();
    expect(prose.textContent).toContain("Let me check the deploy first.");
    expect(bodyOf(drawer).querySelector(".msg-activity-chip")).toBeNull();
  });

  it("keeps the written passages and the tool calls in the order they happened", () => {
    globalThis.renderMessages([
      say("go"),
      passage("First I look at the pods."),
      chip("kubectl_read", "get pods"),
      passage("They are all up, so now the logs."),
      chip("kubectl_read", "logs"),
      say("all healthy"),
    ]);
    const [drawer] = drawers();
    toggleOf(drawer).click();
    const kinds = [...bodyOf(drawer).children].map((el) =>
      el.classList.contains("msg-narration-text") ? "text" : "tool",
    );
    expect(kinds).toEqual(["text", "tool", "text", "tool"]);
  });

  it("summarises a passage by its first line, not by the wire capability", () => {
    globalThis.renderMessages([
      say("go"),
      passage("Checking the deploy now.\nThen the logs."),
    ]);
    const [drawer] = drawers();
    const label = toggleOf(drawer).textContent;
    expect(label).toContain("Checking the deploy now.");
    expect(label).not.toContain("assistant_text");
    expect(label).not.toContain("Then the logs.");
  });

  it("stays hidden with the rest of the narration until the drawer is opened", () => {
    globalThis.renderMessages([say("go"), passage("thinking out loud"), say("done")]);
    expect(visibleText()).toContain("done");
    expect(visibleText()).not.toContain("thinking out loud");
  });

  it("survives the tool-result merge, which has no id to pair it on", () => {
    const messages = [
      passage("before the call"),
      call("Bash", "echo hi", "toolu_p"),
      result("Bash", "toolu_p", "hi\n"),
      passage("after the call"),
    ];
    const merged = globalThis.mergeToolResults(messages);
    expect(merged.map((m) => m.activity.capability)).toEqual([
      "assistant_text",
      "Bash",
      "assistant_text",
    ]);
    expect(merged[1].activity.output).toBe("hi\n");
  });
});

describe("formatRunningFor", () => {
  // The "Run now" button used to claim "Queued — runs within ~5s." no matter
  // what. When a cycle is already in flight the press is only picked up after
  // it ends, so that sentence was false by up to ~45 minutes -- which is how
  // Edvard came to suspect he was spawning runs in parallel.
  it("is empty without a timestamp, rather than guessing a duration", () => {
    expect(globalThis.formatRunningFor(null)).toBe("");
    expect(globalThis.formatRunningFor("")).toBe("");
    expect(globalThis.formatRunningFor(undefined)).toBe("");
  });

  it("renders minutes under an hour", () => {
    const since = new Date(Date.now() - 38 * 60000).toISOString();
    expect(globalThis.formatRunningFor(since)).toBe(" for 38m");
  });

  it("splits into hours and minutes past an hour", () => {
    const since = new Date(Date.now() - (2 * 60 + 5) * 60000).toISOString();
    expect(globalThis.formatRunningFor(since)).toBe(" for 2h 5m");
  });

  it("stays empty on an unparseable or future timestamp", () => {
    expect(globalThis.formatRunningFor("not-a-date")).toBe("");
    expect(globalThis.formatRunningFor(new Date(Date.now() + 60000).toISOString())).toBe("");
  });
});
