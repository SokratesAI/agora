import { describe, it, expect } from "vitest";
import { parseQuietHours, isQuiet } from "./quiet-hours.js";
import { loadConfig } from "../config.js";

const OSLO = "Europe/Oslo";

/** 2026-08-08 is CEST (UTC+2), so 21:00Z is 23:00 in Oslo. */
function utc(iso: string): Date {
  return new Date(iso);
}

describe("parseQuietHours", () => {
  it("parses HH:MM into minutes since midnight", () => {
    expect(parseQuietHours("23:00", "07:00")).toEqual({ startMinute: 1380, endMinute: 420 });
    expect(parseQuietHours("00:30", "06:45")).toEqual({ startMinute: 30, endMinute: 405 });
  });

  it("disables rather than throwing on anything unparseable", () => {
    // A typo in an env var must not be able to wedge the deploy.
    expect(parseQuietHours("2300", "07:00")).toBeUndefined();
    expect(parseQuietHours("23:00", "nonsense")).toBeUndefined();
    expect(parseQuietHours("24:00", "07:00")).toBeUndefined();
    expect(parseQuietHours("23:60", "07:00")).toBeUndefined();
    expect(parseQuietHours("", "07:00")).toBeUndefined();
    expect(parseQuietHours(undefined, "07:00")).toBeUndefined();
  });

  it("treats a zero-length window as no quiet hours at all", () => {
    expect(parseQuietHours("23:00", "23:00")).toBeUndefined();
  });
});

describe("isQuiet", () => {
  const night = parseQuietHours("23:00", "07:00");

  it("is quiet inside a window that wraps midnight", () => {
    expect(isQuiet(night, OSLO, utc("2026-08-08T21:00:00Z"))).toBe(true); // 23:00 Oslo
    expect(isQuiet(night, OSLO, utc("2026-08-08T23:30:00Z"))).toBe(true); // 01:30 Oslo
    expect(isQuiet(night, OSLO, utc("2026-08-09T04:59:00Z"))).toBe(true); // 06:59 Oslo
  });

  it("is audible outside it", () => {
    expect(isQuiet(night, OSLO, utc("2026-08-08T20:59:00Z"))).toBe(false); // 22:59 Oslo
    expect(isQuiet(night, OSLO, utc("2026-08-09T05:00:00Z"))).toBe(false); // 07:00 Oslo
    expect(isQuiet(night, OSLO, utc("2026-08-08T12:00:00Z"))).toBe(false); // 14:00 Oslo
  });

  it("is half-open, so the boundaries belong to exactly one side", () => {
    expect(isQuiet(night, OSLO, utc("2026-08-08T21:00:00Z"))).toBe(true); // 23:00 quiet
    expect(isQuiet(night, OSLO, utc("2026-08-09T05:00:00Z"))).toBe(false); // 07:00 audible
  });

  it("handles a window that does not wrap midnight", () => {
    const daytime = parseQuietHours("09:00", "17:00");
    expect(isQuiet(daytime, OSLO, utc("2026-08-08T10:00:00Z"))).toBe(true); // 12:00 Oslo
    expect(isQuiet(daytime, OSLO, utc("2026-08-08T06:00:00Z"))).toBe(false); // 08:00 Oslo
    expect(isQuiet(daytime, OSLO, utc("2026-08-08T20:00:00Z"))).toBe(false); // 22:00 Oslo
  });

  it("reads the window in Oslo wall clock across the DST change, not a fixed offset", () => {
    // CEST (UTC+2): 21:30Z is 23:30 Oslo -> quiet.
    expect(isQuiet(night, OSLO, utc("2026-08-08T21:30:00Z"))).toBe(true);
    // CET (UTC+1) in December: the same 21:30Z is 22:30 Oslo -> not quiet yet.
    expect(isQuiet(night, OSLO, utc("2026-12-08T21:30:00Z"))).toBe(false);
    // ...and 22:30Z in December is 23:30 Oslo -> quiet.
    expect(isQuiet(night, OSLO, utc("2026-12-08T22:30:00Z"))).toBe(true);
  });

  it("is never quiet when the window is disabled", () => {
    expect(isQuiet(undefined, OSLO, utc("2026-08-08T23:30:00Z"))).toBe(false);
  });
});

describe("loadConfig quiet hours", () => {
  it("defaults to 23:00-07:00 Oslo with no env set", () => {
    const config = loadConfig({} as NodeJS.ProcessEnv);
    expect(config.quietHours).toEqual({ startMinute: 1380, endMinute: 420 });
    expect(config.quietHoursTimeZone).toBe("Europe/Oslo");
  });

  it("is turned off by an empty QUIET_HOURS_START", () => {
    const config = loadConfig({ QUIET_HOURS_START: "" } as NodeJS.ProcessEnv);
    expect(config.quietHours).toBeUndefined();
  });

  it("takes the window and zone from the environment", () => {
    const config = loadConfig({
      QUIET_HOURS_START: "22:30",
      QUIET_HOURS_END: "08:15",
      QUIET_HOURS_TZ: "UTC",
    } as NodeJS.ProcessEnv);
    expect(config.quietHours).toEqual({ startMinute: 1350, endMinute: 495 });
    expect(config.quietHoursTimeZone).toBe("UTC");
  });
});
