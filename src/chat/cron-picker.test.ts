/* Tests for public/cron.js -- the browser file itself, not a copy of it.
 *
 * It lives here rather than beside cron.js because the Dockerfile copies
 * public/ wholesale into the image, so a test file in there would be served
 * as a static asset.
 *
 * public/ has never had a test in it: app.js is 2300+ lines of top-level DOM
 * access and vitest runs in a node environment, so every frontend change so
 * far has shipped unverified (Nova's issues.md says so, twice, after having
 * to re-fix one). The schedule picker is pure logic sitting in front of a
 * value the runner will act on for months, which is exactly the kind of code
 * that should not be the exception.
 *
 * The dodge that makes it testable: cron.js is a classic script that takes
 * its global object as an argument, so it can be read off disk and evaluated
 * against a bare object here. No bundler, no jsdom, and no second copy of the
 * logic that could drift from the one the browser downloads. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const sandbox: Record<string, any> = {};
// eslint-disable-next-line no-new-func
new Function("window", readFileSync(path.join(here, "..", "..", "public", "cron.js"), "utf8"))(sandbox);
const { parseField, isValidCron, firingTimes, describeCron, compileCron, decodeCron } =
  sandbox.AgoraCron;

describe("cron fields", () => {
  it("expands the forms the runner accepts", () => {
    expect(parseField("*", 4)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(parseField("1-5", 4)).toEqual([1, 2, 3, 4, 5]);
    expect(parseField("8,20", 1)).toEqual([8, 20]);
    expect(parseField("8-22/2", 1)).toEqual([8, 10, 12, 14, 16, 18, 20, 22]);
    expect(parseField("*/15", 0)).toEqual([0, 15, 30, 45]);
  });

  it("treats 7 and 0 as the same Sunday", () => {
    expect(parseField("7", 4)).toEqual([0]);
    expect(parseField("0", 4)).toEqual([0]);
    // 1-7 is Mon-Sun, so folding 7 must not produce a duplicate 0.
    expect(parseField("1-7", 4)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("rejects what the runner would reject", () => {
    expect(parseField("60", 0)).toBeNull();
    expect(parseField("24", 1)).toBeNull();
    expect(parseField("8-2", 1)).toBeNull();
    expect(parseField("*/0", 1)).toBeNull();
    expect(parseField("5/15", 1)).toBeNull();
    expect(parseField("eight", 1)).toBeNull();
    expect(parseField("", 1)).toBeNull();
    expect(isValidCron("0 8 * *")).toBe(false);
    expect(isValidCron("0 8 * * * *")).toBe(false);
    expect(isValidCron("")).toBe(false);
    expect(isValidCron("0 8 * * 1-5")).toBe(true);
  });
});

describe("what the form shows before you save", () => {
  it("reports the cross product, not the times you asked for", () => {
    // The trap this whole file exists for: 08:00 and 20:30 is FOUR firings.
    expect(compileCron([0, 1, 2, 3, 4, 5, 6], ["08:00", "20:30"])).toBe("0,30 8,20 * * *");
    expect(firingTimes("0,30 8,20 * * *")).toEqual(["08:00", "08:30", "20:00", "20:30"]);
  });

  it("describes Edvard's three cases in English", () => {
    expect(describeCron("0 8 * * 1-5")).toBe("08:00, Mon–Fri (Oslo time)");
    expect(describeCron("0 8,20 * * *")).toBe("08:00 and 20:00, every day (Oslo time)");
    expect(describeCron("0 8-22/2 * * *")).toBe(
      "8 times a day, from 08:00 to 22:00, every day (Oslo time)",
    );
  });

  it("collapses runs of days but keeps gaps", () => {
    expect(describeCron("0 9 * * 1,3,5")).toBe("09:00, Mon, Wed, Fri (Oslo time)");
    expect(describeCron("0 9 * * 0,6")).toBe("09:00, Sun, Sat (Oslo time)");
  });

  it("spells out the OR when day-of-month and day-of-week are both set", () => {
    expect(describeCron("0 8 1 * 1")).toBe("08:00, Mon or on day 1 of the month (Oslo time)");
    expect(describeCron("0 8 1,15 * *")).toBe("08:00, on day 1, 15 of the month (Oslo time)");
  });

  it("returns null rather than a half-truth for junk", () => {
    expect(describeCron("0 8 * *")).toBeNull();
    expect(firingTimes("nonsense")).toBeNull();
  });
});

describe("round-tripping through the picker", () => {
  it("writes runs as ranges, the way a person would", () => {
    expect(compileCron([1, 2, 3, 4, 5], ["08:00"])).toBe("0 8 * * 1-5");
    // A run of two is not shorter as a range, so it stays a list.
    expect(compileCron([1, 2], ["08:00"])).toBe("0 8 * * 1,2");
    expect(compileCron([1, 3, 5], ["09:00", "10:00", "11:00"])).toBe("0 9-11 * * 1,3,5");
  });

  it("compiles and decodes back to the same state", () => {
    for (const state of [
      { days: [1, 2, 3, 4, 5], times: ["08:00"] },
      { days: [0, 1, 2, 3, 4, 5, 6], times: ["08:00", "20:00"] },
      { days: [0, 6], times: ["10:30"] },
    ]) {
      const expr = compileCron(state.days, state.times);
      expect(decodeCron(expr)).toEqual(state);
    }
  });

  it("is a fixed point even where the cross product added times", () => {
    // Decoding reports the four real firings; recompiling those four must not
    // then grow the schedule again, or editing a saved heartbeat would drift
    // every time the form was opened.
    const once = compileCron([0, 1, 2, 3, 4, 5, 6], ["08:00", "20:30"]);
    const decoded = decodeCron(once)!;
    expect(compileCron(decoded.days, decoded.times)).toBe(once);
  });

  it("declines to decode a schedule the picker has no control for", () => {
    // Day-of-month and month have no chips in the form. Decoding these would
    // silently drop the restriction on the next save.
    expect(decodeCron("0 8 1 * *")).toBeNull();
    expect(decodeCron("0 8 * 1-6 *")).toBeNull();
    expect(decodeCron("0 8 * * 1-5")).not.toBeNull();
  });

  it("never compiles an empty field", () => {
    // An empty picker still has to produce something the runner can parse.
    expect(isValidCron(compileCron([], []))).toBe(true);
    expect(compileCron([], [])).toBe("0 0 * * *");
  });
});
