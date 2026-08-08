import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import pino from "pino";
import type { Express } from "express";
import {
  createPublicApp,
  createInternalApp,
  type ServerDeps,
  type WebPushSender,
  type InvokePayload,
} from "./server.js";
import { SubscriptionStore, type PushSubscriptionRecord } from "./push/subscription-store.js";
import { MessageStore } from "./chat/message-store.js";
import { ConversationStore } from "./chat/conversation-store.js";
import { PersonaStore } from "./chat/persona-store.js";
import { HeartbeatStore } from "./chat/heartbeat-store.js";
import { WorkflowStore } from "./chat/workflow-store.js";
import { AuditStore } from "./chat/audit-store.js";
import { AttachmentStore } from "./chat/attachment-store.js";
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
    expect(entry.model).toBe("gemini:gemini-flash-latest");
    expect(entry.personality).toBe("new");
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

  it("PATCH /conversations/:id routes personality/model edits to the curator persona", async () => {
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
    expect(persona?.model).toBe("gemini:gemini-flash-latest");
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
      name: "Listener",
      model: "anthropic:claude-sonnet-5",
    });

    // two curators → 400
    expect(
      (
        await request(app)
          .patch(`/conversations/${id}`)
          .send({
            personas: [
              { personaId: curatorId, role: "curator" },
              { personaId: second.id, role: "curator" },
            ],
          })
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

    // valid curator + listener → 200, joined response carries both
    const ok = await request(app)
      .patch(`/conversations/${id}`)
      .send({
        personas: [
          { personaId: curatorId, role: "curator" },
          { personaId: second.id, role: "listener" },
        ],
      });
    expect(ok.status).toBe(200);
    expect(ok.body.conversation.personas).toHaveLength(2);
  });

  it("POST /conversations/:id/fork forks at a message with added listeners", async () => {
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
    expect(res.body.conversation.personas).toHaveLength(2);

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

  it("POST /conversations/:id/notify defaults push to true when omitted", async () => {
    await deps.store.save(validSubscription);
    const conversation = await deps.conversations.create("StreamFinal", "");
    const res = await request(app)
      .post(`/conversations/${conversation.id}/notify`)
      .send({ text: "final chunk", sender: "Gemini" });
    expect(res.status).toBe(200);
    expect(deps.webPush.sendNotification).toHaveBeenCalledTimes(1);
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
