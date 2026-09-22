import { describe, expect, it } from "vitest";

import { DEFAULT_VAPID_SUBJECT, loadConfig, parseAppPersonas, parseAppTokens } from "./config.js";

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

describe("tailnet listener port", () => {
  it("defaults to 8085", () => {
    expect(loadConfig({}).tailnetPort).toBe(8085);
  });

  it("is 0, which turns the listener off, when TAILNET_PORT=0", () => {
    expect(loadConfig({ TAILNET_PORT: "0" }).tailnetPort).toBe(0);
  });
});

describe("parseAppTokens (issue #286)", () => {
  it("maps each token to the one app it speaks as", () => {
    expect(parseAppTokens(undefined).size).toBe(0);
    expect(parseAppTokens("  ").size).toBe(0);
    const tokens = parseAppTokens('{"Lyceum":"a","Marcus":"b"}');
    expect(tokens.get("a")).toBe("Lyceum");
    expect(tokens.get("b")).toBe("Marcus");
    expect(loadConfig({ AGORA_APP_TOKENS: '{"Lyceum":"a"}' }).appTokens.get("a")).toBe("Lyceum");
  });

  it("refuses a value that would give a half-working guard", () => {
    expect(() => parseAppTokens("not json")).toThrow();
    expect(() => parseAppTokens('["a"]')).toThrow(/JSON object/);
    expect(() => parseAppTokens('{"Lyceum":""}')).toThrow(/non-empty/);
    expect(() => parseAppTokens('{"Lyceum":1}')).toThrow(/non-empty/);
    expect(() => parseAppTokens('{"Lyceum":"a","Marcus":"a"}')).toThrow(/shares a token/);
  });
});

describe("parseAppPersonas (issue #286)", () => {
  it("reads app -> persona ids and refuses anything malformed", () => {
    expect(parseAppPersonas(undefined).size).toBe(0);
    expect(parseAppPersonas(" ").size).toBe(0);
    expect([...parseAppPersonas('{"Lyceum":["p1","p2"]}').get("Lyceum")!]).toEqual(["p1", "p2"]);
    expect(loadConfig({ AGORA_APP_PERSONAS: '{"Lyceum":["p1"]}' }).appPersonas.get("Lyceum")?.has("p1")).toBe(true);
    expect(() => parseAppPersonas("nope")).toThrow();
    expect(() => parseAppPersonas('["p1"]')).toThrow(/JSON object/);
    expect(() => parseAppPersonas('{"Lyceum":"p1"}')).toThrow(/non-empty persona ids/);
    expect(() => parseAppPersonas('{"Lyceum":[""]}')).toThrow(/non-empty persona ids/);
    expect(() => parseAppPersonas('{"Lyceum":[1]}')).toThrow(/non-empty persona ids/);
  });
});
