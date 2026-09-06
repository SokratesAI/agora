import { createHash } from "node:crypto";

import type { Message } from "./conversation-store.js";

/** Fingerprint of `messages[0..endIndex]` — the exact prefix a polling client
 * claims to be holding. The client never computes this; it echoes back the
 * string the server last handed it, and the server re-derives the truth. That
 * asymmetry is deliberate: it means an incremental reply is only ever sent
 * when the server itself can still see the history the client is built on,
 * and no client-side cache-invalidation call site can be forgotten.
 *
 * The three inputs are exactly the three things any mutation path touches:
 * `id` covers append and delete, `text` covers edit-and-resend, `forgotten`
 * covers the forget toggle. Hashing the full text rather than its length is
 * what catches a same-length edit of the newest message, made from a second
 * device — the one case a length would call unchanged. Measured on the
 * largest real conversation (620 messages, 790KB of text): 1.79ms per call,
 * so 3.6ms for the two an incremental request makes. That is paid only on the
 * incremental path, and it buys not serialising and compressing 800KB.
 *
 * It lives here rather than in `server.ts` because `ConversationStore` needs
 * the same number for the conversation list's `rev` (issue #30, fix 3), and
 * that only works if the two are one implementation — a client compares a
 * `rev` from the list against a `rev` from `/messages` and must be able to
 * conclude "unchanged" from equality. Two copies that agree today is exactly
 * the shape that silently stops answering later. */
export function prefixRev(messages: Message[], endIndex: number): string {
  const hash = createHash("sha1");
  for (let i = 0; i <= endIndex; i++) {
    const message = messages[i];
    // JSON rather than a delimiter string: its own escaping is what keeps
    // ["a","b"] apart from ["ab"], so there is no separator to pick and no
    // way for message text to impersonate one.
    hash.update(JSON.stringify([message.id, message.forgotten === true, message.text]));
  }
  return hash.digest("hex").slice(0, 16);
}
