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
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
      // `heartbeats` is here because a click on "Run now" schedules a real
      // 1500ms re-render of the studio list, and that timer outlives the
      // test that started it. Without the key, `renderHeartbeatStudio`
      // throws on `data.heartbeats.length` inside a dangling timer -- an
      // unhandled rejection attributed to whatever file happens to be
      // running 1.5 seconds later. The real GET /heartbeats sends this key,
      // so the fixture was simply wrong.
      json: async () => ({ models: [], conversations: [], personas: [], messages: [], heartbeats: [] }),
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

describe("subagent chips", () => {
  // The bridge posts a subagent's launch and its finish under the same task
  // id (bridge/activity.py SUBAGENT), so the existing call/result pairing
  // folds a whole delegated run into one chip.
  it("folds a subagent's launch and finish into one chip", () => {
    const merged = globalThis.mergeToolResults([
      call("subagent", "Explore \u00b7 Gather Nova opening state", "task_1"),
      result("subagent", "task_1", "completed \u00b7 94,183 tokens \u00b7 37 tool calls"),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].activity.detail).toBe("Explore \u00b7 Gather Nova opening state");
    expect(merged[0].activity.output).toContain("94,183 tokens");
  });

  it("labels it as a subagent rather than showing the wire capability", () => {
    globalThis.renderMessages([
      say("go"),
      call("subagent", "Explore \u00b7 Gather Nova opening state", "task_1"),
    ]);
    const [drawer] = drawers();
    const label = toggleOf(drawer).textContent;
    expect(label).toContain("Subagent");
    expect(label).toContain("Gather Nova opening state");
  });

  it("shows a subagent's own tool calls, attributed to it", () => {
    globalThis.renderMessages([
      say("go"),
      call("Bash", "\u21b3 Gather Nova opening state \u00b7 grep -rn foo", "toolu_child"),
    ]);
    const [drawer] = drawers();
    const label = toggleOf(drawer).textContent;
    expect(label).toContain("\u21b3 Gather Nova opening state");
    expect(label).toContain("grep -rn foo");
  });
});

