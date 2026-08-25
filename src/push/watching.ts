/**
 * "He is already reading this, somewhere else."
 *
 * The service worker has always had the rule *"Do not send notifications if
 * the app is open"* — a visible Agora tab sees the message live, so a phone
 * buzz on top of it is noise. That check asks `clients.matchAll()`, which can
 * only see Agora's own windows.
 *
 * Nova's chat dock talks to this conversation store over the internal API, so
 * a reply he is watching arrive in Nova still buzzes his phone from Agora —
 * the wrong app, for a message already on his screen. Edvard, capture
 * 2026-08-25: *"now when i use the new chat i get alerted by agora whenever a
 * new message arrives. This is not a huge problem, but its not high quality of
 * a product."*
 *
 * A different origin cannot be enumerated, so the reader says so instead: a
 * client with a conversation actually on screen POSTs
 * `/conversations/:id/presence`, and `notify` withholds the push while that is
 * fresh. "On screen" is the client's job to get right, and it is narrower than
 * "the page is loaded" — a shut chat panel on a tab nobody is looking at must
 * not vouch for him. The
 * message is appended either way — this withholds the buzz, never the reply,
 * exactly like quiet hours next door.
 *
 * Deliberately in memory and deliberately not persisted: presence that
 * survives a restart is a lie about where he is looking.
 */

/** How long one ping vouches for.
 *
 * Tied to the caller's poll cadence rather than picked round: Nova pings on
 * every ask-poll tick, which is 4s, so this is two and a half ticks. It has to
 * outlast a missed tick and no more — there is no way to *revoke* presence, so
 * whatever this is, it is also the window in which a phone he just locked keeps
 * vouching for him and a push he wanted is silently dropped. 30s bought
 * nothing over 10s and made that window three times longer.
 */
export const WATCHING_TTL_MS = 10_000;

export interface Watchers {
  /** Record that some client has this conversation on screen right now. */
  mark(conversationId: string, now: number): void;
  /** Was this conversation on someone's screen within the TTL? */
  isWatched(conversationId: string, now: number): boolean;
  /** How many entries are held. Exists so the pruning above is testable. */
  size(): number;
}

export function createWatchers(ttlMs: number = WATCHING_TTL_MS): Watchers {
  const seen = new Map<string, number>();

  return {
    mark(conversationId, now) {
      // Prune on write rather than on a timer: nothing here needs a background
      // task. Note this only runs when *some* client writes, so if every
      // client stops at once the last entries sit until the next ping — they
      // are stale to `isWatched` from the TTL onwards either way, so this
      // bounds the map against churn, not against idleness.
      for (const [id, at] of seen) {
        if (now - at >= ttlMs) seen.delete(id);
      }
      seen.set(conversationId, now);
    },
    isWatched(conversationId, now) {
      const at = seen.get(conversationId);
      if (at === undefined) return false;
      // A clock that jumps backwards must not make a stale ping look fresh.
      return now >= at && now - at < ttlMs;
    },
    size() {
      return seen.size;
    },
  };
}
