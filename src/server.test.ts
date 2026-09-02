import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import pino from "pino";
import type { Express } from "express";
import {
  createPublicApp,
  createInternalApp,
  INTERNAL_HEARTBEAT_FIELDS,
  PUBLIC_HEARTBEAT_FIELDS,
  type ServerDeps,
  type WebPushSender,
  type InvokePayload,
} from "./server.js";
import { SubscriptionStore, type PushSubscriptionRecord } from "./push/subscription-store.js";
import { MessageStore } from "./chat/message-store.js";
import { WATCHING_TTL_MS } from "./push/watching.js";
import { MODEL_CATALOG } from "./models.js";
import { ConversationStore } from "./chat/conversation-store.js";
import { PersonaStore } from "./chat/persona-store.js";
import { HeartbeatStore } from "./chat/heartbeat-store.js";
import { WorkflowStore } from "./chat/workflow-store.js";
import { AuditStore } from "./chat/audit-store.js";
import { AttachmentStore } from "./chat/attachment-store.js";
import { FolderStore } from "./chat/folder-store.js";
import { RouteUsageStore } from "./chat/route-usage-store.js";
import type { Config } from "./config.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const validSubscription: PushSubscriptionRecord = {
  endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
  keys: { p256dh: "pubkey", auth: "authsecret" },
};

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 8080,
    internalPort: 8081,
    dataDir: "/tmp/unused",
    vapidPublicKey: "test-public-key",
    vapidPrivateKey: "test-private-key",
    vapidSubject: "mailto:test@example.com",
    runnerUrl: undefined,
    agentToken: undefined,
    quietHours: undefined,
    quietHoursTimeZone: "Europe/Oslo",
    ...overrides,
  };
}

async function makeDeps(configOverrides: Partial<Config> = {}): Promise<
  ServerDeps & { dir: string; invokeMock: ReturnType<typeof vi.fn> }
> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-server-test-"));
  const invokeMock = vi.fn(async (_payload: InvokePayload) => "mock reply");
  const webPush: WebPushSender = { sendNotification: vi.fn().mockResolvedValue(undefined) };
  return {
    dir,
    invokeMock,
    config: makeConfig(configOverrides),
    store: new SubscriptionStore(dir),
    messages: new MessageStore(dir),
    conversations: new ConversationStore(dir),
    personas: new PersonaStore(dir),
    heartbeats: new HeartbeatStore(dir),
    workflows: new WorkflowStore(dir),
    audit: new AuditStore(dir),
    attachments: new AttachmentStore(dir),
    folders: new FolderStore(dir),
    // 60s so no flush timer fires into a torn-down temp dir; these tests read
    // the snapshot, not the file.
    routeUsage: new RouteUsageStore(dir, 60_000),
    webPush,
    logger: pino({ enabled: false }),
    invokeRunner: invokeMock,
  };
}