// The other half of issues.md #48. The drawer polls every 3s, and until now
// each poll re-downloaded the entire window -- which is why the window had to
// stay at 200 messages, narrower than 32 of the 81 conversations that actually
// exist. Now the poll asks for what arrived after what it holds, and the
// server says whether that was a safe question to answer. These pin the
// client's half of that contract: what it asks for, and what it does with
// either answer.
describe("incremental message polling", () => {
  const page = (messages, { incremental = false, rev = "r1" } = {}) => ({
    incremental,
    rev,
    messages,
  });
  const paramsOf = (url) => new URLSearchParams(url.split("?")[1]);

  it("asks for a whole cycle on first load, and for nothing it already holds", () => {
    const url = globalThis.messagesQuery("c1", [], "", null);
    const params = paramsOf(url);
    expect(url.startsWith("/conversations/c1/messages?")).toBe(true);
    // 500 covers every cycle this loop has run: the largest live conversation
    // on 2026-08-10 was 620 and the largest Nova cycle 474, against a p90 of
    // 338. The old 200 cut two thirds of them.
    expect(Number(params.get("limit"))).toBe(500);
    expect(params.get("after")).toBeNull();
    expect(params.get("rev")).toBeNull();
  });

  it("asks only for what follows its newest message once it holds some", () => {
    const held = [say("a"), say("b")];
    const params = paramsOf(globalThis.messagesQuery("c1", held, "rev-abc", "c1"));
    expect(params.get("after")).toBe(held[1].id);
    expect(params.get("rev")).toBe("rev-abc");
  });

  it("does not offer a cursor belonging to a different conversation", () => {
    const held = [say("a")];
    const params = paramsOf(globalThis.messagesQuery("c2", held, "rev-abc", "c1"));
    expect(params.get("after")).toBeNull();
    expect(params.get("rev")).toBeNull();
  });

  it("does not offer a cursor without the rev that makes it checkable", () => {
    const params = paramsOf(globalThis.messagesQuery("c1", [say("a")], "", "c1"));
    expect(params.get("after")).toBeNull();
  });

  it("appends an incremental page and replaces a full one", () => {
    const held = [say("one"), say("two")];
    const arrived = say("three");

    const grown = globalThis.applyMessagePage(held, page([arrived], { incremental: true }));
    expect(grown.map((m) => m.text)).toEqual(["one", "two", "three"]);

    const replacement = [say("fresh")];
    expect(
      globalThis.applyMessagePage(grown, page(replacement)).map((m) => m.text),
    ).toEqual(["fresh"]);
  });

  it("treats a response that says nothing about incrementality as a replacement", () => {
    // An older server, or a cached response from one. Replacing is what this
    // did before the change, so the wrong guess degrades to the old behaviour
    // rather than to a thread with duplicated messages in it.
    const held = [say("one")];
    const legacy = { messages: [say("two")] };
    expect(globalThis.applyMessagePage(held, legacy).map((m) => m.text)).toEqual(["two"]);
  });

  it("accumulates a whole run one poll at a time without dropping or duplicating", () => {
    // 340 messages arriving a few at a time is what a real cycle looks like,
    // and is past the old 200 window -- the case where the front used to fall
    // off and the collapsed drawer's count went backwards.
    const expected = [];
    let held = [];
    for (let poll = 0; poll < 85; poll++) {
      const arrived = [say(`s${poll}a`), say(`s${poll}b`), say(`s${poll}c`), say(`s${poll}d`)];
      expected.push(...arrived.map((m) => m.text));
      held = globalThis.applyMessagePage(held, page(arrived, { incremental: poll > 0 }));
    }
    expect(held).toHaveLength(340);
    expect(held.map((m) => m.text)).toEqual(expected);
    expect(new Set(held.map((m) => m.id)).size).toBe(340);
  });

  it("keeps a drawer's step count climbing across polls instead of going backwards", () => {
    // Edvard, issues.md #48: "does not count more steps, it actually goes
    // downwards to 117??". That was the window sliding: each poll dropped a
    // message off the front, so the count fell. Accumulating, it cannot.
    let held = globalThis.applyMessagePage([], page([say("go")]));
    const counts = [];
    for (let poll = 0; poll < 30; poll++) {
      held = globalThis.applyMessagePage(
        held,
        page([chip("vault_read", `p${poll}.md`)], { incremental: true }),
      );
      globalThis.renderedKey = "";
      globalThis.renderMessages(held, false);
      counts.push(Number(toggleOf(drawers()[0]).textContent.match(/(\d+) steps?/)[1]));
    }
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    expect(counts[counts.length - 1]).toBe(30);
  });
});

// Two polls in flight at once. The 3s timer is not the only caller --
// sending, deleting, forgetting and regenerating each call fetchMessages()
// directly -- so overlap is ordinary, not exotic. It used to be harmless
// because every response replaced the thread wholesale; an append is not
// idempotent, and applying the same delta twice would show the reader the
// same message twice.
describe("overlapping polls", () => {
  const page = (messages, { incremental = false, rev = "r1" } = {}) => ({
    incremental,
    rev,
    messages,
  });

  it("drops a delta whose starting point another poll already moved past", () => {
    // Both polls left holding rev "r10". The first lands, advancing to "r11".
    expect(globalThis.canApplyPage(page([], { incremental: true }), "r10", "r10")).toBe(true);
    // The second now describes a thread that no longer exists.
    expect(globalThis.canApplyPage(page([], { incremental: true }), "r10", "r11")).toBe(false);
  });

  it("always applies a full page, because replacing is idempotent", () => {
    expect(globalThis.canApplyPage(page([]), "r10", "r11")).toBe(true);
    expect(globalThis.canApplyPage(page([]), "", "r11")).toBe(true);
  });

  it("does not duplicate a message when two polls carry the same delta", () => {
    const held = [say("one")];
    const arrived = say("two");
    const delta = page([arrived], { incremental: true, rev: "r2" });

    // Poll A applies against "r1" and moves the thread to "r2".
    let current = "r1";
    let thread = held;
    expect(globalThis.canApplyPage(delta, current, current)).toBe(true);
    thread = globalThis.applyMessagePage(thread, delta);
    current = delta.rev;

    // Poll B was requested against "r1" too, and must be discarded.
    expect(globalThis.canApplyPage(delta, "r1", current)).toBe(false);
    expect(thread.map((m) => m.text)).toEqual(["one", "two"]);
  });
});

