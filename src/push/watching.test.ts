import { describe, it, expect } from "vitest";
import { createWatchers, WATCHING_TTL_MS } from "./watching.js";

const T0 = 1_000_000;

describe("createWatchers", () => {
  it("does not vouch for a conversation nobody has pinged", () => {
    const watchers = createWatchers();
    expect(watchers.isWatched("c1", T0)).toBe(false);
  });

  it("vouches for a conversation for the length of the TTL and no longer", () => {
    const watchers = createWatchers();
    watchers.mark("c1", T0);
    expect(watchers.isWatched("c1", T0)).toBe(true);
    expect(watchers.isWatched("c1", T0 + WATCHING_TTL_MS - 1)).toBe(true);
    // Exactly at the TTL is expired: a client that stops pinging must go
    // back to being notified, and the boundary is where that starts.
    expect(watchers.isWatched("c1", T0 + WATCHING_TTL_MS)).toBe(false);
  });

  it("keeps conversations apart", () => {
    const watchers = createWatchers();
    watchers.mark("c1", T0);
    expect(watchers.isWatched("c2", T0)).toBe(false);
  });

  it("extends the window on each new ping rather than counting from the first", () => {
    const watchers = createWatchers(100);
    watchers.mark("c1", T0);
    watchers.mark("c1", T0 + 90);
    expect(watchers.isWatched("c1", T0 + 150)).toBe(true);
    expect(watchers.isWatched("c1", T0 + 190)).toBe(false);
  });

  it("treats a backwards clock jump as stale rather than as fresh", () => {
    const watchers = createWatchers();
    watchers.mark("c1", T0);
    expect(watchers.isWatched("c1", T0 - 1)).toBe(false);
  });

  it("drops expired entries instead of growing forever", () => {
    const watchers = createWatchers(100);
    watchers.mark("old", T0);
    watchers.mark("fresh", T0 + 500);
    // Gone from the map, not merely reported stale: `isWatched` would answer
    // false either way, so only the size can tell the two apart.
    expect(watchers.size()).toBe(1);
    expect(watchers.isWatched("old", T0 + 500)).toBe(false);
    expect(watchers.isWatched("fresh", T0 + 500)).toBe(true);
  });
});
