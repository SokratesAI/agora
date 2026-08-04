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