// 2026-08-10, Edvard's hard rule in issues.md: the prepaid Anthropic balance
// had $16 left and will not be refilled. The picker was actively working
// against him — a two-way ternary written before claude-cli existed filed
// every claude-cli model under the heading "Gemini", so the free
// subscription models were hidden under the wrong provider while the ones
// that spend real money sat under "Anthropic" with the cleaner names.
describe("model picker labels", () => {
  it("names each provider group, and no longer files Claude under Gemini", () => {
    expect(globalThis.modelGroupLabel("claude-cli")).toBe("Claude (subscription)");
    expect(globalThis.modelGroupLabel("claude-cli")).not.toMatch(/Gemini/);
    expect(globalThis.modelGroupLabel("gemini")).toBe("Gemini");
    expect(globalThis.modelGroupLabel("anthropic")).toMatch(/metered/);
  });

  it("falls back to the raw provider rather than mislabelling an unknown one", () => {
    // The bug being fixed was precisely a fallback that guessed "Gemini"
    // for anything unrecognised, so the fallback must not name a provider.
    expect(globalThis.modelGroupLabel("some-future-provider")).toBe("some-future-provider");
  });

  it("marks a metered model on the option itself, not only on the group", () => {
    // A collapsed <select> shows the option text alone, so the group
    // heading is invisible exactly when you want to know what you picked.
    expect(globalThis.modelOptionLabel({ label: "Claude Opus 5", metered: true }))
      .toBe("Claude Opus 5 — metered");
    expect(globalThis.modelOptionLabel({ label: "Claude Opus 5 (CLI)" }))
      .toBe("Claude Opus 5 (CLI)");
  });
});

// The reviewer's finding on this branch, and the more serious of the two:
// relabelling the options changed nothing about which one is SELECTED. A
// <select> with no value set shows its first option, and the catalog's first
// entry is the metered Anthropic Haiku — so Edvard opening New Chat and
// tapping Create without touching the dropdown billed the prepaid balance,
// on the most common path there is.
describe("model picker default selection", () => {
  const known = new Map([
    ["anthropic:claude-haiku-4-5-20251001", {}],
    ["claude-cli:claude-haiku-4-5-20251001", {}],
    ["gemini:gemini-3.6-flash", {}],
  ]);

  it("falls back to the server's default model, not to whatever is first", () => {
    expect(globalThis.chosenModelValue("", "claude-cli:claude-haiku-4-5-20251001", known))
      .toBe("claude-cli:claude-haiku-4-5-20251001");
  });

  it("keeps an existing selection over the default", () => {
    expect(globalThis.chosenModelValue("gemini:gemini-3.6-flash", "claude-cli:claude-haiku-4-5-20251001", known))
      .toBe("gemini:gemini-3.6-flash");
  });

  it("ignores a previous or default value the catalog no longer offers", () => {
    // A retired model id must not be forced onto the select — that would
    // set .value to something with no matching <option>, which silently
    // resolves to empty and shows the first option again.
    expect(globalThis.chosenModelValue("gemini:retired", "claude-cli:claude-haiku-4-5-20251001", known))
      .toBe("claude-cli:claude-haiku-4-5-20251001");
    expect(globalThis.chosenModelValue("", "anthropic:retired", known)).toBe("");
  });
});

