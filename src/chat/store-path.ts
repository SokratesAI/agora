import path from "node:path";

/**
 * Every on-disk store here keys a file by an id that arrives from an HTTP
 * route: `GET /personas/:id`, `GET /api/upload/:id`, and so on. Each of them
 * built the path with a bare `path.join(this.dir, id)`, which is not a join at
 * all once the id contains `..` -- `path.join("/data/personas", "../../etc")`
 * is `/etc`, and the store would then read, overwrite or unlink a file nothing
 * in this repo owns. CodeQL raised all ten sites on 2026-09-07 as
 * `js/path-injection`, high.
 *
 * The guard is deliberately a *rejection* and not a repair. `path.basename(id)`
 * would also make the path safe, and it is the fix that first comes to mind,
 * but it turns `../../etc/passwd` into `passwd` and then serves whatever
 * happens to be at that name -- a request that should have failed instead
 * succeeds against a different record. An id that is not a plain filename is a
 * caller error, so it throws.
 *
 * The character class is narrower than "no separators" on purpose: every id
 * these five stores mint is a `randomUUID()`, so letters, digits, `-`, `_` and
 * `.` cover the whole legal space with room to spare, and anything outside it
 * was never a key this loop wrote.
 */
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

export class UnsafeStoreIdError extends Error {
  constructor(id: string) {
    super(`unsafe store id: ${JSON.stringify(id)}`);
    this.name = "UnsafeStoreIdError";
  }
}

/**
 * The resolved `dir/<id><suffix>` when `id` is a single ordinary path segment, and **null**
 * when it is not: an empty id, `.`, `..`, or anything carrying a character
 * outside `SAFE_ID`, which includes both separators, so a percent-decoded
 * `..%2fetc` never reaches `path.join`.
 *
 * Null rather than a throw, and this is the part that took a second look.
 * Throwing reads as the stricter, more obviously safe choice -- but every
 * route in `server.ts` is an async Express 4 handler and this repo installs no
 * error middleware, so a throw from inside one is an unhandled rejection, and
 * Node's default for those is to end the process. That would turn
 * `GET /conversations/..%2f..%2fetc%2fpasswd` from a file read into a way to
 * stop Agora from one unauthenticated request, which is a worse bug than the
 * one this module closes. Every caller below already has a "there is no such
 * record" branch feeding a 404, and an id that cannot name a file in this
 * directory genuinely names no record, so null lands in the branch that was
 * already there and correct.
 */
export function storePath(dir: string, id: string, suffix = ""): string | null {
  if (typeof id !== "string" || !SAFE_ID.test(id) || id === "." || id === "..") {
    return null;
  }
  const base = path.resolve(dir);
  const resolved = path.resolve(path.normalize(path.join(base, `${id}${suffix}`)));
  // Belt and braces, in the containment form rather than a second look at the
  // id. SAFE_ID already excludes every separator, so this cannot fire today; it
  // is here so that widening the character class later cannot silently reopen
  // the hole this module was written to close. The trailing separator matters:
  // without it `/data/personas-backup` passes a prefix test against
  // `/data/personas`.
  if (!resolved.startsWith(base + path.sep) || path.dirname(resolved) !== base) {
    return null;
  }
  return resolved;
}
