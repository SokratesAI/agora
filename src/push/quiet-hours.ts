/**
 * Quiet hours for phone notifications.
 *
 * Nova's heartbeat runs every 72 minutes (2026-08-08), which is roughly
 * seven replies between 22:00 and 08:00 — and every reply push-notifies
 * Edvard's phone. Suppressing the *message* would be the wrong fix: the
 * cycle still runs, still replies, and the reply still lands in the
 * conversation to read in the morning. Only the push is held back.
 *
 * This is a property of the phone rather than of any one persona, so it
 * lives here and applies to every notify caller, not per-heartbeat.
 */

/** A wall-clock window, as minutes since local midnight. */
export interface QuietHours {
  startMinute: number;
  endMinute: number;
}

const HH_MM = /^(\d{2}):(\d{2})$/;

function parseTime(value: string): number | undefined {
  const match = HH_MM.exec(value.trim());
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return undefined;
  return hour * 60 + minute;
}

/**
 * Build a window from two "HH:MM" strings. Anything unparseable — or an
 * empty/absent value — disables quiet hours rather than wedging startup,
 * because a typo in an env var must not be able to stop the deploy.
 */
export function parseQuietHours(
  start: string | undefined,
  end: string | undefined,
): QuietHours | undefined {
  if (!start || !end) return undefined;
  const startMinute = parseTime(start);
  const endMinute = parseTime(end);
  if (startMinute === undefined || endMinute === undefined) return undefined;
  // A zero-length window means "never quiet", which is a sane reading of
  // 23:00-23:00 and keeps the wrap-around branch below unambiguous.
  if (startMinute === endMinute) return undefined;
  return { startMinute, endMinute };
}

/**
 * Local wall-clock minutes in `timeZone`. Intl does the DST arithmetic, so
 * 23:00 stays 23:00 across the October and March transitions instead of
 * drifting by an hour like a fixed UTC offset would.
 */
function localMinutes(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  const minute = Number(parts.find((p) => p.type === "minute")?.value);
  return hour * 60 + minute;
}

/**
 * Is `now` inside the window? The window is half-open — quiet at exactly
 * 23:00, audible again at exactly 07:00 — so a notification never falls in
 * a crack between two adjacent windows.
 */
export function isQuiet(
  window: QuietHours | undefined,
  timeZone: string,
  now: Date = new Date(),
): boolean {
  if (!window) return false;
  const minutes = localMinutes(now, timeZone);
  if (window.startMinute < window.endMinute) {
    return minutes >= window.startMinute && minutes < window.endMinute;
  }
  // Wraps midnight (the normal case: 23:00 -> 07:00).
  return minutes >= window.startMinute || minutes < window.endMinute;
}