describe("conversation list polling (issues.md #3)", () => {
  const conv = (id, over = {}) => ({
    id,
    rootId: id,
    name: `conv ${id}`,
    archived: false,
    status: "active",
    lastMessageAt: "2026-08-14T06:00:00.000Z",
    createdAt: "2026-08-14T05:00:00.000Z",
    ...over,
  });

  const serves = (conversations) =>
    globalThis.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ conversations }),
    });

  it("notices every field the drawer actually draws from", () => {
    const sig = globalThis.conversationListSignature;
    const base = [conv("a")];
    expect(sig(base)).toBe(sig([conv("a")]));
    expect(sig(base)).not.toBe(sig([conv("a"), conv("b")]));
    expect(sig(base)).not.toBe(sig([conv("a", { name: "renamed" })]));
    expect(sig(base)).not.toBe(sig([conv("a", { archived: true })]));
    expect(sig(base)).not.toBe(sig([conv("a", { rootId: "z" })]));
    expect(sig(base)).not.toBe(sig([conv("a", { status: "archived" })]));
    expect(sig(base)).not.toBe(sig([conv("a", { lastMessageAt: "2026-08-14T07:00:00.000Z" })]));
  });

  it("treats a missing list as empty rather than throwing", () => {
    expect(globalThis.conversationListSignature(undefined)).toBe("");
  });

  it("re-renders when a conversation appears, and not when nothing changed", async () => {
    // The whole bug: every cycle creates a conversation, and the sidebar was
    // loaded once at boot, so it could only ever appear on a full reload.
    serves([conv("a")]);
    expect(await globalThis.refreshConversationList()).toBe(true);

    serves([conv("a")]);
    expect(await globalThis.refreshConversationList()).toBe(false);

    serves([conv("a"), conv("b")]);
    expect(await globalThis.refreshConversationList()).toBe(true);

    serves([conv("a"), conv("b")]);
    expect(await globalThis.refreshConversationList()).toBe(false);
  });

  it("leaves the list alone when the request fails", async () => {
    serves([conv("a"), conv("b")]);
    await globalThis.refreshConversationList();
    globalThis.fetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    expect(await globalThis.refreshConversationList()).toBe(false);
    // still the two it had — a failed poll must not blank the sidebar
    serves([conv("a"), conv("b")]);
    expect(await globalThis.refreshConversationList()).toBe(false);
  });
});

// A raw control byte in the source makes the whole file *binary* to every
// tool that sniffs before it reads. `public/app.js` carried a literal NUL
// and a literal 0x01 as the separators inside conversationListSignature, and
// the consequence was not cosmetic: ugrep classifies the file as binary and
// silently prints nothing, exit 1 -- indistinguishable from "no matches". A
// cycle grepping this file for `heartbeat` got zero hits against 244 real
// ones and started filing a bug report about UI that was wired the whole
// time. \u0000 escapes give a byte-identical string at runtime and keep the
// file greppable, so there is no cost to paying this.
describe("app.js stays plain text", () => {
  it("has no raw control bytes, which would make grep skip the file", () => {
    const raw = readFileSync(resolve(process.cwd(), "public", "app.js"));
    const offenders = [];
    for (let i = 0; i < raw.length; i += 1) {
      const byte = raw[i];
      // Tab, newline and carriage return are the legitimate ones.
      if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
        offenders.push({ offset: i, byte: `0x${byte.toString(16).padStart(2, "0")}` });
      }
    }
    expect(offenders).toEqual([]);
  });

  it("still separates signature fields with the same characters", () => {
    const sig = globalThis.conversationListSignature([
      { id: "a", rootId: null, name: "n", archived: false, status: "s", lastMessageAt: 1, createdAt: 2 },
    ]);
    expect(sig).toContain("\u0000");
  });
});