describe("agora public app", () => {
  let deps: Awaited<ReturnType<typeof makeDeps>>;
  let app: Express;

  beforeEach(async () => {
    deps = await makeDeps();
    app = createPublicApp(deps);
  });

  it("GET /healthz always returns 200", async () => {
    expect((await request(app).get("/healthz")).status).toBe(200);
  });

  // The front end this app used to serve was deleted 2026-09-02 on Edvard's
  // own capture -- "I do not use agora app anymore. Cut it." -- after
  // `/route-usage` showed its only human caller was one Android browser.
  // `express.static("public")` went with it, and this is what refuses to let
  // it back in by accident: a mount would answer these instead of 404ing.
  it.each(["/", "/index.html", "/app.js", "/cron.js", "/sw.js", "/manifest.json", "/icon.svg"])(
    "serves no front end at %s",
    async (path) => {
      expect((await request(app).get(path)).status).toBe(404);
    },
  );

  describe("route usage", () => {
    it("records a matched request under its route template, not its URL", async () => {
      // Two different ids, so a store keying on the URL would show two entries.
      await request(app).get("/conversations/conv-aaa/messages");
      await request(app).get("/conversations/conv-bbb/messages");

      const usage = await request(app).get("/route-usage");
      expect(usage.status).toBe(200);
      const entry = usage.body.entries.find(
        (e: { key: string }) => e.key === "GET /conversations/:id/messages",
      );
      expect(entry).toBeDefined();
      expect(entry.count).toBe(2);
      expect(entry.unmatched).toBe(false);
      // The id is what makes this worth doing at the template level: an id in
      // a key would put one entry per conversation in the file.
      expect(JSON.stringify(usage.body)).not.toContain("conv-aaa");
    });

    it("records a request no route matched under its redacted path", async () => {
      await request(app).get("/definitely-not-a-route");

      const usage = await request(app).get("/route-usage");
      const entry = usage.body.entries.find(
        (e: { key: string }) => e.key === "GET /definitely-not-a-route",
      );
      expect(entry).toBeDefined();
      expect(entry.unmatched).toBe(true);
      expect(entry.statuses).toEqual({ "404": 1 });
    });

    it("keeps the caller's user-agent", async () => {
      await request(app).get("/healthz").set("user-agent", "Python-urllib/3.11");

      const usage = await request(app).get("/route-usage");
      const entry = usage.body.entries.find((e: { key: string }) => e.key === "GET /healthz");
      expect(entry.agents["Python-urllib/3.11"]).toBe(1);
    });

    it("503s rather than lying when no store is wired", async () => {
      const unwired = createPublicApp({ ...deps, routeUsage: undefined });
      expect((await request(unwired).get("/route-usage")).status).toBe(503);
    });
  });

  it("GET /health reflects VAPID configuration", async () => {
    expect((await request(app).get("/health")).status).toBe(200);
    const unconfigured = createPublicApp({
      ...deps,
      config: makeConfig({ vapidPublicKey: undefined, vapidPrivateKey: undefined }),
    });
    expect((await request(unconfigured).get("/health")).status).toBe(503);
  });

  it("POST /subscribe stores a valid subscription and rejects junk", async () => {
    expect((await request(app).post("/subscribe").send({ nope: true })).status).toBe(400);
    expect((await request(app).post("/subscribe").send(validSubscription)).status).toBe(201);
    expect(await deps.store.load()).toEqual(validSubscription);
  });

  it("does not mount /notify at all — that's the internal app's job", async () => {
    expect((await request(app).post("/notify").send({ text: "hi" })).status).toBe(404);
  });

  // ---- Legacy Main shims (ADR 0008) ------------------------------------
  it("POST /reply lazily creates a Main conversation with an Agora persona", async () => {
    const res = await request(app).post("/reply").send({ text: "hello" });
    expect(res.status).toBe(200);
    const main = await deps.conversations.findByName("Main");
    expect(main).not.toBeNull();
    expect(main?.messages).toMatchObject([{ sender: "Edvard", text: "hello" }]);
    expect(main?.personas?.[0].role).toBe("curator");
    const persona = await deps.personas.get(main!.personas![0].personaId);
    expect(persona?.name).toBe("Agora");
    // 2026-08-10: this bootstrap used to spell its default `MODEL_CATALOG[0].id`,
    // which is the metered Anthropic entry — so on a fresh install Edvard's own
    // assistant was created billing the prepaid balance. Asserting the name
    // alone passed either way.
    expect(MODEL_CATALOG.find((m) => m.id === persona?.model)?.metered).toBeUndefined();
  });

  it("creates an inline persona on a non-metered model when none is given", async () => {
    // The other MODEL_CATALOG[0] fallback: POST /conversations with inline
    // persona fields and no `model`.
    const res = await request(app)
      .post("/conversations")
      .send({ name: "Fresh", personality: "hi" });
    expect(res.status).toBe(201);
    const created = await deps.personas.list();
    const fresh = created.find((p) => p.name === "Fresh");
    expect(fresh).toBeDefined();
    expect(MODEL_CATALOG.find((m) => m.id === fresh?.model)?.metered).toBeUndefined();
  });

  it("GET /models reports the default alongside the catalog", async () => {
    // The client picks the initial <select> value from this rather than from
    // array order, so the two must not be able to drift.
    const res = await request(app).get("/models");
    expect(res.status).toBe(200);
    expect(typeof res.body.defaultModel).toBe("string");
    const chosen = MODEL_CATALOG.find((m) => m.id === res.body.defaultModel);
    expect(chosen).toBeDefined();
    expect(chosen?.metered).toBeUndefined();
  });

  it("GET /messages serves the Main conversation's thread", async () => {
    await request(app).post("/reply").send({ text: "first" });
    await request(app).post("/reply").send({ text: "second" });
    const res = await request(app).get("/messages");
    expect(res.body.messages.map((m: { text: string }) => m.text)).toEqual(["first", "second"]);
  });

  it("DELETE and PATCH /messages/:id operate on the Main conversation", async () => {
    const sent = await request(app).post("/reply").send({ text: "typo" });
    const edited = await request(app)
      .patch(`/messages/${sent.body.message.id}`)
      .send({ text: "fixed" });
    expect(edited.body.message.text).toBe("fixed");
    const deleted = await request(app).delete(`/messages/${sent.body.message.id}`);
    expect(deleted.status).toBe(200);
    expect((await deps.conversations.findByName("Main"))?.messages).toEqual([]);
  });

  // ---- Personas ---------------------------------------------------------
  it("POST /personas validates and creates with capability defaults", async () => {
    expect((await request(app).post("/personas").send({ name: "X" })).status).toBe(400);
    expect(
      (await request(app).post("/personas").send({ name: "X", model: "nope:nope" })).status,
    ).toBe(400);
    const res = await request(app)
      .post("/personas")
      .send({ name: "Marcus", model: "anthropic:claude-sonnet-5", personality: "trainer" });
    expect(res.status).toBe(201);
    expect(res.body.persona.capabilities).toMatchObject({
      webSearch: true,
      vaultRead: true,
      vaultWrite: false,
      codeExecution: false,
      kubectlRead: false,
      githubRead: false,
    });
  });

  it("PATCH /personas/:id merges partial capability updates", async () => {
    const created = await request(app)
      .post("/personas")
      .send({ name: "W", model: "anthropic:claude-sonnet-5" });
    const res = await request(app)
      .patch(`/personas/${created.body.persona.id}`)
      .send({ capabilities: { vaultWrite: true }, sharedMemory: "notes" });
    expect(res.status).toBe(200);
    expect(res.body.persona.capabilities.vaultWrite).toBe(true);
    expect(res.body.persona.capabilities.webSearch).toBe(true);
    expect(res.body.persona.sharedMemory).toBe("notes");
  });

  it("POST /personas accepts claudeCliRestricted, PATCH updates it", async () => {
    const created = await request(app).post("/personas").send({
      name: "CliBot",
      model: "claude-cli:claude-haiku-4-5-20251001",
      claudeCliRestricted: true,
    });
    expect(created.status).toBe(201);
    expect(created.body.persona.claudeCliRestricted).toBe(true);

    const patched = await request(app)
      .patch(`/personas/${created.body.persona.id}`)
      .send({ claudeCliRestricted: false });
    expect(patched.status).toBe(200);
    expect(patched.body.persona.claudeCliRestricted).toBe(false);
  });

  it("POST /personas accepts claudeCliStateless, PATCH updates it", async () => {
    const created = await request(app).post("/personas").send({
      name: "CliBot2",
      model: "claude-cli:claude-haiku-4-5-20251001",
      claudeCliStateless: true,
    });
    expect(created.status).toBe(201);
    expect(created.body.persona.claudeCliStateless).toBe(true);

    const patched = await request(app)
      .patch(`/personas/${created.body.persona.id}`)
      .send({ claudeCliStateless: false });
    expect(patched.status).toBe(200);
    expect(patched.body.persona.claudeCliStateless).toBe(false);
  });

  it("POST /personas accepts kubectlRead/githubRead capability flags", async () => {
    const res = await request(app).post("/personas").send({
      name: "Ops",
      model: "anthropic:claude-sonnet-5",
      capabilities: { kubectlRead: true, githubRead: true },
    });
    expect(res.status).toBe(201);
    expect(res.body.persona.capabilities.kubectlRead).toBe(true);
    expect(res.body.persona.capabilities.githubRead).toBe(true);
  });

  it("PATCH /personas keeps kubectlTest, which parseCapabilities used to drop", async () => {
    // The flag has to be named in three places -- the interface, the
    // defaults, and parseCapabilities' allowlist -- and only the third one
    // decides what survives a request. It was missing there first, and the
    // symptom is the worst kind: PATCH answered 200 "updated" and the read
    // back showed the old value, so the caller is told it worked.
    const created = await request(app).post("/personas").send({
      name: "Scratch",
      model: "anthropic:claude-sonnet-5",
    });
    expect(created.status).toBe(201);
    expect(created.body.persona.capabilities.kubectlTest).toBe(false);

    const patched = await request(app)
      .patch(`/personas/${created.body.persona.id}`)
      .send({ capabilities: { kubectlTest: true } });
    expect(patched.status).toBe(200);
    expect(patched.body.persona.capabilities.kubectlTest).toBe(true);

    const readBack = await request(app).get(`/personas/${created.body.persona.id}`);
    expect(readBack.body.persona.capabilities.kubectlTest).toBe(true);
    // and it is its own flag, not a synonym for the read-only one
    expect(readBack.body.persona.capabilities.kubectlRead).toBe(false);
  });

  it("POST /personas accepts the terminalExec capability flag, defaulted off", async () => {
    const off = await request(app).post("/personas").send({
      name: "NoShell",
      model: "anthropic:claude-sonnet-5",
    });
    expect(off.body.persona.capabilities.terminalExec).toBe(false);

    const on = await request(app).post("/personas").send({
      name: "Shell",
      model: "anthropic:claude-sonnet-5",
      capabilities: { terminalExec: true },
    });
    expect(on.status).toBe(201);
    expect(on.body.persona.capabilities.terminalExec).toBe(true);
  });

  // 2026-08-28: the runner has had a nova_capture tool and a novaCapture
  // capability key for weeks, but this key was missing from
  // PersonaCapabilities and from parseCapabilities' allowlist, so a request
  // asking for it was silently dropped and no persona could ever hold it.
  // The owner asked a chat persona to file an issue and it could not.
  it("POST /personas accepts the novaCapture capability flag, defaulted off", async () => {
    const off = await request(app).post("/personas").send({
      name: "NoCapture",
      model: "anthropic:claude-sonnet-5",
    });
    expect(off.body.persona.capabilities.novaCapture).toBe(false);

    const on = await request(app).post("/personas").send({
      name: "Capturer",
      model: "anthropic:claude-sonnet-5",
      capabilities: { novaCapture: true },
    });
    expect(on.status).toBe(201);
    expect(on.body.persona.capabilities.novaCapture).toBe(true);
  });

  it("PATCH /personas/:id can grant novaCapture without touching other capabilities", async () => {
    const created = await request(app).post("/personas").send({
      name: "Later",
      model: "anthropic:claude-sonnet-5",
      capabilities: { vaultRead: true },
    });
    const id = created.body.persona.id;
    const patched = await request(app)
      .patch(`/personas/${id}`)
      .send({ capabilities: { novaCapture: true } });
    expect(patched.status).toBe(200);
    expect(patched.body.persona.capabilities.novaCapture).toBe(true);
    expect(patched.body.persona.capabilities.vaultRead).toBe(true);
    expect(patched.body.persona.capabilities.terminalExec).toBe(false);
  });

  // 2026-08-29 (Cycle 613): list_conversations/read_conversation shipped
  // gated on manageAgora, which also creates personas, conversations,
  // heartbeats and workflows. So the only way to let a chat persona read
  // another conversation was to make it a platform admin. conversationRead
  // is that grant on its own; manageAgora still implies it in the runner.
  it("POST /personas accepts the conversationRead capability flag, defaulted off", async () => {
    const off = await request(app).post("/personas").send({
      name: "NoReader",
      model: "anthropic:claude-sonnet-5",
    });
    expect(off.body.persona.capabilities.conversationRead).toBe(false);

    const on = await request(app).post("/personas").send({
      name: "Reader",
      model: "anthropic:claude-sonnet-5",
      capabilities: { conversationRead: true },
    });
    expect(on.status).toBe(201);
    expect(on.body.persona.capabilities.conversationRead).toBe(true);
    // The whole point: it does NOT come with platform management.
    expect(on.body.persona.capabilities.manageAgora).toBe(false);
  });

  it("PATCH /personas/:id can grant conversationRead without touching other capabilities", async () => {
    const created = await request(app).post("/personas").send({
      name: "LaterReader",
      model: "anthropic:claude-sonnet-5",
      capabilities: { vaultRead: true },
    });
    const id = created.body.persona.id;
    const patched = await request(app)
      .patch(`/personas/${id}`)
      .send({ capabilities: { conversationRead: true } });
    expect(patched.status).toBe(200);
    expect(patched.body.persona.capabilities.conversationRead).toBe(true);
    expect(patched.body.persona.capabilities.vaultRead).toBe(true);
    expect(patched.body.persona.capabilities.manageAgora).toBe(false);
  });

  it("DELETE /personas/:id refuses while referenced by a conversation or heartbeat", async () => {
    const created = await request(app)
      .post("/personas")
      .send({ name: "Used", model: "anthropic:claude-sonnet-5" });
    const personaId = created.body.persona.id;
    const conversation = await request(app)
      .post("/conversations")
      .send({ name: "UsesIt", personaId });
    expect(conversation.status).toBe(201);

    const refused = await request(app).delete(`/personas/${personaId}`);
    expect(refused.status).toBe(409);
    expect(refused.body.conversations).toEqual(["UsesIt"]);

    // Unreferenced persona deletes fine.
    const lone = await request(app)
      .post("/personas")
      .send({ name: "Lone", model: "anthropic:claude-sonnet-5" });
    expect((await request(app).delete(`/personas/${lone.body.persona.id}`)).status).toBe(200);
  });

  it("POST /personas/:id/clone copies fields, never as template", async () => {
    const created = await request(app)
      .post("/personas")
      .send({ name: "T", model: "anthropic:claude-sonnet-5", isTemplate: true });
    const clone = await request(app)
      .post(`/personas/${created.body.persona.id}/clone`)
      .send({ name: "T-live" });
    expect(clone.status).toBe(201);
    expect(clone.body.persona.name).toBe("T-live");
    expect(clone.body.persona.isTemplate).toBe(false);
  });

  it("POST /personas/preview invokes the runner with inline persona, tool-less contract", async () => {
    const res = await request(app)
      .post("/personas/preview")
      .send({ personality: "draft", model: "anthropic:claude-sonnet-5", text: "hi" });
    expect(res.status).toBe(200);
    expect(res.body.reply).toBe("mock reply");
    const payload = deps.invokeMock.mock.calls[0][0] as InvokePayload;
    expect(payload.persona).toEqual({
      personality: "draft",
      model: "anthropic:claude-sonnet-5",
      thinking: false,
    });
    expect(payload.personaId).toBeUndefined();
  });

  it("preview 503s without a runner and 502s when invoke fails", async () => {
    const noRunner = createPublicApp({ ...deps, invokeRunner: undefined });
    expect(
      (
        await request(noRunner)
          .post("/personas/preview")
          .send({ model: "anthropic:claude-sonnet-5", text: "hi" })
      ).status,
    ).toBe(503);

    deps.invokeMock.mockRejectedValueOnce(new Error("boom"));
    expect(
      (
        await request(app)
          .post("/personas/preview")
          .send({ model: "anthropic:claude-sonnet-5", text: "hi" })
      ).status,
    ).toBe(502);
  });

  // ---- Conversations with personas --------------------------------------
  it("POST /conversations creates an inline persona and links it as curator", async () => {
    const res = await request(app)
      .post("/conversations")
      .send({ name: "Coach", personality: "p", model: "anthropic:claude-sonnet-5" });
    expect(res.status).toBe(201);
    expect(res.body.conversation.personas).toHaveLength(1);
    expect(res.body.conversation.personas[0].role).toBe("curator");
    expect(res.body.conversation.personality).toBe("p");
    const personas = await deps.personas.list();
    expect(personas.some((p) => p.name === "Coach")).toBe(true);
  });

  it("POST /conversations applies capabilities to the inline-created persona", async () => {
    const res = await request(app)
      .post("/conversations")
      .send({
        name: "Sentinel",
        personality: "watch the cluster",
        model: "gemini:gemini-flash-latest",
        capabilities: { kubectlRead: true, githubRead: true, vaultWrite: true },
      });
    expect(res.status).toBe(201);
    const personaId = res.body.conversation.personas[0].personaId;
    const persona = await deps.personas.get(personaId);
    expect(persona?.capabilities).toMatchObject({
      kubectlRead: true,
      githubRead: true,
      vaultWrite: true,
      // Untouched fields keep DEFAULT_CAPABILITIES, same merge as PATCH /personas.
      webSearch: true,
      vaultRead: true,
    });
  });

  it("GET /conversations reflects live curator persona edits, not the stale inline fields (regression, 2026-07-22)", async () => {
    const created = await request(app)
      .post("/conversations")
      .send({ name: "StaleCheck", personality: "old", model: "anthropic:claude-haiku-4-5-20251001" });
    const personaId = created.body.conversation.personas[0].personaId;

    // Edit the persona directly (as Persona Studio does), not through the
    // conversation PATCH shim — this is exactly what went stale live.
    await deps.personas.update(personaId, { model: "gemini:gemini-flash-latest", personality: "new" });

    const list = await request(app).get("/conversations");
    const entry = list.body.conversations.find((c: { id: string }) => c.id === created.body.conversation.id);
    expect(entry.personality).toBe("new");
    // ...but not the model. That one is the conversation's own as of idea
    // #95 slice 1, so editing the persona in Studio no longer repoints
    // conversations that were already created from it.
    expect(entry.model).toBe("anthropic:claude-haiku-4-5-20251001");
  });

  it("a conversation with no model of its own still falls back to the curator's", async () => {
    const created = await request(app)
      .post("/conversations")
      .send({ name: "Legacy", personality: "p", model: "anthropic:claude-haiku-4-5-20251001" });
    const id = created.body.conversation.id;
    const personaId = created.body.conversation.personas[0].personaId;

    // Every conversation stored before the create route copied the model
    // looks like this. The fallback is what keeps them working.
    await deps.conversations.update(id, { model: "" });
    await deps.personas.update(personaId, { model: "gemini:gemini-flash-latest" });

    const list = await request(app).get("/conversations");
    const entry = list.body.conversations.find((c: { id: string }) => c.id === id);
    expect(entry.model).toBe("gemini:gemini-flash-latest");
  });

  it("picking a model in one conversation leaves the others sharing that persona alone", async () => {
    // The bug this slice exists for: Nova's persona is the curator of one
    // conversation per cycle, so a model chosen in any one of them used to
    // be a model chosen in all of them.
    const first = await request(app)
      .post("/conversations")
      .send({ name: "Shared A", personality: "p", model: "anthropic:claude-sonnet-5" });
    const personaId = first.body.conversation.personas[0].personaId;
    const second = await request(app)
      .post("/conversations")
      .send({ name: "Shared B", personaId });
    expect(second.body.conversation.personas[0].personaId).toBe(personaId);
    expect(second.body.conversation.model).toBe("anthropic:claude-sonnet-5");

    await request(app)
      .patch(`/conversations/${first.body.conversation.id}`)
      .send({ model: "gemini:gemini-flash-latest" });

    const list = await request(app).get("/conversations");
    const other = list.body.conversations.find(
      (c: { id: string }) => c.id === second.body.conversation.id,
    );
    expect(other.model).toBe("anthropic:claude-sonnet-5");
    const persona = await deps.personas.get(personaId);
    expect(persona?.model).toBe("anthropic:claude-sonnet-5");
  });

  it("POST /conversations with personaId reuses an existing persona", async () => {
    const persona = await deps.personas.create({
      name: "Shared",
      model: "anthropic:claude-sonnet-5",
      personality: "shared brain",
    });
    const res = await request(app)
      .post("/conversations")
      .send({ name: "Chat A", personaId: persona.id });
    expect(res.status).toBe(201);
    expect(res.body.conversation.personas[0].personaId).toBe(persona.id);
    expect(res.body.conversation.personality).toBe("shared brain");
  });

  it("GET /conversations/:id/messages joins live curator persona fields", async () => {
    const created = await request(app)
      .post("/conversations")
      .send({ name: "Joined", personality: "old", model: "anthropic:claude-sonnet-5" });
    const conversationId = created.body.conversation.id;
    const personaId = created.body.conversation.personas[0].personaId;
    await deps.personas.update(personaId, { personality: "edited later" });

    const res = await request(app).get(`/conversations/${conversationId}/messages`);
    expect(res.body.personality).toBe("edited later");
    expect(res.body.personas[0].name).toBe("Joined");
    expect(res.body.status).toBe("active");
  });

  it("GET /conversations/:id/messages honors ?limit and reports totalMessages", async () => {
    const created = await request(app)
      .post("/conversations")
      .send({ name: "Long", model: "anthropic:claude-sonnet-5" });
    const id = created.body.conversation.id;
    for (let i = 0; i < 5; i++) {
      await request(app).post(`/conversations/${id}/reply`).send({ text: `m${i}` });
    }
    const res = await request(app).get(`/conversations/${id}/messages?limit=2`);
    expect(res.body.totalMessages).toBe(5);
    expect(res.body.messages.map((m: { text: string }) => m.text)).toEqual(["m3", "m4"]);
  });

  // ?after + ?rev. The drawer polls every 3s; re-sending the whole window each
  // time is what made a wide window unaffordable (issues.md #48), and a wide
  // window is what Edvard needs to see a cycle end to end. The contract these
  // tests pin: the server hands out a fingerprint of the prefix it just
  // covered, and answers incrementally only while its own history still
  // matches that fingerprint. Every one of them re-derives `rev` from a real
  // response rather than hard-coding it — the digest is an implementation
  // detail, the behaviour is not.
  describe("incremental message polling", () => {
    const texts = (body: { messages: { text: string }[] }) => body.messages.map((m) => m.text);

    // Named per call: POST /conversations returns the existing conversation
    // when the name matches, so two "Polled" threads are one thread.
    async function conversationWith(count: number, name = "Polled"): Promise<string> {
      const created = await request(app)
        .post("/conversations")
        .send({ name, model: "anthropic:claude-sonnet-5" });
      const id = created.body.conversation.id;
      for (let i = 0; i < count; i++) {
        await request(app).post(`/conversations/${id}/reply`).send({ text: `m${i}` });
      }
      return id;
    }

    const poll = (id: string, after: string, rev: string) =>
      request(app).get(`/conversations/${id}/messages?limit=200&after=${after}&rev=${rev}`);

    it("sends only what arrived after the client's last message", async () => {
      const id = await conversationWith(3);
      const first = await request(app).get(`/conversations/${id}/messages?limit=200`);
      expect(first.body.incremental).toBe(false);
      expect(texts(first.body)).toEqual(["m0", "m1", "m2"]);

      const last = first.body.messages[2].id;
      const caughtUp = await poll(id, last, first.body.rev);
      expect(caughtUp.body.incremental).toBe(true);
      expect(caughtUp.body.messages).toEqual([]);
      // Standing still must not move the fingerprint, or the next poll would
      // present a rev the server has never issued.
      expect(caughtUp.body.rev).toBe(first.body.rev);

      await request(app).post(`/conversations/${id}/reply`).send({ text: "m3" });
      const delta = await poll(id, last, first.body.rev);
      expect(delta.body.incremental).toBe(true);
      expect(texts(delta.body)).toEqual(["m3"]);
      expect(delta.body.totalMessages).toBe(4);
    });

    it("keeps answering incrementally as the client walks forward", async () => {
      const id = await conversationWith(2);
      let page = (await request(app).get(`/conversations/${id}/messages?limit=200`)).body;
      const seen = [...page.messages];

      for (let i = 0; i < 3; i++) {
        await request(app).post(`/conversations/${id}/reply`).send({ text: `later${i}` });
        page = (await poll(id, seen[seen.length - 1].id, page.rev)).body;
        expect(page.incremental).toBe(true);
        seen.push(...page.messages);
      }
      expect(seen.map((m: { text: string }) => m.text)).toEqual([
        "m0",
        "m1",
        "later0",
        "later1",
        "later2",
      ]);
      expect(seen).toHaveLength(page.totalMessages);
    });

    it("falls back to the full window, and says so, when the prefix changed", async () => {
      const id = await conversationWith(4);
      const first = await request(app).get(`/conversations/${id}/messages?limit=200`);
      const last = first.body.messages[3].id;

      // Forget an earlier message: the count is unchanged, so nothing but a
      // fingerprint over the messages themselves could notice this.
      await request(app)
        .post(`/conversations/${id}/messages/${first.body.messages[1].id}/forget`)
        .send({ forgotten: true });

      const res = await poll(id, last, first.body.rev);
      expect(res.body.incremental).toBe(false);
      expect(texts(res.body)).toEqual(["m0", "m1", "m2", "m3"]);
      expect(res.body.messages[1].forgotten).toBe(true);
      expect(res.body.rev).not.toBe(first.body.rev);
    });

    it("falls back when an earlier message was deleted", async () => {
      const id = await conversationWith(4);
      const first = await request(app).get(`/conversations/${id}/messages?limit=200`);
      const last = first.body.messages[3].id;

      await request(app).delete(`/conversations/${id}/messages/${first.body.messages[0].id}`);

      const res = await poll(id, last, first.body.rev);
      expect(res.body.incremental).toBe(false);
      expect(texts(res.body)).toEqual(["m1", "m2", "m3"]);
    });

    it("falls back when the client's own last message is gone", async () => {
      const id = await conversationWith(3);
      const first = await request(app).get(`/conversations/${id}/messages?limit=200`);
      const last = first.body.messages[2].id;

      await request(app).delete(`/conversations/${id}/messages/${last}`);

      const res = await poll(id, last, first.body.rev);
      expect(res.body.incremental).toBe(false);
      expect(texts(res.body)).toEqual(["m0", "m1"]);
    });

    it("ignores after/rev unless both are present, and never trusts a bare id", async () => {
      const id = await conversationWith(3);
      const first = await request(app).get(`/conversations/${id}/messages?limit=200`);
      const last = first.body.messages[2].id;

      const noRev = await request(app).get(
        `/conversations/${id}/messages?limit=200&after=${last}`,
      );
      expect(noRev.body.incremental).toBe(false);
      expect(texts(noRev.body)).toEqual(["m0", "m1", "m2"]);

      const wrongRev = await poll(id, last, "0000000000000000");
      expect(wrongRev.body.incremental).toBe(false);
      expect(texts(wrongRev.body)).toEqual(["m0", "m1", "m2"]);
    });

    it("distinguishes a same-length edit of the newest message", async () => {
      const id = await conversationWith(2);
      const first = await request(app).get(`/conversations/${id}/messages?limit=200`);
      const last = first.body.messages[1];

      // "m1" -> "z9": same id, same length, same position, same count. A
      // fingerprint over anything less than the text itself would call this
      // unchanged and the second device would never see the edit.
      await request(app)
        .patch(`/conversations/${id}/messages/${last.id}`)
        .send({ text: "z9" });

      const res = await poll(id, last.id, first.body.rev);
      expect(res.body.incremental).toBe(false);
      expect(texts(res.body)).toEqual(["m0", "z9"]);
    });

    it("does not answer incrementally across two different conversations", async () => {
      const a = await conversationWith(2, "Thread A");
      const b = await conversationWith(2, "Thread B");
      const fromA = await request(app).get(`/conversations/${a}/messages?limit=200`);

      const res = await poll(b, fromA.body.messages[1].id, fromA.body.rev);
      expect(res.body.incremental).toBe(false);
      expect(texts(res.body)).toEqual(["m0", "m1"]);
    });

    it("costs a fraction of the window it replaces", async () => {
      const id = await conversationWith(120);
      const first = await request(app).get(`/conversations/${id}/messages?limit=200`);
      await request(app).post(`/conversations/${id}/reply`).send({ text: "one more" });

      const delta = await poll(id, first.body.messages[119].id, first.body.rev);
      expect(delta.body.incremental).toBe(true);
      expect(texts(delta.body)).toEqual(["one more"]);
      // The saving is the whole point of the change, so it gets an assertion
      // rather than a comment. Enrichment metadata rides along on both.
      expect(JSON.stringify(delta.body).length).toBeLessThan(
        JSON.stringify(first.body).length / 4,
      );
    });
  });

  it("PATCH /conversations/:id routes personality to the curator persona and keeps the model on the conversation", async () => {
    const created = await request(app)
      .post("/conversations")
      .send({ name: "Edit", personality: "before", model: "anthropic:claude-sonnet-5" });
    const id = created.body.conversation.id;
    const personaId = created.body.conversation.personas[0].personaId;

    const res = await request(app)
      .patch(`/conversations/${id}`)
      .send({ personality: "after", model: "gemini:gemini-flash-latest", status: "paused" });
    expect(res.status).toBe(200);
    expect(res.body.conversation.personality).toBe("after");
    expect(res.body.conversation.model).toBe("gemini:gemini-flash-latest");
    expect(res.body.conversation.status).toBe("paused");

    const persona = await deps.personas.get(personaId);
    expect(persona?.personality).toBe("after");
    // The model edit stopped here (idea #95, slice 1) — the persona keeps
    // whatever it had.
    expect(persona?.model).toBe("anthropic:claude-sonnet-5");
  });

  it("PATCH /conversations/:id updates stickyFallback, defaults false, and returns it on GET", async () => {
    const created = await request(app)
      .post("/conversations")
      .send({ name: "Sticky", model: "gemini:gemini-flash-latest" });
    const id = created.body.conversation.id;
    expect(created.body.conversation.stickyFallback).toBe(false);

    const res = await request(app)
      .patch(`/conversations/${id}`)
      .send({ stickyFallback: true });
    expect(res.status).toBe(200);
    expect(res.body.conversation.stickyFallback).toBe(true);

    const list = await request(app).get("/conversations");
    const found = list.body.conversations.find((c: { id: string }) => c.id === id);
    expect(found.stickyFallback).toBe(true);
  });

  it("PATCH /conversations/:id validates persona link sets", async () => {
    const created = await request(app)
      .post("/conversations")
      .send({ name: "Multi", model: "anthropic:claude-sonnet-5" });
    const id = created.body.conversation.id;
    const curatorId = created.body.conversation.personas[0].personaId;
    const second = await deps.personas.create({
      name: "Second",
      model: "anthropic:claude-sonnet-5",
    });

    // two personas → 400, whatever their roles (idea #95)
    for (const role of ["curator", "listener"]) {
      expect(
        (
          await request(app)
            .patch(`/conversations/${id}`)
            .send({
              personas: [
                { personaId: curatorId, role: "curator" },
                { personaId: second.id, role },
              ],
            })
        ).status,
      ).toBe(400);
    }

    // the only surviving role is curator → a lone listener is 400 too
    expect(
      (
        await request(app)
          .patch(`/conversations/${id}`)
          .send({ personas: [{ personaId: second.id, role: "listener" }] })
      ).status,
    ).toBe(400);

    // unknown persona → 400
    expect(
      (
        await request(app)
          .patch(`/conversations/${id}`)
          .send({ personas: [{ personaId: "ghost", role: "curator" }] })
      ).status,
    ).toBe(400);

    // one curator → 200, and it can be swapped for a different persona
    const ok = await request(app)
      .patch(`/conversations/${id}`)
      .send({ personas: [{ personaId: second.id, role: "curator" }] });
    expect(ok.status).toBe(200);
    expect(ok.body.conversation.personas).toHaveLength(1);
    expect(ok.body.conversation.personas[0].personaId).toBe(second.id);
  });

  it("POST /conversations/:id/fork forks at a message and ignores addPersonaIds", async () => {
    const created = await request(app)
      .post("/conversations")
      .send({ name: "Root", model: "anthropic:claude-sonnet-5" });
    const id = created.body.conversation.id;
    const first = await request(app).post(`/conversations/${id}/reply`).send({ text: "one" });
    await request(app).post(`/conversations/${id}/reply`).send({ text: "two" });
    const extra = await deps.personas.create({
      name: "Extra",
      model: "anthropic:claude-sonnet-5",
    });

    const res = await request(app)
      .post(`/conversations/${id}/fork`)
      .send({ atMessageId: first.body.message.id, addPersonaIds: [extra.id] });
    expect(res.status).toBe(201);
    expect(res.body.conversation.rootId).toBe(id);
    // an old client still sending addPersonaIds gets a single-persona fork
    expect(res.body.conversation.personas).toHaveLength(1);
    expect(res.body.conversation.personas[0].personaId).not.toBe(extra.id);

    const forked = await deps.conversations.get(res.body.conversation.id);
    expect(forked?.messages.map((m) => m.text)).toEqual(["one"]);
  });

  it("POST /conversations/:id/ask uses curator personaId and persists nothing", async () => {
    const created = await request(app)
      .post("/conversations")
      .send({ name: "Asky", model: "anthropic:claude-sonnet-5" });
    const id = created.body.conversation.id;
    await request(app).post(`/conversations/${id}/reply`).send({ text: "context msg" });

    const res = await request(app)
      .post(`/conversations/${id}/ask`)
      .send({ text: "side question?" });
    expect(res.status).toBe(200);
    expect(res.body.reply).toBe("mock reply");

    const payload = deps.invokeMock.mock.calls.at(-1)![0] as InvokePayload;
    expect(payload.personaId).toBe(created.body.conversation.personas[0].personaId);
    expect(payload.messages.at(-1)).toEqual({ role: "user", content: "side question?" });

    const conversation = await deps.conversations.get(id);
    expect(conversation?.messages).toHaveLength(1); // ask persisted nothing
  });

  it("ask sends the conversation's own model, not the curator persona's", async () => {
    // Idea #95, slice 1, one route over. The runner resolves the model off
    // the persona when it is handed only a `personaId` -- and one persona
    // curates hundreds of conversations, so a model picked here changed
    // nothing about what Ask actually ran.
    const created = await request(app)
      .post("/conversations")
      .send({ name: "Asky", model: "anthropic:claude-sonnet-5" });
    const id = created.body.conversation.id;
    await request(app)
      .patch(`/conversations/${id}`)
      .send({ model: "claude-cli:claude-haiku-4-5-20251001" });

    await request(app).post(`/conversations/${id}/ask`).send({ text: "q" });

    const payload = deps.invokeMock.mock.calls.at(-1)![0] as InvokePayload;
    expect(payload.personaId).toBe(created.body.conversation.personas[0].personaId);
    expect(payload.model).toBe("claude-cli:claude-haiku-4-5-20251001");

    // The persona is untouched -- that is the whole point of the split.
    const persona = await deps.personas.get(created.body.conversation.personas[0].personaId);
    expect(persona?.model).toBe("anthropic:claude-sonnet-5");
  });

  it("ask excludes forgotten messages from the context it sends", async () => {
    const created = await request(app)
      .post("/conversations")
      .send({ name: "Forgetful", model: "anthropic:claude-sonnet-5" });
    const id = created.body.conversation.id;
    const secret = await request(app)
      .post(`/conversations/${id}/reply`)
      .send({ text: "the secret" });
    await request(app).post(`/conversations/${id}/reply`).send({ text: "public" });
    await request(app)
      .post(`/conversations/${id}/messages/${secret.body.message.id}/forget`)
      .send({});

    await request(app).post(`/conversations/${id}/ask`).send({ text: "q" });
    const payload = deps.invokeMock.mock.calls.at(-1)![0] as InvokePayload;
    const contents = payload.messages.map((m) => m.content);
    expect(contents).not.toContain("the secret");
    expect(contents).toContain("public");
  });

  it("ask excludes system (control-plane) messages from the context it sends", async () => {
    const created = await request(app)
      .post("/conversations")
      .send({ name: "SystemMsgTest", model: "anthropic:claude-sonnet-5" });
    const id = created.body.conversation.id;
    await request(app).post(`/conversations/${id}/reply`).send({ text: "a real question" });
    await request(app)
      .post(`/conversations/${id}/notify`)
      .send({ text: "paused notice", sender: "Agora", system: true });

    await request(app).post(`/conversations/${id}/ask`).send({ text: "q" });
    const payload = deps.invokeMock.mock.calls.at(-1)![0] as InvokePayload;
    const contents = payload.messages.map((m) => m.content);
    expect(contents).not.toContain("paused notice");
    expect(contents).toContain("a real question");
  });

  it("ask excludes inline activity messages from the context it sends (agents don't see their own tool-use chips)", async () => {
    const created = await request(app)
      .post("/conversations")
      .send({ name: "ActivityMsgTest", model: "anthropic:claude-sonnet-5" });
    const id = created.body.conversation.id;
    await request(app).post(`/conversations/${id}/reply`).send({ text: "a real question" });
    await deps.conversations.appendMessage(
      id, "Gemini", "vault_read: notes.md", undefined, undefined, false,
      { capability: "vault_read", detail: "notes.md" },
    );

    await request(app).post(`/conversations/${id}/ask`).send({ text: "q" });
    const payload = deps.invokeMock.mock.calls.at(-1)![0] as InvokePayload;
    const contents = payload.messages.map((m) => m.content);
    expect(contents).not.toContain("vault_read: notes.md");
    expect(contents).toContain("a real question");
  });

  it("POST .../forget toggles and 404s on unknown ids", async () => {
    const created = await request(app)
      .post("/conversations")
      .send({ name: "F", model: "anthropic:claude-sonnet-5" });
    const id = created.body.conversation.id;
    const sent = await request(app).post(`/conversations/${id}/reply`).send({ text: "x" });
    expect(
      (
        await request(app)
          .post(`/conversations/${id}/messages/${sent.body.message.id}/forget`)
          .send({ forgotten: true })
      ).status,
    ).toBe(200);
    expect(
      (await request(app).post(`/conversations/${id}/messages/nope/forget`).send({})).status,
    ).toBe(404);
  });

  // ---- Heartbeats -------------------------------------------------------
  async function createHeartbeatFixtures() {
    const persona = await deps.personas.create({
      name: "HB Persona",
      model: "anthropic:claude-sonnet-5",
    });
    const conversation = await deps.conversations.create("HB Conv", "", undefined, undefined, [
      { personaId: persona.id, role: "curator" },
    ]);
    return { persona, conversation };
  }

  it("POST /heartbeats validates schedule, persona, and conversation", async () => {
    const { persona, conversation } = await createHeartbeatFixtures();
    const base = {
      name: "Morning",
      personaId: persona.id,
      conversationId: conversation.id,
    };
    expect(
      (await request(app).post("/heartbeats").send({ ...base, schedule: "sometimes" })).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post("/heartbeats")
          .send({ ...base, personaId: "ghost", schedule: "daily@08:00" })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post("/heartbeats")
          .send({ ...base, conversationId: "ghost", schedule: "daily@08:00" })
      ).status,
    ).toBe(400);

    const res = await request(app)
      .post("/heartbeats")
      .send({
        ...base,
        schedule: "daily@08:00",
        task: "Check in about training",
        vaultPaths: ["personal/training/", "sokrates/newspaper preferences.md"],
      });
    expect(res.status).toBe(201);
    expect(res.body.heartbeat.vaultPaths).toHaveLength(2);
    expect(res.body.heartbeat.enabled).toBe(true);
  });

  it("accepts an anchored interval and rejects one that can't hold its clock time", async () => {
    const { persona, conversation } = await createHeartbeatFixtures();
    const base = { name: "Nova", personaId: persona.id, conversationId: conversation.id };

    const good = await request(app).post("/heartbeats").send({ ...base, schedule: "every@6h@12:00" });
    expect(good.status).toBe(201);
    expect(good.body.heartbeat.schedule).toBe("every@6h@12:00");

    const bad = await request(app).post("/heartbeats").send({ ...base, schedule: "every@7h@12:00" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("divide 24h");

    const patched = await request(app)
      .patch(`/heartbeats/${good.body.heartbeat.id}`)
      .send({ schedule: "every@7h@12:00" });
    expect(patched.status).toBe(400);
  });

  // 2026-08-14, Edvard: "Did you fix the notification for agora heartbeats?
  // So i can turn them off?" -- pushNotifications rides through create and
  // patch so the runner can send that heartbeat's reply with push:false.
  it("POST /heartbeats stores pushNotifications:false", async () => {
    const { persona, conversation } = await createHeartbeatFixtures();
    const created = await request(app).post("/heartbeats").send({
      name: "hb",
      personaId: persona.id,
      conversationId: conversation.id,
      schedule: "every@30m",
      pushNotifications: false,
    });
    expect(created.status).toBe(201);
    expect(created.body.heartbeat.pushNotifications).toBe(false);
  });

  it("POST /heartbeats leaves pushNotifications absent when not asked for", async () => {
    // Absent is what the runner reads as "notify", so a heartbeat created
    // without the field must not come back muted.
    const { persona, conversation } = await createHeartbeatFixtures();
    const created = await request(app).post("/heartbeats").send({
      name: "hb",
      personaId: persona.id,
      conversationId: conversation.id,
      schedule: "every@30m",
    });
    expect(created.body.heartbeat.pushNotifications).toBeUndefined();
  });

  it("PATCH /heartbeats/:id mutes and unmutes pushNotifications", async () => {
    const { persona, conversation } = await createHeartbeatFixtures();
    const created = await request(app).post("/heartbeats").send({
      name: "hb",
      personaId: persona.id,
      conversationId: conversation.id,
      schedule: "every@30m",
    });
    const id = created.body.heartbeat.id;
    const muted = await request(app).patch(`/heartbeats/${id}`).send({ pushNotifications: false });
    expect(muted.status).toBe(200);
    expect(muted.body.heartbeat.pushNotifications).toBe(false);
    // And back -- a mute you cannot undo is a worse bug than no mute.
    const unmuted = await request(app).patch(`/heartbeats/${id}`).send({ pushNotifications: true });
    expect(unmuted.body.heartbeat.pushNotifications).toBe(true);
    expect((await deps.heartbeats.get(id))?.pushNotifications).toBe(true);
  });

  it("PATCH /heartbeats/:id refuses a supported field carrying the wrong type", async () => {
    // The route used to build its update from a `if (typeof ...)` ladder, so
    // a stringified boolean fell straight out of it and still answered 200.
    const { persona, conversation } = await createHeartbeatFixtures();
    const created = await request(app).post("/heartbeats").send({
      name: "hb",
      personaId: persona.id,
      conversationId: conversation.id,
      schedule: "every@30m",
    });
    const id = created.body.heartbeat.id;
    const res = await request(app).patch(`/heartbeats/${id}`).send({ enabled: "true" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("enabled must be a boolean, got string");
    expect((await deps.heartbeats.get(id))?.enabled).toBe(true);
  });

  it("PATCH /heartbeats/:id refuses a field it does not update", async () => {
    const { persona, conversation } = await createHeartbeatFixtures();
    const created = await request(app).post("/heartbeats").send({
      name: "hb",
      personaId: persona.id,
      conversationId: conversation.id,
      schedule: "every@30m",
    });
    const id = created.body.heartbeat.id;
    // A near-miss on a real field is the case worth naming: `lastResult` is
    // the engine's, not the Studio's, and dropping it silently is how a
    // caller concludes the route works.
    const res = await request(app).patch(`/heartbeats/${id}`).send({ lastResult: "done" });
    expect(res.status).toBe(400);
    // Assert the unknown-key branch specifically, not just any 400: an
    // unknown key also fails the type check below it (its declared type is
    // `undefined`), so a message naming only the field would still pass with
    // this guard deleted. The list of legal names is what tells them apart.
    expect(res.body.error).toContain("this route does not update lastResult");
    expect(res.body.error).toContain("it updates name, personaId");
    expect((await deps.heartbeats.get(id))?.lastResult ?? null).toBeNull();
  });

  it("PATCH /heartbeats/:id refuses the whole body, so no half of it lands", async () => {
    const { persona, conversation } = await createHeartbeatFixtures();
    const created = await request(app).post("/heartbeats").send({
      name: "hb",
      personaId: persona.id,
      conversationId: conversation.id,
      schedule: "every@30m",
    });
    const id = created.body.heartbeat.id;
    const res = await request(app)
      .patch(`/heartbeats/${id}`)
      .send({ name: "renamed", enabled: "false" });
    expect(res.status).toBe(400);
    expect((await deps.heartbeats.get(id))?.name).toBe("hb");
  });

  it("PATCH /heartbeats/:id says which shape a wrongly-typed field arrived as", async () => {
    // `typeof` answers "object" for both null and an array, which tells the
    // caller nothing about what they actually sent.
    const { persona, conversation } = await createHeartbeatFixtures();
    const created = await request(app).post("/heartbeats").send({
      name: "hb",
      personaId: persona.id,
      conversationId: conversation.id,
      schedule: "every@30m",
    });
    const id = created.body.heartbeat.id;
    const nulled = await request(app).patch(`/heartbeats/${id}`).send({ name: null });
    expect(nulled.body.error).toContain("name must be a string, got null");
    const arrayed = await request(app).patch(`/heartbeats/${id}`).send({ task: ["a"] });
    expect(arrayed.body.error).toContain("task must be a string, got an array");
    const mixed = await request(app).patch(`/heartbeats/${id}`).send({ vaultPaths: ["a", 2] });
    expect(mixed.body.error).toContain("vaultPaths must be an array of strings");
  });

  it("PATCH /heartbeats/:id switches a heartbeat onto a channel that does not exist yet", async () => {
    // The Studio's edit form offers "New channel" and sends
    // newConversationName; PATCH used to drop it and save green, leaving the
    // heartbeat speaking into its old conversation.
    const { persona, conversation } = await createHeartbeatFixtures();
    const created = await request(app).post("/heartbeats").send({
      name: "hb",
      personaId: persona.id,
      conversationId: conversation.id,
      schedule: "every@30m",
    });
    const id = created.body.heartbeat.id;
    const res = await request(app)
      .patch(`/heartbeats/${id}`)
      .send({ newConversationName: "Fresh channel" });
    expect(res.status).toBe(200);
    const moved = (await deps.heartbeats.get(id))?.conversationId;
    expect(moved).not.toBe(conversation.id);
    expect((await deps.conversations.get(moved as string))?.name).toBe("Fresh channel");
    // And it is resolved, never written through as a field of its own.
    expect(
      (await deps.heartbeats.get(id)) as unknown as Record<string, unknown>,
    ).not.toHaveProperty("newConversationName");
  });

  it("PATCH /heartbeats/:id refuses an ambiguous or empty channel switch", async () => {
    const { persona, conversation } = await createHeartbeatFixtures();
    const created = await request(app).post("/heartbeats").send({
      name: "hb",
      personaId: persona.id,
      conversationId: conversation.id,
      schedule: "every@30m",
    });
    const id = created.body.heartbeat.id;
    const both = await request(app)
      .patch(`/heartbeats/${id}`)
      .send({ conversationId: conversation.id, newConversationName: "Fresh" });
    expect(both.status).toBe(400);
    expect(both.body.error).toContain("not both");
    const empty = await request(app)
      .patch(`/heartbeats/${id}`)
      .send({ newConversationName: "" });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toContain("cannot be empty");
    expect((await deps.heartbeats.get(id))?.conversationId).toBe(conversation.id);
  });

  it("every field PUBLIC_HEARTBEAT_FIELDS names is one the route really applies", async () => {
    // The list is what both 400s above are built from, so a name that drifts
    // out of the handler goes back to being accepted-and-ignored in silence.
    const { persona, conversation } = await createHeartbeatFixtures();
    const other = await deps.conversations.create(
      "Other",
      "",
      "anthropic:claude-haiku-4-5-20251001",
      false,
      [],
    );
    const workflow = await deps.workflows.create({ name: "w", steps: [] });
    const created = await request(app).post("/heartbeats").send({
      name: "hb",
      personaId: persona.id,
      conversationId: conversation.id,
      schedule: "every@30m",
    });
    const id = created.body.heartbeat.id;
    const sent: Record<string, unknown> = {
      name: "renamed",
      personaId: persona.id,
      conversationId: other.id,
      schedule: "every@2h",
      task: "do the thing",
      workflowId: workflow.id,
      vaultPaths: ["a/b.md"],
      enabled: false,
      rotateConversationEachRun: true,
      conversationRetention: 5,
      pushNotifications: false,
    };
    // newConversationName is deliberately not sent here: it is the one name
    // in the table that is resolved rather than stored, and it conflicts
    // with the conversationId this case is asserting.
    expect([...Object.keys(sent), "newConversationName"].sort()).toEqual(
      Object.keys(PUBLIC_HEARTBEAT_FIELDS).sort(),
    );
    const res = await request(app).patch(`/heartbeats/${id}`).send(sent);
    expect(res.status).toBe(200);
    const stored = (await deps.heartbeats.get(id)) as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(sent)) {
      expect(stored[key]).toEqual(value);
    }
  });

  it("POST /heartbeats/:id/run queues a forced run", async () => {
    const { persona, conversation } = await createHeartbeatFixtures();
    const created = await request(app).post("/heartbeats").send({
      name: "hb",
      personaId: persona.id,
      conversationId: conversation.id,
      schedule: "every@30m",
    });
    const res = await request(app).post(`/heartbeats/${created.body.heartbeat.id}/run`);
    expect(res.status).toBe(200);
    expect(res.body.heartbeat.forceRun).toBe(true);
    expect(res.body.status).toBe("queued");
    expect(res.body.runningSince).toBeNull();
  });

  it("POST /heartbeats/:id/run reports already-running instead of a bare queued", async () => {
    const { persona, conversation } = await createHeartbeatFixtures();
    const created = await request(app).post("/heartbeats").send({
      name: "hb",
      personaId: persona.id,
      conversationId: conversation.id,
      schedule: "every@30m",
    });
    const id = created.body.heartbeat.id;
    // Exactly what the runner writes as its claim when a cycle starts.
    const startedAt = new Date().toISOString();
    await deps.heartbeats.update(id, { lastResult: "running", lastRunAt: startedAt });

    const res = await request(app).post(`/heartbeats/${id}/run`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("already-running");
    expect(res.body.runningSince).toBe(startedAt);
    // Still queued, not refused -- a stuck "running" must not brick the button.
    expect(res.body.heartbeat.forceRun).toBe(true);
  });

  it("POST /heartbeats/:id/run goes back to queued once a run has finished", async () => {
    const { persona, conversation } = await createHeartbeatFixtures();
    const created = await request(app).post("/heartbeats").send({
      name: "hb",
      personaId: persona.id,
      conversationId: conversation.id,
      schedule: "every@30m",
    });
    const id = created.body.heartbeat.id;
    await deps.heartbeats.update(id, { lastResult: "ok", lastRunAt: new Date().toISOString() });

    const res = await request(app).post(`/heartbeats/${id}/run`);
    expect(res.body.status).toBe("queued");
    expect(res.body.runningSince).toBeNull();
  });

  it("DELETE /conversations/:id refuses while heartbeats are bound to it", async () => {
    const { persona, conversation } = await createHeartbeatFixtures();
    await request(app).post("/heartbeats").send({
      name: "keeper",
      personaId: persona.id,
      conversationId: conversation.id,
      schedule: "every@1h",
    });
    const refused = await request(app).delete(`/conversations/${conversation.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.heartbeats).toEqual(["keeper"]);
  });

  // ---- Workflows (Decisions/0009) ----------------------------------------
  it("POST /workflows validates name, step shape, and creates with steps", async () => {
    expect((await request(app).post("/workflows").send({})).status).toBe(400);
    expect(
      (await request(app).post("/workflows").send({ name: "Discuss", steps: "nope" })).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post("/workflows")
          .send({ name: "Discuss", steps: [{ prompt: "x", loopCount: 0, toolWhitelist: [] }] })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post("/workflows")
          .send({
            name: "Plan",
            steps: [{ prompt: "x", loopCount: 1, toolWhitelist: ["scoped_write"] }],
          })
      ).status,
    ).toBe(400);

    const res = await request(app)
      .post("/workflows")
      .send({
        name: "Discuss",
        description: "critique loop",
        steps: [
          { prompt: "Critique the prior turn.", loopCount: 3, toolWhitelist: ["vault_read", "web_search"] },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.workflow.steps).toHaveLength(1);
    expect(res.body.workflow.steps[0].loopCount).toBe(3);
  });

  it("POST /workflows rejects an unknown workflowRef and a cyclic one on update", async () => {
    expect(
      (
        await request(app)
          .post("/workflows")
          .send({ name: "A", steps: [{ prompt: "", loopCount: 1, toolWhitelist: [], workflowRef: "ghost" }] })
      ).status,
    ).toBe(400);

    const a = await request(app).post("/workflows").send({ name: "A", steps: [] });
    const b = await request(app)
      .post("/workflows")
      .send({
        name: "B",
        steps: [{ prompt: "", loopCount: 1, toolWhitelist: [], workflowRef: a.body.workflow.id }],
      });
    expect(b.status).toBe(201);

    const cyclic = await request(app)
      .patch(`/workflows/${a.body.workflow.id}`)
      .send({ steps: [{ prompt: "", loopCount: 1, toolWhitelist: [], workflowRef: b.body.workflow.id }] });
    expect(cyclic.status).toBe(400);
    expect(cyclic.body.error).toMatch(/cycle/);
  });

  it("POST /workflows accepts step.personaIds, validated against real personas", async () => {
    const { persona } = await createHeartbeatFixtures();

    const rejected = await request(app)
      .post("/workflows")
      .send({
        name: "Bad",
        steps: [{ prompt: "x", loopCount: 1, toolWhitelist: [], personaIds: ["ghost"] }],
      });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toMatch(/personaIds/);

    const accepted = await request(app)
      .post("/workflows")
      .send({
        name: "Good",
        steps: [{ prompt: "x", loopCount: 1, toolWhitelist: [], personaIds: [persona.id] }],
      });
    expect(accepted.status).toBe(201);
    expect(accepted.body.workflow.steps[0].personaIds).toEqual([persona.id]);

    // PATCH validates the same way.
    const patched = await request(app)
      .patch(`/workflows/${accepted.body.workflow.id}`)
      .send({ steps: [{ prompt: "x", loopCount: 1, toolWhitelist: [], personaIds: ["ghost"] }] });
    expect(patched.status).toBe(400);
    expect(patched.body.error).toMatch(/personaIds/);
  });

  it("DELETE /workflows/:id refuses while a heartbeat references it", async () => {
    const { persona, conversation } = await createHeartbeatFixtures();
    const workflow = await request(app).post("/workflows").send({ name: "Bound", steps: [] });
    await request(app).post("/heartbeats").send({
      name: "wf-hb",
      personaId: persona.id,
      conversationId: conversation.id,
      schedule: "every@1h",
      workflowId: workflow.body.workflow.id,
    });
    const refused = await request(app).delete(`/workflows/${workflow.body.workflow.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.heartbeats).toEqual(["wf-hb"]);
  });

  it("POST /heartbeats validates workflowId when provided", async () => {
    const { persona, conversation } = await createHeartbeatFixtures();
    expect(
      (
        await request(app).post("/heartbeats").send({
          name: "bad-wf",
          personaId: persona.id,
          conversationId: conversation.id,
          schedule: "every@1h",
          workflowId: "ghost",
        })
      ).status,
    ).toBe(400);

    const workflow = await request(app).post("/workflows").send({ name: "Real", steps: [] });
    const res = await request(app).post("/heartbeats").send({
      name: "good-wf",
      personaId: persona.id,
      conversationId: conversation.id,
      schedule: "every@1h",
      workflowId: workflow.body.workflow.id,
    });
    expect(res.status).toBe(201);
    expect(res.body.heartbeat.workflowId).toBe(workflow.body.workflow.id);
  });

  it("POST /heartbeats accepts rotateConversationEachRun/conversationRetention, PATCH updates them", async () => {
    const { persona, conversation } = await createHeartbeatFixtures();
    const created = await request(app).post("/heartbeats").send({
      name: "rotator",
      personaId: persona.id,
      conversationId: conversation.id,
      schedule: "every@6h",
      rotateConversationEachRun: true,
      conversationRetention: 3,
    });
    expect(created.status).toBe(201);
    expect(created.body.heartbeat.rotateConversationEachRun).toBe(true);
    expect(created.body.heartbeat.conversationRetention).toBe(3);

    const patched = await request(app)
      .patch(`/heartbeats/${created.body.heartbeat.id}`)
      .send({ rotateConversationEachRun: false, conversationRetention: 5 });
    expect(patched.status).toBe(200);
    expect(patched.body.heartbeat.rotateConversationEachRun).toBe(false);
    expect(patched.body.heartbeat.conversationRetention).toBe(5);
  });

  // ---- Search / audit ---------------------------------------------------
  it("GET /search covers conversations without double-reporting Main", async () => {
    await request(app).post("/reply").send({ text: "needle in main" });
    const created = await request(app)
      .post("/conversations")
      .send({ name: "Other", model: "anthropic:claude-sonnet-5" });
    await request(app)
      .post(`/conversations/${created.body.conversation.id}/reply`)
      .send({ text: "needle elsewhere" });
    const res = await request(app).get("/search").query({ q: "needle" });
    expect(res.body.results).toHaveLength(2);
    const names = res.body.results.map((r: { conversationName: string }) => r.conversationName);
    expect(names.sort()).toEqual(["Main", "Other"]);
  });

  it("GET /audit returns recorded entries newest first", async () => {
    await deps.audit.append({
      personaName: "Marcus",
      conversationId: "c1",
      capability: "vault_write",
      detail: "personal/training/log.md",
    });
    const res = await request(app).get("/audit");
    expect(res.status).toBe(200);
    expect(res.body.entries[0]).toMatchObject({ capability: "vault_write" });
  });

  // ---- Attachments (Issues.md: "Sending files, images or voice does not
  // work") -------------------------------------------------------------
  describe("attachments", () => {
    it("POST /attachments stores the file and returns its metadata", async () => {
      const res = await request(app)
        .post("/attachments")
        .attach("file", Buffer.from("hello world"), { filename: "notes.txt", contentType: "text/plain" });
      expect(res.status).toBe(201);
      expect(res.body.attachment).toMatchObject({ filename: "notes.txt", mimeType: "text/plain", size: 11 });
      expect(res.body.attachment.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("POST /attachments 400s with no file", async () => {
      const res = await request(app).post("/attachments").send({});
      expect(res.status).toBe(400);
    });

    it("GET /attachments/:id serves the content with the right content-type", async () => {
      const uploaded = await request(app)
        .post("/attachments")
        .attach("file", Buffer.from([1, 2, 3, 4]), { filename: "photo.png", contentType: "image/png" });
      const id = uploaded.body.attachment.id;

      const res = await request(app).get(`/attachments/${id}`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("image/png");
      expect(res.headers["content-disposition"]).toBe("inline");
      expect(Buffer.compare(res.body, Buffer.from([1, 2, 3, 4]))).toBe(0);
    });

    it("GET /attachments/:id sets a download disposition for non-image files", async () => {
      const uploaded = await request(app)
        .post("/attachments")
        .attach("file", Buffer.from("data"), { filename: "report.pdf", contentType: "application/pdf" });
      const res = await request(app).get(`/attachments/${uploaded.body.attachment.id}`);
      expect(res.headers["content-disposition"]).toContain("attachment");
      expect(res.headers["content-disposition"]).toContain("report.pdf");
    });

    it("GET /attachments/:id 404s for an unknown id", async () => {
      const res = await request(app).get("/attachments/does-not-exist");
      expect(res.status).toBe(404);
    });

    it("reply with attachmentIds resolves them onto the stored message", async () => {
      const uploaded = await request(app)
        .post("/attachments")
        .attach("file", Buffer.from("img"), { filename: "photo.jpg", contentType: "image/jpeg" });
      const created = await request(app)
        .post("/conversations")
        .send({ name: "WithPhoto", model: "anthropic:claude-sonnet-5" });
      const res = await request(app)
        .post(`/conversations/${created.body.conversation.id}/reply`)
        .send({ text: "check this out", attachmentIds: [uploaded.body.attachment.id] });

      expect(res.status).toBe(200);
      expect(res.body.message.attachments).toHaveLength(1);
      expect(res.body.message.attachments[0]).toMatchObject({ filename: "photo.jpg", mimeType: "image/jpeg" });
    });

    it("reply with only an attachment and no text succeeds", async () => {
      const uploaded = await request(app)
        .post("/attachments")
        .attach("file", Buffer.from("img"), { filename: "photo.jpg", contentType: "image/jpeg" });
      const created = await request(app)
        .post("/conversations")
        .send({ name: "PhotoOnly", model: "anthropic:claude-sonnet-5" });
      const res = await request(app)
        .post(`/conversations/${created.body.conversation.id}/reply`)
        .send({ attachmentIds: [uploaded.body.attachment.id] });

      expect(res.status).toBe(200);
      expect(res.body.message.text).toBe("");
      expect(res.body.message.attachments).toHaveLength(1);
    });

    it("reply with neither text nor a resolvable attachment 400s", async () => {
      const created = await request(app)
        .post("/conversations")
        .send({ name: "Empty", model: "anthropic:claude-sonnet-5" });
      const res = await request(app)
        .post(`/conversations/${created.body.conversation.id}/reply`)
        .send({ attachmentIds: ["unknown-id"] });
      expect(res.status).toBe(400);
    });

    it("reply silently drops unknown attachment ids instead of failing the whole reply", async () => {
      const created = await request(app)
        .post("/conversations")
        .send({ name: "PartlyBroken", model: "anthropic:claude-sonnet-5" });
      const res = await request(app)
        .post(`/conversations/${created.body.conversation.id}/reply`)
        .send({ text: "hi", attachmentIds: ["unknown-id"] });
      expect(res.status).toBe(200);
      expect(res.body.message.attachments ?? []).toHaveLength(0);
    });
  });
});

describe("agora internal app", () => {
  let deps: Awaited<ReturnType<typeof makeDeps>>;
  let app: Express;

  beforeEach(async () => {
    deps = await makeDeps();
    app = createInternalApp(deps);
  });

  it("does not mount public routes at all", async () => {
    expect((await request(app).get("/healthz")).status).toBe(404);
  });

  it("enforces x-agora-token when configured (ADR 0007)", async () => {
    const guarded = createInternalApp({ ...deps, config: makeConfig({ agentToken: "s3cret" }) });
    expect((await request(guarded).get("/heartbeats")).status).toBe(401);
    expect(
      (await request(guarded).get("/heartbeats").set("x-agora-token", "wrong")).status,
    ).toBe(401);
    expect(
      (await request(guarded).get("/heartbeats").set("x-agora-token", "s3cret")).status,
    ).toBe(200);
  });

  it("stays open when no token is configured (deploy-order safety)", async () => {
    expect((await request(app).get("/heartbeats")).status).toBe(200);
  });

  it("GET /workflows/:id serves the definition to the runner", async () => {
    const workflow = await deps.workflows.create({
      name: "Discuss",
      steps: [{ prompt: "Critique.", loopCount: 2, toolWhitelist: [] }],
    });
    const res = await request(app).get(`/workflows/${workflow.id}`);
    expect(res.status).toBe(200);
    expect(res.body.workflow.steps).toHaveLength(1);
    expect((await request(app).get("/workflows/ghost")).status).toBe(404);
  });

  it("GET /personas/:id serves capability records to the runner", async () => {
    const persona = await deps.personas.create({
      name: "Caps",
      model: "anthropic:claude-sonnet-5",
      capabilities: { vaultWrite: true },
    });
    const res = await request(app).get(`/personas/${persona.id}`);
    expect(res.body.persona.capabilities.vaultWrite).toBe(true);
  });

  it("PATCH /personas/:id accepts only sharedMemory (save_memory tool)", async () => {
    const persona = await deps.personas.create({ name: "M", model: "anthropic:claude-sonnet-5" });
    expect(
      (await request(app).patch(`/personas/${persona.id}`).send({ personality: "hack" })).status,
    ).toBe(400);
    const res = await request(app)
      .patch(`/personas/${persona.id}`)
      .send({ sharedMemory: "learned something" });
    expect(res.status).toBe(200);
    expect((await deps.personas.get(persona.id))?.sharedMemory).toBe("learned something");
  });

  it("PATCH /heartbeats/:id records run bookkeeping and clears forceRun", async () => {
    const heartbeat = await deps.heartbeats.create({
      name: "hb",
      personaId: "p",
      conversationId: "c",
      schedule: "every@1h",
    });
    await deps.heartbeats.update(heartbeat.id, { forceRun: true });
    const res = await request(app).patch(`/heartbeats/${heartbeat.id}`).send({
      forceRun: false,
      lastRunAt: "2026-07-22T09:00:00.000Z",
      lastResult: "replied 88 chars",
    });
    expect(res.status).toBe(200);
    const reloaded = await deps.heartbeats.get(heartbeat.id);
    expect(reloaded?.forceRun).toBe(false);
    expect(reloaded?.lastResult).toBe("replied 88 chars");
  });

  it("PATCH /heartbeats/:id (internal) lets the engine rotate conversationId", async () => {
    const oldConv = await deps.conversations.create("Old", "", "anthropic:claude-haiku-4-5-20251001", false, []);
    const newConv = await deps.conversations.create("New", "", "anthropic:claude-haiku-4-5-20251001", false, []);
    const heartbeat = await deps.heartbeats.create({
      name: "hb", personaId: "p", conversationId: oldConv.id, schedule: "every@6h",
    });
    const res = await request(app)
      .patch(`/heartbeats/${heartbeat.id}`)
      .send({ conversationId: newConv.id });
    expect(res.status).toBe(200);
    const reloaded = await deps.heartbeats.get(heartbeat.id);
    expect(reloaded?.conversationId).toBe(newConv.id);
  });

  it("PATCH /heartbeats/:id (internal) rejects an unknown conversationId", async () => {
    const heartbeat = await deps.heartbeats.create({
      name: "hb", personaId: "p", conversationId: "c", schedule: "every@6h",
    });
    const res = await request(app)
      .patch(`/heartbeats/${heartbeat.id}`)
      .send({ conversationId: "does-not-exist" });
    expect(res.status).toBe(400);
    const reloaded = await deps.heartbeats.get(heartbeat.id);
    expect(reloaded?.conversationId).toBe("c");
  });

  it("PATCH /heartbeats/:id (internal) refuses a field it would only have ignored", async () => {
    // Nova Cycle 402 repointed a heartbeat at a new workflow through this
    // route, read the 200, and the run used the old workflow anyway.
    const workflow = await deps.workflows.create({ name: "w", steps: [] });
    const heartbeat = await deps.heartbeats.create({
      name: "hb", personaId: "p", conversationId: "c", schedule: "every@6h",
    });
    const res = await request(app)
      .patch(`/heartbeats/${heartbeat.id}`)
      .send({ workflowId: workflow.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("workflowId");
    expect(res.body.error).toContain("public app");
    const reloaded = await deps.heartbeats.get(heartbeat.id);
    expect(reloaded?.workflowId ?? null).toBeNull();
  });

  it("PATCH /heartbeats/:id (internal) refuses the whole body, so no half of it lands", async () => {
    const heartbeat = await deps.heartbeats.create({
      name: "hb", personaId: "p", conversationId: "c", schedule: "every@6h",
    });
    const res = await request(app)
      .patch(`/heartbeats/${heartbeat.id}`)
      .send({ lastResult: "replied", enabled: false });
    expect(res.status).toBe(400);
    const reloaded = await deps.heartbeats.get(heartbeat.id);
    expect(reloaded?.lastResult ?? null).toBeNull();
    expect(reloaded?.enabled).toBe(true);
  });

  it("every field INTERNAL_HEARTBEAT_FIELDS names is one the route really applies", async () => {
    // The list is what the 400 above is built from, so a name that drifts out
    // of the handler would start being accepted-and-ignored again in silence.
    const conv = await deps.conversations.create("C", "", "anthropic:claude-haiku-4-5-20251001", false, []);
    const sent: Record<string, unknown> = {
      lastRunAt: "2026-08-27T11:00:00.000Z",
      lastResult: "replied 12 chars",
      forceRun: true,
      conversationId: conv.id,
    };
    expect(Object.keys(sent).sort()).toEqual(Object.keys(INTERNAL_HEARTBEAT_FIELDS).sort());
    const heartbeat = await deps.heartbeats.create({
      name: "hb", personaId: "p", conversationId: "c", schedule: "every@6h",
    });
    const res = await request(app).patch(`/heartbeats/${heartbeat.id}`).send(sent);
    expect(res.status).toBe(200);
    const reloaded = await deps.heartbeats.get(heartbeat.id) as unknown as Record<string, unknown>;
    for (const field of Object.keys(INTERNAL_HEARTBEAT_FIELDS)) {
      expect(reloaded[field]).toEqual(sent[field]);
    }
  });

  it("PATCH /heartbeats/:id (internal) refuses a supported field carrying the wrong type", async () => {
    // The same lie one step in: the name is on the list, the value is not
    // usable, and the old handler answered 200 having changed nothing.
    const heartbeat = await deps.heartbeats.create({
      name: "hb", personaId: "p", conversationId: "c", schedule: "every@6h",
    });
    await deps.heartbeats.update(heartbeat.id, { forceRun: true });
    const res = await request(app)
      .patch(`/heartbeats/${heartbeat.id}`)
      .send({ forceRun: "yes" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("forceRun must be a boolean");
    const reloaded = await deps.heartbeats.get(heartbeat.id);
    expect(reloaded?.forceRun).toBe(true);
  });

  it("POST /audit records entries", async () => {
    const res = await request(app).post("/audit").send({
      personaName: "Marcus",
      conversationId: "c1",
      capability: "heartbeat",
      detail: "Morning check-in",
    });
    expect(res.status).toBe(201);
    expect((await deps.audit.list())[0].capability).toBe("heartbeat");
  });

  it("POST /audit stores before/after content for a vault_write, for the Activity diff view", async () => {
    const res = await request(app).post("/audit").send({
      personaName: "Gemini",
      conversationId: "c1",
      capability: "vault_write",
      detail: "projects/agora/issues.md",
      before: "old content",
      after: "new content",
    });
    expect(res.status).toBe(201);
    const stored = (await deps.audit.list())[0];
    expect(stored.before).toBe("old content");
    expect(stored.after).toBe("new content");
  });

  it("POST /audit omits before/after when not provided (e.g. a vault_read)", async () => {
    await request(app).post("/audit").send({
      personaName: "Gemini",
      conversationId: "c1",
      capability: "vault_read",
      detail: "projects/agora/issues.md",
    });
    const stored = (await deps.audit.list())[0];
    expect(stored.before).toBeUndefined();
    expect(stored.after).toBeUndefined();
  });

  it("POST /audit appends an inline activity message into the conversation (in-chat Activity, 2026-07-24)", async () => {
    const conversation = await deps.conversations.create("Live", "");
    const res = await request(app).post("/audit").send({
      personaName: "Gemini",
      conversationId: conversation.id,
      capability: "vault_write",
      detail: "notes.md",
      before: "old",
      after: "new",
    });
    expect(res.status).toBe(201);
    const reloaded = await deps.conversations.get(conversation.id);
    expect(reloaded?.messages).toHaveLength(1);
    expect(reloaded?.messages[0]).toMatchObject({
      sender: "Gemini",
      activity: { capability: "vault_write", detail: "notes.md", before: "old", after: "new" },
    });
  });

  it("POST /audit carries `retracted` through to the in-chat copy (issues.md #4)", async () => {
    // A passage is streamed while it is written, before anyone knows whether
    // it is narration or the reply. The bridge retracts the stream id of the
    // one that turned out to be the reply; the client drops every step under
    // it so Edvard does not read his own reply twice.
    const conversation = await deps.conversations.create("Streaming", "");
    const res = await request(app).post("/audit").send({
      personaName: "Nova",
      conversationId: conversation.id,
      capability: "assistant_text",
      detail: "",
      toolUseId: "txt_1",
      retracted: true,
    });
    expect(res.status).toBe(201);
    expect((await deps.audit.list())[0].retracted).toBe(true);
    const reloaded = await deps.conversations.get(conversation.id);
    expect(reloaded?.messages[0].activity).toMatchObject({
      capability: "assistant_text",
      toolUseId: "txt_1",
      retracted: true,
    });
  });

  it("POST /audit leaves `retracted` undefined on an ordinary tool call", async () => {
    const conversation = await deps.conversations.create("Ordinary", "");
    await request(app).post("/audit").send({
      personaName: "Nova",
      conversationId: conversation.id,
      capability: "Bash",
      detail: "echo hi",
      toolUseId: "toolu_a",
    });
    expect((await deps.audit.list())[0].retracted).toBeUndefined();
    const reloaded = await deps.conversations.get(conversation.id);
    expect(reloaded?.messages[0].activity?.retracted).toBeUndefined();
  });

  it("POST /audit without a resolvable conversationId records the entry but touches no conversation", async () => {
    const res = await request(app).post("/audit").send({
      personaName: "Gemini",
      conversationId: "no-such-conversation",
      capability: "vault_read",
      detail: "notes.md",
    });
    expect(res.status).toBe(201);
    expect(await deps.conversations.get("no-such-conversation")).toBeNull();
  });

  it("POST /conversations/:id/notify honors an explicit sender for multi-persona turns", async () => {
    await deps.store.save(validSubscription);
    const conversation = await deps.conversations.create("Multi", "");
    const res = await request(app)
      .post(`/conversations/${conversation.id}/notify`)
      .send({ text: "hi from listener", sender: "Gemini" });
    expect(res.status).toBe(200);
    expect(res.body.message.sender).toBe("Gemini");
    expect(deps.webPush.sendNotification).toHaveBeenCalledWith(
      validSubscription,
      JSON.stringify({
        title: "Gemini",
        body: "hi from listener",
        conversationId: conversation.id,
      }),
    );
  });

  it("POST /conversations/:id/notify defaults sender to the conversation name", async () => {
    await deps.store.save(validSubscription);
    const conversation = await deps.conversations.create("Haiku", "");
    const res = await request(app)
      .post(`/conversations/${conversation.id}/notify`)
      .send({ text: "hi" });
    expect(res.body.message.sender).toBe("Haiku");
  });

  it("POST /conversations/:id/notify records system:true when passed, omits it otherwise", async () => {
    await deps.store.save(validSubscription);
    const conversation = await deps.conversations.create("Test", "");
    const paused = await request(app)
      .post(`/conversations/${conversation.id}/notify`)
      .send({ text: "paused", sender: "Agora", system: true });
    expect(paused.body.message.system).toBe(true);

    const normal = await request(app)
      .post(`/conversations/${conversation.id}/notify`)
      .send({ text: "a real reply", sender: "Haiku" });
    expect(normal.body.message.system).toBeUndefined();
  });

  it("legacy POST /notify lands in the Main conversation with a push (ADR 0008)", async () => {
    await deps.store.save(validSubscription);
    const res = await request(app).post("/notify").send({ persona: "Marcus", text: "yo" });
    expect(res.status).toBe(200);
    const main = await deps.conversations.findByName("Main");
    expect(main?.messages).toMatchObject([{ sender: "Marcus", text: "yo" }]);
  });

  it("POST /conversations/:id/notify still records the message when no subscription exists", async () => {
    const conversation = await deps.conversations.create("NoSub", "");
    const res = await request(app)
      .post(`/conversations/${conversation.id}/notify`)
      .send({ text: "recorded anyway" });
    expect(res.status).toBe(404);
    expect((await deps.conversations.get(conversation.id))?.messages).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // 2026-07-24: live streaming -- a turn now lands as several small
  // messages (one per text block, as it's generated) instead of one at the
  // end. push=false lets the runner post every chunk but the last without
  // spamming a phone notification per sentence.
  // -------------------------------------------------------------------------

  it("POST /conversations/:id/notify with push:false records the message but skips the push", async () => {
    await deps.store.save(validSubscription);
    const conversation = await deps.conversations.create("Stream", "");
    const res = await request(app)
      .post(`/conversations/${conversation.id}/notify`)
      .send({ text: "first chunk", sender: "Gemini", push: false });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("recorded");
    expect(res.body.message.text).toBe("first chunk");
    expect(deps.webPush.sendNotification).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 2026-08-25: presence. Nova's chat dock renders an Agora conversation from
  // a different origin, so the service worker's "don't notify while the app is
  // open" check cannot see it and the phone buzzed for a reply already on
  // screen. A watching client says so; the buzz is withheld, the reply is not.
  // -------------------------------------------------------------------------

  it("POST /conversations/:id/presence withholds the next push but still records the message", async () => {
    await deps.store.save(validSubscription);
    const conversation = await deps.conversations.create("Watched", "");
    const presence = await request(app).post(`/conversations/${conversation.id}/presence`).send({});
    expect(presence.status).toBe(200);
    expect(presence.body.status).toBe("watching");

    const res = await request(app)
      .post(`/conversations/${conversation.id}/notify`)
      .send({ text: "he is looking right at this", sender: "Nova" });
    expect(res.status).toBe(200);
    expect(res.body.watching).toBe(true);
    expect(res.body.message.text).toBe("he is looking right at this");
    expect(deps.webPush.sendNotification).not.toHaveBeenCalled();

    // And the message really is in the conversation, not merely echoed back.
    const stored = await deps.conversations.get(conversation.id);
    expect(stored?.messages.map((m) => m.text)).toContain("he is looking right at this");
  });

  it("presence on one conversation does not silence another", async () => {
    await deps.store.save(validSubscription);
    const watched = await deps.conversations.create("WatchedOne", "");
    const other = await deps.conversations.create("OtherOne", "");
    await request(app).post(`/conversations/${watched.id}/presence`).send({});

    const res = await request(app)
      .post(`/conversations/${other.id}/notify`)
      .send({ text: "nobody is looking at this one", sender: "Nova" });
    expect(res.status).toBe(200);
    expect(res.body.watching).toBeUndefined();
    expect(deps.webPush.sendNotification).toHaveBeenCalledTimes(1);
  });

  it("presence never withholds a system notice, because Nova filters those out of the thread", async () => {
    // `back_off` and `stall_notice` push these. Nova's ask thread drops
    // `system` messages, so a watching client is precisely the one that will
    // not show him "your question failed" — the push is all he has.
    await deps.store.save(validSubscription);
    const conversation = await deps.conversations.create("WatchedSystem", "");
    await request(app).post(`/conversations/${conversation.id}/presence`).send({});

    const res = await request(app)
      .post(`/conversations/${conversation.id}/notify`)
      .send({ text: "⚠️ 3 consecutive failed reply attempts", sender: "Agora", system: true });
    expect(res.status).toBe(200);
    expect(res.body.watching).toBeUndefined();
    expect(deps.webPush.sendNotification).toHaveBeenCalledTimes(1);
  });

  it("a stale ping stops withholding, which is the half that can lose a notification", async () => {
    await deps.store.save(validSubscription);
    const conversation = await deps.conversations.create("StoppedWatching", "");
    await request(app).post(`/conversations/${conversation.id}/presence`).send({});

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(Date.now() + WATCHING_TTL_MS + 1));
      const res = await request(app)
        .post(`/conversations/${conversation.id}/notify`)
        .send({ text: "he closed the tab a while ago", sender: "Nova" });
      expect(res.status).toBe(200);
      expect(res.body.watching).toBeUndefined();
      expect(deps.webPush.sendNotification).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("POST /conversations/:id/presence 404s on a conversation that does not exist", async () => {
    const res = await request(app).post("/conversations/nope/presence").send({});
    expect(res.status).toBe(404);
  });

  it("POST /conversations/:id/notify defaults push to true when omitted", async () => {
    await deps.store.save(validSubscription);
    const conversation = await deps.conversations.create("StreamFinal", "");
    const res = await request(app)
      .post(`/conversations/${conversation.id}/notify`)
      .send({ text: "final chunk", sender: "Gemini" });
    expect(res.status).toBe(200);
    expect(deps.webPush.sendNotification).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 2026-08-08: quiet hours. Nova's cycle went from 4 a day to 20, which is
  // ~7 replies between 22:00 and 08:00. The reply must still be written and
  // still land in the conversation -- only the phone buzz is withheld.
  // Only Date is faked: supertest needs real timers to complete a request.
  // -------------------------------------------------------------------------

  describe("quiet hours", () => {
    const night = { startMinute: 23 * 60, endMinute: 7 * 60 };

    afterEach(() => {
      vi.useRealTimers();
    });

    function atOsloTime(utcIso: string) {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(utcIso));
    }

    it("records the message but withholds the push inside the window", async () => {
      const quiet = await makeDeps({ quietHours: night });
      const quietApp = createInternalApp(quiet);
      await quiet.store.save(validSubscription);
      const conversation = await quiet.conversations.create("Night", "");
      atOsloTime("2026-08-08T21:30:00Z"); // 23:30 Oslo

      const res = await request(quietApp)
        .post(`/conversations/${conversation.id}/notify`)
        .send({ text: "cycle 44 done", sender: "Nova" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("recorded");
      expect(res.body.quietHours).toBe(true);
      expect(quiet.webPush.sendNotification).not.toHaveBeenCalled();
      // The whole point: it is there to read in the morning.
      expect((await quiet.conversations.get(conversation.id))?.messages).toMatchObject([
        { sender: "Nova", text: "cycle 44 done" },
      ]);
    });

    it("pushes normally outside the window", async () => {
      const quiet = await makeDeps({ quietHours: night });
      const quietApp = createInternalApp(quiet);
      await quiet.store.save(validSubscription);
      const conversation = await quiet.conversations.create("Day", "");
      atOsloTime("2026-08-08T12:00:00Z"); // 14:00 Oslo

      const res = await request(quietApp)
        .post(`/conversations/${conversation.id}/notify`)
        .send({ text: "afternoon", sender: "Nova" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("sent");
      expect(quiet.webPush.sendNotification).toHaveBeenCalledTimes(1);
    });

    it("withholds the legacy POST /notify push too", async () => {
      const quiet = await makeDeps({ quietHours: night });
      const quietApp = createInternalApp(quiet);
      await quiet.store.save(validSubscription);
      atOsloTime("2026-08-09T02:00:00Z"); // 04:00 Oslo

      const res = await request(quietApp).post("/notify").send({ persona: "Marcus", text: "yo" });

      expect(res.status).toBe(200);
      expect(res.body.quietHours).toBe(true);
      expect(quiet.webPush.sendNotification).not.toHaveBeenCalled();
      const main = await quiet.conversations.findByName("Main");
      expect(main?.messages).toMatchObject([{ sender: "Marcus", text: "yo" }]);
    });

    it("pushes at any hour when quiet hours are switched off", async () => {
      await deps.store.save(validSubscription); // deps has quietHours: undefined
      const conversation = await deps.conversations.create("AlwaysOn", "");
      atOsloTime("2026-08-08T23:30:00Z"); // 01:30 Oslo

      const res = await request(app)
        .post(`/conversations/${conversation.id}/notify`)
        .send({ text: "still buzzing", sender: "Nova" });

      expect(res.status).toBe(200);
      expect(deps.webPush.sendNotification).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------
  // 2026-07-31: bring back visible "thinking" -- a persona's extended-
  // thinking chunk, recorded like `system`/`activity` for exclusion from
  // LLM context/turn-taking (runner-side), rendered distinctly (frontend).
  // ---------------------------------------------------------------------

  it("POST /conversations/:id/notify records thinking:true when passed, omits it otherwise", async () => {
    await deps.store.save(validSubscription);
    const conversation = await deps.conversations.create("Test", "");
    const thought = await request(app)
      .post(`/conversations/${conversation.id}/notify`)
      .send({ text: "pondering...", sender: "Gemini", thinking: true });
    expect(thought.body.message.thinking).toBe(true);

    const normal = await request(app)
      .post(`/conversations/${conversation.id}/notify`)
      .send({ text: "a real reply", sender: "Gemini" });
    expect(normal.body.message.thinking).toBeUndefined();
  });
});

// ---------------------------------------------------------------------
// Response compression. The drawer polls ?limit=200 every 3s and a whole
// cycle's window measured 165,725 bytes uncompressed against the live pod
// (2026-08-10) -- that payload, not the drawer, is what makes showing
// Edvard a whole cycle unaffordable. Nothing in front of this app
// compresses; the Tailscale Ingress is a plain forwarder.
// ---------------------------------------------------------------------

/** Real socket, real bytes. supertest/superagent transparently inflates a
 * gzip response, so it cannot see what actually crossed the wire -- and the
 * whole point of this change is the wire. */
async function rawGet(
  app: Express,
  path: string,
  acceptEncoding: string,
): Promise<{ status: number; encoding?: string; bytes: number; body: string }> {
  const http = await import("node:http");
  const zlib = await import("node:zlib");
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as import("node:net").AddressInfo).port;
  try {
    return await new Promise((resolve, reject) => {
      const req = http.request(
        { port, path, method: "GET", headers: { "Accept-Encoding": acceptEncoding } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const raw = Buffer.concat(chunks);
            const encoding = res.headers["content-encoding"];
            const body =
              encoding === "gzip"
                ? zlib.gunzipSync(raw).toString()
                : encoding === "br"
                  ? zlib.brotliDecompressSync(raw).toString()
                  : raw.toString();
            resolve({ status: res.statusCode ?? 0, encoding, bytes: raw.length, body });
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("public app response compression", () => {
  let deps: Awaited<ReturnType<typeof makeDeps>>;
  let app: Express;
  let path: string;

  beforeEach(async () => {
    deps = await makeDeps();
    app = createPublicApp(deps);
    const created = await request(app)
      .post("/conversations")
      .send({ name: "Bulky", model: "anthropic:claude-sonnet-5" });
    const id = created.body.conversation.id;
    // Prose, not a repeated character -- a run of one byte compresses ~1000x
    // and would prove nothing about real message text.
    for (let i = 0; i < 40; i++) {
      await request(app)
        .post(`/conversations/${id}/reply`)
        .send({ text: `message ${i}: ${"the quick brown fox jumps over the lazy dog. ".repeat(12)}` });
    }
    path = `/conversations/${id}/messages?limit=200`;
  });

  afterEach(async () => {
    await fs.rm(deps.dir, { recursive: true, force: true });
  });

  it("gzips a large JSON response when the client offers gzip, and shrinks it", async () => {
    const plain = await rawGet(app, path, "identity");
    const gzipped = await rawGet(app, path, "gzip");

    expect(plain.encoding).toBeUndefined();
    expect(gzipped.encoding).toBe("gzip");
    expect(plain.bytes).toBeGreaterThan(10_000);
    expect(gzipped.bytes).toBeLessThan(plain.bytes / 2);
  });

  it("loses nothing: the inflated body is byte-identical to the uncompressed one", async () => {
    const plain = await rawGet(app, path, "identity");
    const gzipped = await rawGet(app, path, "gzip");

    expect(gzipped.status).toBe(200);
    expect(gzipped.body).toBe(plain.body);
    expect(JSON.parse(gzipped.body).messages).toHaveLength(40);
  });

  it("leaves a client that asks for identity alone -- this is what the runner sends", async () => {
    // agora_runner/http_util.py builds requests with urllib, which defaults to
    // `Accept-Encoding: identity`. The runner must keep getting plain bytes.
    const plain = await rawGet(app, path, "identity");
    expect(plain.encoding).toBeUndefined();
    expect(JSON.parse(plain.body).totalMessages).toBe(40);
  });

  it("gives a browser Brotli, which is what compression negotiates first", async () => {
    // A browser offers `br` ahead of gzip and compression@1.8 honours it.
    // No browser reaches this app directly any more -- the front end it used
    // to serve is deleted -- but Nova's site is a browser-facing proxy in
    // front of these same payloads, so the negotiation still has to work.
    const plain = await rawGet(app, path, "identity");
    const br = await rawGet(app, path, "br, gzip, deflate");

    expect(br.encoding).toBe("br");
    expect(br.bytes).toBeLessThan(plain.bytes / 2);
    expect(br.body).toBe(plain.body);
  });
});

describe("conversation folders", () => {
  let deps: Awaited<ReturnType<typeof makeDeps>>;
  let app: Express;

  beforeEach(async () => {
    deps = await makeDeps();
    app = createPublicApp(deps);
  });

  async function makeConversation(name: string): Promise<string> {
    const res = await request(app).post("/conversations").send({ name });
    return (res.body.conversation as { id: string }).id;
  }

  it("POST /folders creates once and returns the same folder by name after that", async () => {
    const first = await request(app).post("/folders").send({ name: "Nova" });
    expect(first.status).toBe(201);
    expect(first.body.status).toBe("created");
    const again = await request(app).post("/folders").send({ name: "Nova" });
    expect(again.status).toBe(200);
    expect(again.body.status).toBe("exists");
    expect(again.body.folder.id).toBe(first.body.folder.id);
    const listed = await request(app).get("/folders");
    expect(listed.body.folders).toHaveLength(1);
  });

  it("POST /folders rejects a blank name", async () => {
    expect((await request(app).post("/folders").send({})).status).toBe(400);
    expect((await request(app).post("/folders").send({ name: "   " })).status).toBe(400);
  });

  it("PATCH /conversations/:id moves into a folder and back to the top level", async () => {
    const folderId = (await request(app).post("/folders").send({ name: "Nova" })).body.folder.id;
    const id = await makeConversation("Cycle 1");

    const moved = await request(app).patch(`/conversations/${id}`).send({ folderId });
    expect(moved.status).toBe(200);
    expect(moved.body.conversation.folderId).toBe(folderId);
    expect((await deps.conversations.get(id))?.folderId).toBe(folderId);

    const home = await request(app).patch(`/conversations/${id}`).send({ folderId: null });
    expect(home.status).toBe(200);
    expect(home.body.conversation.folderId).toBeUndefined();
    expect((await deps.conversations.get(id))?.folderId).toBeUndefined();
  });

  it("PATCH /conversations/:id refuses an unknown folder rather than storing it", async () => {
    const id = await makeConversation("Cycle 1");
    const res = await request(app).patch(`/conversations/${id}`).send({ folderId: "nope" });
    expect(res.status).toBe(400);
    expect((await deps.conversations.get(id))?.folderId).toBeUndefined();
  });

  it("an omitted folderId leaves the conversation where it is", async () => {
    const folderId = (await request(app).post("/folders").send({ name: "Nova" })).body.folder.id;
    const id = await makeConversation("Cycle 1");
    await request(app).patch(`/conversations/${id}`).send({ folderId });
    await request(app).patch(`/conversations/${id}`).send({ name: "Cycle 1 renamed" });
    expect((await deps.conversations.get(id))?.folderId).toBe(folderId);
  });

  it("DELETE /folders/:id moves its conversations back to the top level, never deletes them", async () => {
    const folderId = (await request(app).post("/folders").send({ name: "Nova" })).body.folder.id;
    const kept = await makeConversation("Cycle 1");
    const other = await makeConversation("Elsewhere");
    await request(app).patch(`/conversations/${kept}`).send({ folderId });

    const res = await request(app).delete(`/folders/${folderId}`);
    expect(res.status).toBe(200);
    expect(res.body.movedOut).toBe(1);
    expect((await request(app).get("/folders")).body.folders).toHaveLength(0);
    expect(await deps.conversations.get(kept)).not.toBeNull();
    expect((await deps.conversations.get(kept))?.folderId).toBeUndefined();
    expect(await deps.conversations.get(other)).not.toBeNull();
  });

  it("PATCH and DELETE /folders/:id 404 on an unknown id", async () => {
    expect((await request(app).patch("/folders/nope").send({ name: "x" })).status).toBe(404);
    expect((await request(app).delete("/folders/nope")).status).toBe(404);
  });

  it("GET /conversations reports folderId so the drawer can group without a second join", async () => {
    const folderId = (await request(app).post("/folders").send({ name: "Nova" })).body.folder.id;
    const id = await makeConversation("Cycle 1");
    await request(app).patch(`/conversations/${id}`).send({ folderId });
    const listed = await request(app).get("/conversations");
    const row = (listed.body.conversations as { id: string; folderId?: string }[]).find((c) => c.id === id);
    expect(row?.folderId).toBe(folderId);
  });

  it("the internal app carries the same folder routes, so the runner can file its own cycle", async () => {
    const internal = createInternalApp(deps);
    const created = await request(internal).post("/folders").send({ name: "Nova" });
    expect(created.status).toBe(201);
    expect((await request(internal).get("/folders")).body.folders).toHaveLength(1);
  });
});

describe("forking a conversation in a folder", () => {
  it("keeps the fork in its root's folder", async () => {
    const deps = await makeDeps();
    const app = createPublicApp(deps);
    const folderId = (await request(app).post("/folders").send({ name: "Nova" })).body.folder.id;
    const created = await request(app).post("/conversations").send({ name: "Cycle 1" });
    const id = (created.body.conversation as { id: string }).id;
    await request(app).patch(`/conversations/${id}`).send({ folderId });
    await deps.conversations.appendMessage(id, "Edvard", "hello");

    const forked = await deps.conversations.fork(id);
    expect(forked?.folderId).toBe(folderId);
    expect((await deps.conversations.get(forked!.id))?.folderId).toBe(folderId);
  });

  it("leaves a fork of an unfiled conversation unfiled", async () => {
    const deps = await makeDeps();
    const app = createPublicApp(deps);
    const created = await request(app).post("/conversations").send({ name: "Cycle 1" });
    const id = (created.body.conversation as { id: string }).id;
    const forked = await deps.conversations.fork(id);
    expect(forked?.folderId).toBeUndefined();
  });
});
