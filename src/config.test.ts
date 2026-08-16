import { describe, expect, it } from "vitest";

import { DEFAULT_VAPID_SUBJECT, loadConfig } from "./config.js";

// This repository is public. Anything hardcoded as a fallback here is
// readable by anyone and stays in the git history forever, so the defaults
// must not carry a real person's contact details. The VAPID subject was
// Edvard's personal Gmail address until 2026-08-16; these tests exist so a
// future edit cannot quietly put a personal mailbox back.
describe("default VAPID subject", () => {
  it("is a mailto: address", () => {
    expect(DEFAULT_VAPID_SUBJECT).toMatch(/^mailto:[^@\s]+@[^@\s]+$/);
  });

  it("is not a personal mailbox", () => {
    // The two addresses that have actually appeared in this project's
    // history, plus the surname they belong to.
    const personal = [
      "edvardgbakken@gmail.com",
      "edvard_bakken@live.no",
      "bakken",
      "gjessing",
    ];
    for (const needle of personal) {
      expect(DEFAULT_VAPID_SUBJECT.toLowerCase()).not.toContain(needle);
    }
  });

  it("is what loadConfig falls back to when VAPID_SUBJECT is unset", () => {
    const config = loadConfig({});
    expect(config.vapidSubject).toBe(DEFAULT_VAPID_SUBJECT);
  });

  it("still lets a deployment override the subject", () => {
    const config = loadConfig({ VAPID_SUBJECT: "mailto:ops@example.com" });
    expect(config.vapidSubject).toBe("mailto:ops@example.com");
  });
});