// The heartbeat push toggle (Edvard, 2026-08-14: "Did you fix the
// notification for agora heartbeats? So i can turn them off?"). These run
// against the real `index.html`, so a checkbox whose id does not exist in
// the markup fails here rather than on his phone -- which is how a rating
// picker shipped completely dead two cycles ago.
describe("heartbeat push notification toggle", () => {
  it("ticks the box for a heartbeat with no pushNotifications field", () => {
    // Absent means notify. Every heartbeat created before the field exists
    // has no such key and must not read as muted.
    globalThis.openHeartbeatForm({ id: "hb1", name: "HB", schedule: "every@1h" });
    expect(document.getElementById("heartbeat-form-push").checked).toBe(true);
  });

  it("unticks the box for a muted heartbeat", () => {
    globalThis.openHeartbeatForm({
      id: "hb1", name: "HB", schedule: "every@1h", pushNotifications: false,
    });
    expect(document.getElementById("heartbeat-form-push").checked).toBe(false);
  });

  it("ticks the box for a new heartbeat", () => {
    globalThis.openHeartbeatForm(null);
    expect(document.getElementById("heartbeat-form-push").checked).toBe(true);
  });

  it("marks a muted heartbeat in the studio list", () => {
    const row = globalThis.renderHeartbeatRow({
      id: "hb1", name: "HB", schedule: "every@1h", enabled: true,
      pushNotifications: false,
    });
    expect(row.querySelector(".studio-item-name").textContent).toContain("🔕");
  });

  it("leaves an unmuted heartbeat unmarked", () => {
    const row = globalThis.renderHeartbeatRow({
      id: "hb1", name: "HB", schedule: "every@1h", enabled: true,
    });
    expect(row.querySelector(".studio-item-name").textContent).not.toContain("🔕");
  });
});

// Gating "Run now" (Edvard, issues.md #6: "my butter fingers might easily
// press that button twice very fast triggering two heartbeats in paralell").
// These click the real button on a real rendered row, so a gate that is
// wired to the wrong element fails here rather than on his phone.
describe("heartbeat Run now gate", () => {
  const runButtonOf = (row) =>
    [...row.querySelectorAll("button")].find((b) => b.textContent === "Run now");

  const rowWithRun = () => {
    const row = globalThis.renderHeartbeatRow({
      id: "hb1", name: "Nova", schedule: "every@60m", enabled: true,
    });
    return [row, runButtonOf(row)];
  };

  beforeEach(() => {
    globalThis.fetch.mockClear();
  });

  it("asks before starting a cycle, and sends nothing when answered no", () => {
    vi.stubGlobal("confirm", vi.fn(() => false));
    const [, run] = rowWithRun();
    run.click();
    expect(globalThis.confirm).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("names the heartbeat in the question, so the wrong row is visible", () => {
    vi.stubGlobal("confirm", vi.fn(() => false));
    const [, run] = rowWithRun();
    run.click();
    expect(globalThis.confirm.mock.calls[0][0]).toContain("Nova");
  });

  it("posts the run once when answered yes", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true));
    const [, run] = rowWithRun();
    run.click();
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    expect(globalThis.fetch.mock.calls[0][0]).toContain("/heartbeats/hb1/run");
  });

  it("ignores a second press while the first is still in flight", async () => {
    // The double-tap. `confirm` blocks the event loop in a real browser, so
    // the press that gets through is the one arriving after it is answered
    // and before the POST comes back -- which is exactly this.
    let release;
    globalThis.fetch.mockImplementationOnce(
      () => new Promise((resolve) => {
        release = () => resolve({
          ok: true, status: 200, json: async () => ({ status: "queued" }),
        });
      }),
    );
    vi.stubGlobal("confirm", vi.fn(() => true));
    const [, run] = rowWithRun();
    run.click();
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    run.click();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(globalThis.confirm).toHaveBeenCalledTimes(1);
    release();
  });

  it("works again once the first press has answered", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true));
    const [, run] = rowWithRun();
    run.click();
    // Asserted before the wait, not only after it. `disabled` starts false,
    // so waiting for false is satisfied the instant it is asked and would
    // pass with the gate deleted -- the reviewer caught that this test
    // pinned nothing. The true is what the gate has to produce.
    expect(run.disabled).toBe(true);
    await vi.waitFor(() => expect(run.disabled).toBe(false));
    run.click();
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(2));
  });
});

