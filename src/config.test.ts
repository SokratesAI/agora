import { describe, expect, it } from "vitest";

import { DEFAULT_VAPID_SUBJECT, loadConfig } from "./config.js";

// This repository is public. Anything hardcoded as a fallback here is
// readable by anyone and stays in the git history forever, so the defaults
// must not carry a real person's contact details. The VAPID subject was
// a personal Gmail address until 2026-08-16; these tests exist so a
// future edit cannot quietly put a personal mailbox back.
describe("default VAPID subject", () => {
  it("is a mailto: address", () => {
    expect(DEFAULT_VAPID_SUBJECT).toMatch(/^mailto:[^@\s]+@[^@\s]+$/);
  });

  // Deliberately an allow-list, not a list of banned addresses. A denylist
  // only ever catches the leak that already happened: the first version of
  // this test excluded the two addresses known to have appeared in this
  // project's history, which meant any *other* personal mailbox would have
  // passed it silently. Adding an address here should be a decision someone
  // makes on purpose, so the default cannot drift into a private mailbox
  // without a reviewer seeing it in the diff.
  const APPROVED_SUBJECTS = [
    // The project account. Already visible in every commit's metadata of
    // this repository, and a real inbox, which is what the push service
    // needs the subject to be.
    "mailto:sokratesai.mail@gmail.com",
  ];

  it("is an explicitly approved project address", () => {
    expect(APPROVED_SUBJECTS).toContain(DEFAULT_VAPID_SUBJECT);
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