// What the button SAYS after the press, which is a different question from
// whether it gated the press. `api()` resolves on an HTTP error instead of
// throwing, so the handler read only `data`, found no `already-running`, and
// fell into the else -- reporting "Queued — runs within ~5s." for a run the
// server had just refused. The network-level failure was worse: `fetch`
// rejects, the handler threw, and the press produced no message at all.
describe("heartbeat Run now reports the truth", () => {
  const statusEl = () => document.getElementById("status");
  const runButtonOf = (row) =>
    [...row.querySelectorAll("button")].find((b) => b.textContent === "Run now");

  const press = () => {
    const row = globalThis.renderHeartbeatRow({
      id: "hb1", name: "Nova", schedule: "every@60m", enabled: true,
    });
    runButtonOf(row).click();
  };

  // Routed on the URL rather than queued with `mockImplementationOnce`.
  // `globalThis.fetch` is one mock shared by the whole file and nothing
  // cancels the 1500ms studio re-render the describe above leaves running, so
  // a queued implementation can be eaten by a stray `GET /heartbeats` that
  // lands first -- which would answer the POST under test with a success body
  // and fail the run for a reason that has nothing to do with the code. This
  // shape has no order to get wrong.
  const answerRunWith = (impl) => {
    globalThis.fetch.mockImplementation(async (url, ...rest) => {
      if (String(url).includes("/run")) return impl(url, ...rest);
      return { ok: true, status: 200, json: async () => ({ heartbeats: [] }) };
    });
  };

  beforeEach(() => {
    globalThis.fetch.mockClear();
    vi.stubGlobal("confirm", vi.fn(() => true));
    statusEl().textContent = "";
  });

  // `mockClear` keeps implementations, so without this the last test's
  // routing would outlive the block and answer the rest of the file.
  afterEach(() => {
    globalThis.fetch.mockReset();
    globalThis.fetch.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ models: [], conversations: [], personas: [], messages: [], heartbeats: [] }),
    }));
  });

  // The control for every assertion below: the same press against a server
  // that accepts it must still produce the queued line. Without this, a fix
  // that reported failure unconditionally would pass all three.
  it("still says queued when the run is actually accepted", async () => {
    answerRunWith(async () => ({
      ok: true, status: 200, json: async () => ({ status: "queued" }),
    }));
    press();
    await vi.waitFor(() => expect(statusEl().textContent).toBe("Queued — runs within ~5s."));
  });

  it("does not claim queued when the server refuses the run", async () => {
    answerRunWith(async () => ({
      ok: false, status: 404, json: async () => ({ error: "heartbeat not found" }),
    }));
    press();
    await vi.waitFor(() => expect(statusEl().textContent).toContain("heartbeat not found"));
    expect(statusEl().textContent).not.toContain("Queued");
  });

  it("names the status code when the error body carries no message", async () => {
    answerRunWith(async () => ({
      ok: false, status: 502, json: async () => { throw new Error("not json"); },
    }));
    press();
    await vi.waitFor(() => expect(statusEl().textContent).toContain("502"));
    expect(statusEl().textContent).not.toContain("Queued");
  });

  it("says the request never left the device when fetch rejects", async () => {
    answerRunWith(async () => { throw new TypeError("Failed to fetch"); });
    press();
    await vi.waitFor(() => expect(statusEl().textContent).toContain("could not reach Agora"));
  });

  // The second casualty of the throw: `setTimeout(renderHeartbeatStudio, 1500)`
  // sits after the try, so an unhandled rejection skipped it and the row was
  // never refreshed either.
  it("still re-renders the studio after a rejected fetch", async () => {
    vi.useFakeTimers();
    try {
      answerRunWith(async () => { throw new TypeError("Failed to fetch"); });
      press();
      await vi.waitFor(() => expect(statusEl().textContent).toContain("could not reach Agora"));
      const before = globalThis.fetch.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1600);
      expect(globalThis.fetch.mock.calls.length).toBeGreaterThan(before);
    } finally {
      vi.useRealTimers();
    }
  });
});
