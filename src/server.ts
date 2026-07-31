import express, { type Express, type RequestHandler } from "express";
import multer from "multer";
import type pino from "pino";
import type { Config } from "./config.js";
import type { SubscriptionStore, PushSubscriptionRecord } from "./push/subscription-store.js";
import type { MessageStore } from "./chat/message-store.js";
import type {
  Conversation,
  ConversationStore,
  ConversationUpdate,
  PersonaLink,
} from "./chat/conversation-store.js";
import type { PersonaStore, PersonaCapabilities, Persona } from "./chat/persona-store.js";
import type { HeartbeatStore, HeartbeatUpdate } from "./chat/heartbeat-store.js";
import { SCHEDULE_RE } from "./chat/heartbeat-store.js";
import type { WorkflowStore, WorkflowUpdate, Step } from "./chat/workflow-store.js";
import { wouldCreateCycle } from "./chat/workflow-store.js";
import type { AuditStore } from "./chat/audit-store.js";
import { MAX_ATTACHMENT_BYTES, type AttachmentStore } from "./chat/attachment-store.js";
import { MODEL_CATALOG } from "./models.js";
import {
  notificationsSent,
  notificationsFailed,
  repliesReceived,
  subscriptionsRegistered,
} from "./metrics.js";

const VALID_MODEL_IDS = new Set(MODEL_CATALOG.map((m) => m.id));

/** Payload for the runner's synchronous /invoke (Decisions/0005). Either a
 * personaId (runner fetches the record itself — capabilities server-side)
 * or inline persona fields (preview of an unsaved draft; always tool-less). */
export interface InvokePayload {
  personaId?: string;
  persona?: { personality: string; model: string; thinking: boolean };
  messages: { role: "user" | "assistant"; content: string }[];
}

export interface WebPushSender {
  sendNotification(
    subscription: PushSubscriptionRecord,
    payload: string,
  ): Promise<unknown>;
}

export interface ServerDeps {
  config: Config;
  store: SubscriptionStore;
  messages: MessageStore;
  conversations: ConversationStore;
  personas: PersonaStore;
  heartbeats: HeartbeatStore;
  workflows: WorkflowStore;
  audit: AuditStore;
  attachments: AttachmentStore;
  webPush: WebPushSender;
  logger: pino.Logger;
  /** undefined → ask/preview return 503 (RUNNER_URL not configured). */
  invokeRunner?: (payload: InvokePayload) => Promise<string>;
}

function isValidSubscription(body: unknown): body is PushSubscriptionRecord {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  if (typeof b.endpoint !== "string" || b.endpoint.length === 0) return false;
  if (typeof b.keys !== "object" || b.keys === null) return false;
  const keys = b.keys as Record<string, unknown>;
  return typeof keys.p256dh === "string" && typeof keys.auth === "string";
}

function parseCapabilities(body: unknown): Partial<PersonaCapabilities> | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const b = body as Record<string, unknown>;
  const out: Partial<PersonaCapabilities> = {};
  for (const key of [
    "webSearch",
    "vaultRead",
    "vaultWrite",
    "codeExecution",
    "kubectlRead",
    "githubRead",
    "manageAgora",
    "githubWrite",
    "githubMerge",
    "terminalExec",
  ] as const) {
    if (typeof b[key] === "boolean") out[key] = b[key];
  }
  return out;
}

/** Parses+validates a Workflow's steps array from a request body.
 * Returns an error string on the first problem found, or `undefined` if
 * `steps` is valid (including an empty array — a Workflow with no steps
 * yet is fine, same as an empty vaultPaths on Heartbeat). */
function parseSteps(body: unknown): { steps: Step[] } | { error: string } {
  if (body === undefined) return { steps: [] };
  if (!Array.isArray(body)) return { error: "steps must be an array" };
  const steps: Step[] = [];
  for (const raw of body) {
    if (typeof raw !== "object" || raw === null) return { error: "each step must be an object" };
    const s = raw as Record<string, unknown>;
    if (typeof s.prompt !== "string") return { error: "step.prompt must be a string" };
    if (typeof s.loopCount !== "number" || !Number.isInteger(s.loopCount) || s.loopCount < 1) {
      return { error: "step.loopCount must be a positive integer" };
    }
    const toolWhitelist = Array.isArray(s.toolWhitelist)
      ? (s.toolWhitelist as unknown[]).filter((t): t is string => typeof t === "string")
      : [];
    const filepath = typeof s.filepath === "string" && s.filepath.length > 0 ? s.filepath : undefined;
    if (toolWhitelist.includes("scoped_write") && !filepath) {
      return { error: "step.filepath is required when scoped_write is in toolWhitelist" };
    }
    const workflowRef = typeof s.workflowRef === "string" && s.workflowRef.length > 0 ? s.workflowRef : undefined;
    const personaIds = Array.isArray(s.personaIds)
      ? (s.personaIds as unknown[]).filter((p): p is string => typeof p === "string" && p.length > 0)
      : undefined;
    steps.push({
      prompt: s.prompt,
      loopCount: s.loopCount,
      toolWhitelist,
      ...(filepath ? { filepath } : {}),
      ...(workflowRef ? { workflowRef } : {}),
      ...(personaIds && personaIds.length > 0 ? { personaIds } : {}),
    });
  }
  return { steps };
}

/** Joined view (Architecture §2): the curator persona's live fields ride
 * along top-level so the previous runner — which reads
 * detail.personality/model/thinking — keeps working unchanged against
 * this backend during a mixed-version deploy.
 *
 * Takes `Omit<Conversation, "messages">` (not `Conversation`) so it works
 * for both full conversations and list summaries — found live 2026-07-22:
 * GET /conversations only ever called this with the summary shape and
 * fell back to the stale inline fields, so the drawer/Studio kept showing
 * a conversation's *original* model/personality forever, even after the
 * curator persona was edited. Every other route was already correct;
 * this was the one spot the join never actually ran. */
async function enrichConversation(
  conversation: Omit<Conversation, "messages"> & { lastMessageAt?: string | null },
  personas: PersonaStore,
): Promise<Record<string, unknown>> {
  let personality = conversation.personality;
  let model = conversation.model;
  let thinking = conversation.thinking;
  const enrichedLinks: Record<string, unknown>[] = [];
  for (const link of conversation.personas ?? []) {
    const persona = await personas.get(link.personaId);
    if (!persona) continue;
    enrichedLinks.push({
      personaId: link.personaId,
      role: link.role,
      name: persona.name,
      model: persona.model,
    });
    if (link.role === "curator") {
      personality = persona.personality;
      model = persona.model;
      thinking = persona.thinking;
    }
  }
  return {
    id: conversation.id,
    name: conversation.name,
    personality,
    model,
    thinking,
    personas: conversation.personas ? enrichedLinks : undefined,
    status: conversation.status,
    memory: conversation.memory,
    tags: conversation.tags,
    archived: conversation.archived,
    stickyFallback: conversation.stickyFallback,
    rootId: conversation.rootId,
    forkedFrom: conversation.forkedFrom,
    createdAt: conversation.createdAt,
    ...(conversation.lastMessageAt !== undefined ? { lastMessageAt: conversation.lastMessageAt } : {}),
  };
}

function toInvokeMessages(
  conversation: Conversation,
  extraUserText?: string,
): InvokePayload["messages"] {
  const result: InvokePayload["messages"] = [];
  for (const message of conversation.messages.slice(-30)) {
    if (message.forgotten || message.system || message.activity) continue;
    const role = message.sender === "Edvard" ? "user" : "assistant";
    const content =
      role === "assistant" && (conversation.personas?.length ?? 0) > 1
        ? `[${message.sender}]: ${message.text}`
        : message.text;
    result.push({ role, content });
  }
  if (extraUserText) result.push({ role: "user", content: extraUserText });
  return result;
}

async function validatePersonaLinks(
  links: unknown,
  personas: PersonaStore,
): Promise<PersonaLink[] | { error: string }> {
  if (!Array.isArray(links) || links.length === 0) {
    return { error: "personas must be a non-empty array" };
  }
  const parsed: PersonaLink[] = [];
  let curators = 0;
  for (const raw of links) {
    const link = raw as Record<string, unknown>;
    if (typeof link.personaId !== "string") return { error: "personaId is required" };
    if (link.role !== "curator" && link.role !== "listener") {
      return { error: "role must be curator or listener" };
    }
    if (!(await personas.get(link.personaId))) {
      return { error: `unknown persona ${link.personaId}` };
    }
    if (link.role === "curator") curators++;
    parsed.push({ personaId: link.personaId, role: link.role });
  }
  if (curators !== 1) return { error: "exactly one curator is required" };
  return parsed;
}

/** Find-or-create a conversation by name with the given persona as sole
 * curator — same "reuse if a conversation already has this name" shape as
 * POST /conversations' inline-persona path. Used by the Heartbeat Creator's
 * "new empty channel" option, which needs the id of a fresh conversation
 * without a separate round-trip to create it first. */
async function findOrCreateConversationForPersona(
  name: string,
  persona: Persona,
  deps: ServerDeps,
): Promise<Conversation> {
  const existing = await deps.conversations.findByName(name);
  if (existing) return existing;
  return deps.conversations.create(name, persona.personality, persona.model, persona.thinking, [
    { personaId: persona.id, role: "curator" },
  ]);
}

/** Find-or-create the "Main" conversation the legacy shim routes target
 * (ADR 0008) — normally created by the startup migration; the lazy path
 * only fires on a fresh install with no history. */
async function resolveMain(deps: ServerDeps): Promise<Conversation> {
  const existing = await deps.conversations.findByName("Main");
  if (existing) return existing;
  let persona = (await deps.personas.list()).find((p) => !p.isTemplate && p.name === "Agora");
  persona ??= await deps.personas.create({
    name: "Agora",
    personality: "You are Agora, Edvard's own assistant inside his self-hosted chat platform.",
    model: MODEL_CATALOG[0].id,
  });
  return deps.conversations.create("Main", "", persona.model, persona.thinking, [
    { personaId: persona.id, role: "curator" },
  ]);
}

/** Factored out (alongside the Heartbeat/Workflow create routes below) so
 * both the public app and the internal agent-facing app can register it —
 * ADR 0007's "agent-facing writes live on the internal app" principle,
 * needed for the runner's create_persona tool. */
function registerCreatePersonaRoute(app: Express, deps: ServerDeps): void {
  app.post("/personas", async (req, res) => {
    const body = req.body as Record<string, unknown>;
    if (typeof body.name !== "string" || body.name.length === 0) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    if (typeof body.model !== "string" || !VALID_MODEL_IDS.has(body.model)) {
      res.status(400).json({ error: "unknown model" });
      return;
    }
    const persona = await deps.personas.create({
      name: body.name,
      personality: typeof body.personality === "string" ? body.personality : "",
      model: body.model,
      thinking: typeof body.thinking === "boolean" ? body.thinking : false,
      capabilities: parseCapabilities(body.capabilities),
      sharedMemory: typeof body.sharedMemory === "string" ? body.sharedMemory : "",
      isTemplate: typeof body.isTemplate === "boolean" ? body.isTemplate : false,
    });
    res.status(201).json({ status: "created", persona });
  });
}

/** See registerCreatePersonaRoute's docstring. */
function registerCreateHeartbeatRoute(app: Express, deps: ServerDeps): void {
  app.post("/heartbeats", async (req, res) => {
    const body = req.body as Record<string, unknown>;
    if (typeof body.name !== "string" || body.name.length === 0) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    if (typeof body.schedule !== "string" || !SCHEDULE_RE.test(body.schedule)) {
      res.status(400).json({ error: "schedule must be daily@HH:MM or every@N[m|h]" });
      return;
    }
    if (typeof body.personaId !== "string") {
      res.status(400).json({ error: "personaId is required" });
      return;
    }
    const persona = await deps.personas.get(body.personaId);
    if (!persona) {
      res.status(400).json({ error: "unknown persona" });
      return;
    }

    let conversationId: string;
    if (typeof body.conversationId === "string") {
      if (!(await deps.conversations.get(body.conversationId))) {
        res.status(400).json({ error: "unknown conversation" });
        return;
      }
      conversationId = body.conversationId;
    } else if (
      typeof body.newConversationName === "string" &&
      body.newConversationName.length > 0
    ) {
      // Inline empty-channel creation (previously you had to create the
      // channel and persona separately first, then create the heartbeat) —
      // the persona speaks into a brand new conversation created just for
      // this heartbeat, same shape as a manual New Conversation using an
      // existing persona.
      const conversation = await findOrCreateConversationForPersona(
        body.newConversationName,
        persona,
        deps,
      );
      conversationId = conversation.id;
    } else {
      res.status(400).json({ error: "conversationId or newConversationName is required" });
      return;
    }

    if (body.workflowId !== undefined && !(await deps.workflows.get(body.workflowId as string))) {
      res.status(400).json({ error: "unknown workflow" });
      return;
    }
    const vaultPaths = Array.isArray(body.vaultPaths)
      ? (body.vaultPaths as unknown[]).filter((p): p is string => typeof p === "string")
      : [];
    const heartbeat = await deps.heartbeats.create({
      name: body.name,
      personaId: body.personaId,
      conversationId,
      schedule: body.schedule,
      task: typeof body.task === "string" ? body.task : "",
      workflowId: typeof body.workflowId === "string" ? body.workflowId : undefined,
      vaultPaths,
      enabled: typeof body.enabled === "boolean" ? body.enabled : true,
    });
    res.status(201).json({ status: "created", heartbeat });
  });
}

/** See registerCreatePersonaRoute's docstring. */
function registerCreateWorkflowRoute(app: Express, deps: ServerDeps): void {
  app.post("/workflows", async (req, res) => {
    const body = req.body as Record<string, unknown>;
    if (typeof body.name !== "string" || body.name.length === 0) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    const parsed = parseSteps(body.steps);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const existing = await deps.workflows.list();
    for (const step of parsed.steps) {
      if (step.workflowRef && !existing.some((w) => w.id === step.workflowRef)) {
        res.status(400).json({ error: `unknown workflowRef: ${step.workflowRef}` });
        return;
      }
      for (const personaId of step.personaIds ?? []) {
        if (!(await deps.personas.get(personaId))) {
          res.status(400).json({ error: `unknown persona in step.personaIds: ${personaId}` });
          return;
        }
      }
    }
    // No cycle-check needed on create: nothing can already reference a
    // workflow id that doesn't exist yet, so a brand-new workflow can
    // never be part of a pre-existing cycle back to itself. Cycle-checking
    // matters on update, once other workflows may already point at this id.
    const workflow = await deps.workflows.create({
      name: body.name,
      description: typeof body.description === "string" ? body.description : "",
      steps: parsed.steps,
    });
    res.status(201).json({ status: "created", workflow });
  });
}

function registerCreateConversationRoute(app: Express, deps: ServerDeps): void {
  app.post("/conversations", async (req, res) => {
    const { name, personality, model, thinking, personaId, capabilities } = req.body as {
      name?: unknown;
      personality?: unknown;
      model?: unknown;
      thinking?: unknown;
      personaId?: unknown;
      capabilities?: unknown;
    };
    if (typeof name !== "string" || name.length === 0) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    if (model !== undefined && !VALID_MODEL_IDS.has(model as string)) {
      res.status(400).json({ error: "unknown model" });
      return;
    }
    const existing = await deps.conversations.findByName(name);
    if (existing) {
      res.status(200).json({ status: "exists", conversation: await enrichConversation(existing, deps.personas) });
      return;
    }

    let persona;
    if (typeof personaId === "string") {
      persona = await deps.personas.get(personaId);
      if (!persona) {
        res.status(400).json({ error: "unknown persona" });
        return;
      }
    } else {
      // Inline persona creation — the persona carries the conversation's
      // name; clone-for-divergence applies from here on (Architecture §2).
      persona = await deps.personas.create({
        name,
        personality: typeof personality === "string" ? personality : "",
        model: typeof model === "string" ? model : MODEL_CATALOG[0].id,
        thinking: typeof thinking === "boolean" ? thinking : false,
        capabilities: parseCapabilities(capabilities),
      });
    }
    const conversation = await deps.conversations.create(
      name,
      persona.personality,
      persona.model,
      persona.thinking,
      [{ personaId: persona.id, role: "curator" }],
    );
    res.status(201).json({ status: "created", conversation: await enrichConversation(conversation, deps.personas) });
  });
}

function registerUpdateConversationRoute(app: Express, deps: ServerDeps): void {
  app.patch("/conversations/:id", async (req, res) => {
    const body = req.body as Record<string, unknown>;
    if (body.model !== undefined && !VALID_MODEL_IDS.has(body.model as string)) {
      res.status(400).json({ error: "unknown model" });
      return;
    }
    const conversation = await deps.conversations.get(req.params.id);
    if (!conversation) {
      res.status(404).json({ error: "conversation not found" });
      return;
    }

    const updates: ConversationUpdate = {};
    if (typeof body.name === "string") updates.name = body.name;
    if (typeof body.archived === "boolean") updates.archived = body.archived;
    if (body.status === "active" || body.status === "paused") updates.status = body.status;
    if (typeof body.memory === "string") updates.memory = body.memory;
    if (typeof body.stickyFallback === "boolean") updates.stickyFallback = body.stickyFallback;
    if (Array.isArray(body.tags) && body.tags.every((t) => typeof t === "string")) {
      updates.tags = body.tags as string[];
    }
    if (body.personas !== undefined) {
      const links = await validatePersonaLinks(body.personas, deps.personas);
      if ("error" in links) {
        res.status(400).json({ error: links.error });
        return;
      }
      updates.personas = links;
    }

    // Legacy personality/model/thinking edits route through to the curator
    // persona once one exists — editing a conversation's settings edits
    // what's actually displayed/used (joined fields), not a dead cache.
    const curator = (updates.personas ?? conversation.personas)?.find(
      (p) => p.role === "curator",
    );
    const personaEdits: Record<string, unknown> = {};
    if (typeof body.personality === "string") personaEdits.personality = body.personality;
    if (typeof body.model === "string") personaEdits.model = body.model;
    if (typeof body.thinking === "boolean") personaEdits.thinking = body.thinking;
    if (Object.keys(personaEdits).length > 0) {
      if (curator) {
        await deps.personas.update(curator.personaId, personaEdits);
      } else {
        Object.assign(updates, personaEdits);
      }
    }

    const updated = await deps.conversations.update(req.params.id, updates);
    if (!updated) {
      res.status(404).json({ error: "conversation not found" });
      return;
    }
    res.status(200).json({ status: "updated", conversation: await enrichConversation(updated, deps.personas) });
  });
}

/**
 * Public app: everything reachable from Edvard's phone via the
 * Tailscale-only Ingress. No app-level auth — the Tailscale/NetworkPolicy
 * network boundary is the trust boundary, same as everywhere else on this
 * platform (agent-facing writes live on the internal app, ADR 0007).
 */
export function createPublicApp(deps: ServerDeps): Express {
  const { config, store, conversations, personas, heartbeats, workflows, audit, attachments, logger } = deps;
  const app = express();
  // Memory storage — files are small (MAX_ATTACHMENT_BYTES caps it) and
  // written straight through to AttachmentStore's own disk layout; no
  // benefit to multer's own disk-staging step for this size.
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ATTACHMENT_BYTES } });

  /** Resolves attachmentIds → stored metadata, silently dropping anything
   * unknown rather than 400ing the whole reply — an attachment that failed
   * to upload shouldn't also block the text that was typed alongside it. */
  async function resolveAttachments(ids: unknown): Promise<import("./chat/attachment-store.js").AttachmentMeta[]> {
    if (!Array.isArray(ids)) return [];
    const resolved = await Promise.all(
      ids.filter((id): id is string => typeof id === "string").map((id) => attachments.getMeta(id)),
    );
    return resolved.filter((m): m is import("./chat/attachment-store.js").AttachmentMeta => m !== null);
  }
  app.use(express.json());
  app.use(express.static("public"));

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.get("/health", (_req, res) => {
    const ready = Boolean(config.vapidPublicKey && config.vapidPrivateKey);
    res.status(ready ? 200 : 503).json({ status: ready ? "ok" : "not configured" });
  });

  app.get("/vapid-public-key", (_req, res) => {
    if (!config.vapidPublicKey) {
      res.status(503).json({ error: "VAPID not configured" });
      return;
    }
    res.status(200).json({ publicKey: config.vapidPublicKey });
  });

  app.post("/subscribe", async (req, res) => {
    if (!isValidSubscription(req.body)) {
      res.status(400).json({ error: "invalid subscription" });
      return;
    }
    await store.save(req.body);
    subscriptionsRegistered.add(1);
    logger.info({ endpoint: req.body.endpoint }, "subscription registered");
    res.status(201).json({ status: "subscribed" });
  });

  // ---- Attachments (Issues.md: "Sending files, images or voice does not
  // work") — upload returns metadata only; the id is what a reply's
  // attachmentIds references. Two-step (upload, then reply) rather than
  // multipart-on-the-reply-itself so a failed/retried reply doesn't
  // re-upload files that already made it to storage. --------------------
  app.post("/attachments", upload.single("file"), async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: "file is required" });
      return;
    }
    const attachment = await attachments.save(
      req.file.originalname,
      req.file.mimetype || "application/octet-stream",
      req.file.buffer,
    );
    res.status(201).json({ attachment });
  });

  app.get("/attachments/:id", async (req, res) => {
    const meta = await attachments.getMeta(req.params.id);
    if (!meta) {
      res.status(404).json({ error: "attachment not found" });
      return;
    }
    const content = await attachments.getContent(req.params.id);
    if (!content) {
      res.status(404).json({ error: "attachment not found" });
      return;
    }
    res.set("Content-Type", meta.mimeType);
    // Images render inline in the chat bubble; everything else downloads
    // instead of trying (and likely failing) to navigate the browser to it.
    res.set(
      "Content-Disposition",
      meta.mimeType.startsWith("image/")
        ? "inline"
        : `attachment; filename="${encodeURIComponent(meta.filename)}"`,
    );
    res.status(200).send(content);
  });

  // ---- Legacy Main shims (ADR 0008) — kept for any old caller; the new
  // frontend talks to /conversations/* exclusively. -----------------------
  app.get("/messages", async (_req, res) => {
    const main = await conversations.findByName("Main");
    res.status(200).json({ messages: main?.messages ?? [] });
  });

  app.post("/reply", async (req, res) => {
    const { text, model } = req.body as { text?: unknown; model?: unknown };
    if (typeof text !== "string" || text.length === 0) {
      res.status(400).json({ error: "text is required" });
      return;
    }
    if (model !== undefined && !VALID_MODEL_IDS.has(model as string)) {
      res.status(400).json({ error: "unknown model" });
      return;
    }
    const main = await resolveMain(deps);
    const message = await conversations.appendMessage(
      main.id,
      "Edvard",
      text,
      typeof model === "string" ? model : undefined,
    );
    repliesReceived.add(1);
    res.status(200).json({ status: "received", message });
  });

  app.delete("/messages/:messageId", async (req, res) => {
    const main = await conversations.findByName("Main");
    const deleted = main
      ? await conversations.deleteMessage(main.id, req.params.messageId)
      : false;
    if (!deleted) {
      res.status(404).json({ error: "message not found" });
      return;
    }
    res.status(200).json({ status: "deleted" });
  });

  app.patch("/messages/:messageId", async (req, res) => {
    const { text } = req.body as { text?: unknown };
    if (typeof text !== "string" || text.length === 0) {
      res.status(400).json({ error: "text is required" });
      return;
    }
    const main = await conversations.findByName("Main");
    const message = main
      ? await conversations.editMessage(main.id, req.params.messageId, text)
      : null;
    if (!message) {
      res.status(404).json({ error: "message not found" });
      return;
    }
    res.status(200).json({ status: "updated", message });
  });

  // Search covers conversations only — the legacy MessageStore's content
  // was imported into the Main conversation by the migration; searching
  // both would double-report every historical Main hit.
  app.get("/search", async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q) {
      res.status(200).json({ results: [] });
      return;
    }
    res.status(200).json({ results: await conversations.search(q) });
  });

  registerCreateConversationRoute(app, deps);
  registerUpdateConversationRoute(app, deps);
  registerCreatePersonaRoute(app, deps);
  registerCreateHeartbeatRoute(app, deps);
  registerCreateWorkflowRoute(app, deps);

  app.get("/models", (_req, res) => {
    res.status(200).json({ models: MODEL_CATALOG });
  });

  // ---- Personas ---------------------------------------------------------
  app.get("/personas", async (_req, res) => {
    res.status(200).json({ personas: await personas.list() });
  });

  app.get("/personas/:id", async (req, res) => {
    const persona = await personas.get(req.params.id);
    if (!persona) {
      res.status(404).json({ error: "persona not found" });
      return;
    }
    res.status(200).json({ persona });
  });

  app.patch("/personas/:id", async (req, res) => {
    const body = req.body as Record<string, unknown>;
    if (body.model !== undefined && !VALID_MODEL_IDS.has(body.model as string)) {
      res.status(400).json({ error: "unknown model" });
      return;
    }
    const persona = await personas.update(req.params.id, {
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      ...(typeof body.personality === "string" ? { personality: body.personality } : {}),
      ...(typeof body.model === "string" ? { model: body.model } : {}),
      ...(typeof body.thinking === "boolean" ? { thinking: body.thinking } : {}),
      ...(typeof body.sharedMemory === "string" ? { sharedMemory: body.sharedMemory } : {}),
      ...(typeof body.isTemplate === "boolean" ? { isTemplate: body.isTemplate } : {}),
      capabilities: parseCapabilities(body.capabilities),
    });
    if (!persona) {
      res.status(404).json({ error: "persona not found" });
      return;
    }
    res.status(200).json({ status: "updated", persona });
  });

  app.delete("/personas/:id", async (req, res) => {
    // Referential guard — a dangling personaId in a conversation or
    // heartbeat would break the runner's join, so deletion is refused
    // while references exist (the UI says which).
    const usedBy = (await conversations.list()).filter((c) =>
      c.personas?.some((p) => p.personaId === req.params.id),
    );
    const usedByHeartbeats = (await heartbeats.list()).filter(
      (h) => h.personaId === req.params.id,
    );
    if (usedBy.length > 0 || usedByHeartbeats.length > 0) {
      res.status(409).json({
        error: "persona is in use",
        conversations: usedBy.map((c) => c.name),
        heartbeats: usedByHeartbeats.map((h) => h.name),
      });
      return;
    }
    const deleted = await personas.delete(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: "persona not found" });
      return;
    }
    res.status(200).json({ status: "deleted" });
  });

  app.post("/personas/:id/clone", async (req, res) => {
    const { name } = req.body as { name?: unknown };
    const persona = await personas.clone(
      req.params.id,
      typeof name === "string" && name.length > 0 ? name : undefined,
    );
    if (!persona) {
      res.status(404).json({ error: "persona not found" });
      return;
    }
    res.status(201).json({ status: "created", persona });
  });

  // Preview a draft persona (Decisions/0005) — inline fields, nothing
  // saved, and the runner runs inline-persona invokes tool-less by design
  // (critique #9: a draft with vaultWrite must not be able to write).
  app.post("/personas/preview", async (req, res) => {
    const body = req.body as Record<string, unknown>;
    if (typeof body.text !== "string" || body.text.length === 0) {
      res.status(400).json({ error: "text is required" });
      return;
    }
    if (typeof body.model !== "string" || !VALID_MODEL_IDS.has(body.model)) {
      res.status(400).json({ error: "unknown model" });
      return;
    }
    if (!deps.invokeRunner) {
      res.status(503).json({ error: "runner not configured" });
      return;
    }
    try {
      const reply = await deps.invokeRunner({
        persona: {
          personality: typeof body.personality === "string" ? body.personality : "",
          model: body.model,
          thinking: typeof body.thinking === "boolean" ? body.thinking : false,
        },
        messages: [{ role: "user", content: body.text }],
      });
      res.status(200).json({ reply });
    } catch (err) {
      logger.error({ err }, "preview invoke failed");
      res.status(502).json({ error: "runner invoke failed" });
    }
  });

  // ---- Heartbeats -------------------------------------------------------
  app.get("/heartbeats", async (_req, res) => {
    res.status(200).json({ heartbeats: await heartbeats.list() });
  });

  app.patch("/heartbeats/:id", async (req, res) => {
    const body = req.body as Record<string, unknown>;
    if (body.schedule !== undefined && !SCHEDULE_RE.test(body.schedule as string)) {
      res.status(400).json({ error: "schedule must be daily@HH:MM or every@N[m|h]" });
      return;
    }
    if (body.personaId !== undefined && !(await personas.get(body.personaId as string))) {
      res.status(400).json({ error: "unknown persona" });
      return;
    }
    if (
      body.conversationId !== undefined &&
      !(await conversations.get(body.conversationId as string))
    ) {
      res.status(400).json({ error: "unknown conversation" });
      return;
    }
    if (
      body.workflowId !== undefined &&
      body.workflowId !== null &&
      !(await workflows.get(body.workflowId as string))
    ) {
      res.status(400).json({ error: "unknown workflow" });
      return;
    }
    const updates: HeartbeatUpdate = {};
    if (typeof body.name === "string") updates.name = body.name;
    if (typeof body.personaId === "string") updates.personaId = body.personaId;
    if (typeof body.conversationId === "string") updates.conversationId = body.conversationId;
    if (typeof body.schedule === "string") updates.schedule = body.schedule;
    if (typeof body.task === "string") updates.task = body.task;
    if (typeof body.workflowId === "string" || body.workflowId === null) {
      updates.workflowId = body.workflowId;
    }
    if (Array.isArray(body.vaultPaths)) {
      updates.vaultPaths = (body.vaultPaths as unknown[]).filter(
        (p): p is string => typeof p === "string",
      );
    }
    if (typeof body.enabled === "boolean") updates.enabled = body.enabled;
    const heartbeat = await heartbeats.update(req.params.id, updates);
    if (!heartbeat) {
      res.status(404).json({ error: "heartbeat not found" });
      return;
    }
    res.status(200).json({ status: "updated", heartbeat });
  });

  app.delete("/heartbeats/:id", async (req, res) => {
    const deleted = await heartbeats.delete(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: "heartbeat not found" });
      return;
    }
    res.status(200).json({ status: "deleted" });
  });

  app.post("/heartbeats/:id/run", async (req, res) => {
    const heartbeat = await heartbeats.update(req.params.id, { forceRun: true });
    if (!heartbeat) {
      res.status(404).json({ error: "heartbeat not found" });
      return;
    }
    res.status(200).json({ status: "queued", heartbeat });
  });

  // ---- Workflows (Decisions/0009) ---------------------------------------
  app.get("/workflows", async (_req, res) => {
    res.status(200).json({ workflows: await workflows.list() });
  });

  app.get("/workflows/:id", async (req, res) => {
    const workflow = await workflows.get(req.params.id);
    if (!workflow) {
      res.status(404).json({ error: "workflow not found" });
      return;
    }
    res.status(200).json({ workflow });
  });

  app.patch("/workflows/:id", async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const updates: WorkflowUpdate = {};
    if (typeof body.name === "string") updates.name = body.name;
    if (typeof body.description === "string") updates.description = body.description;
    if (body.steps !== undefined) {
      const parsed = parseSteps(body.steps);
      if ("error" in parsed) {
        res.status(400).json({ error: parsed.error });
        return;
      }
      const existing = await workflows.list();
      for (const step of parsed.steps) {
        if (step.workflowRef && !existing.some((w) => w.id === step.workflowRef)) {
          res.status(400).json({ error: `unknown workflowRef: ${step.workflowRef}` });
          return;
        }
        for (const personaId of step.personaIds ?? []) {
          if (!(await personas.get(personaId))) {
            res.status(400).json({ error: `unknown persona in step.personaIds: ${personaId}` });
            return;
          }
        }
      }
      if (wouldCreateCycle(existing, req.params.id, parsed.steps)) {
        res.status(400).json({ error: "step.workflowRef would create a cycle" });
        return;
      }
      updates.steps = parsed.steps;
    }
    const workflow = await workflows.update(req.params.id, updates);
    if (!workflow) {
      res.status(404).json({ error: "workflow not found" });
      return;
    }
    res.status(200).json({ status: "updated", workflow });
  });

  app.delete("/workflows/:id", async (req, res) => {
    // Referential guard, same shape as Persona's — a heartbeat pointing at
    // a deleted workflow would break the runner's fetch.
    const usedByHeartbeats = (await heartbeats.list()).filter(
      (h) => h.workflowId === req.params.id,
    );
    if (usedByHeartbeats.length > 0) {
      res.status(409).json({
        error: "workflow is in use",
        heartbeats: usedByHeartbeats.map((h) => h.name),
      });
      return;
    }
    const deleted = await workflows.delete(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: "workflow not found" });
      return;
    }
    res.status(200).json({ status: "deleted" });
  });

  // ---- Audit ------------------------------------------------------------
  app.get("/audit", async (req, res) => {
    const limit = Number(req.query.limit ?? 100);
    res.status(200).json({ entries: await audit.list(Number.isFinite(limit) ? limit : 100) });
  });

  // ---- Conversations ----------------------------------------------------
  app.get("/conversations", async (_req, res) => {
    const summaries = await conversations.list();
    const enriched = await Promise.all(summaries.map((s) => enrichConversation(s, personas)));
    res.status(200).json({ conversations: enriched });
  });

  app.delete("/conversations/:id", async (req, res) => {
    // Heartbeats bound to a deleted conversation would fire into a 404
    // forever — refuse, same referential posture as persona deletion.
    const bound = (await heartbeats.list()).filter(
      (h) => h.conversationId === req.params.id,
    );
    if (bound.length > 0) {
      res.status(409).json({ error: "conversation has heartbeats", heartbeats: bound.map((h) => h.name) });
      return;
    }
    const deleted = await conversations.delete(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: "conversation not found" });
      return;
    }
    res.status(200).json({ status: "deleted" });
  });

  app.get("/conversations/:id/messages", async (req, res) => {
    const conversation = await conversations.get(req.params.id);
    if (!conversation) {
      res.status(404).json({ error: "conversation not found" });
      return;
    }
    // ?limit — critique #5: the runner polls every conversation every ~5s;
    // without a window this response grows forever.
    const limit = Number(req.query.limit ?? 0);
    const messages =
      Number.isFinite(limit) && limit > 0
        ? conversation.messages.slice(-limit)
        : conversation.messages;
    res.status(200).json({
      ...(await enrichConversation(conversation, personas)),
      totalMessages: conversation.messages.length,
      messages,
    });
  });

  app.post("/conversations/:id/reply", async (req, res) => {
    const { text, model, attachmentIds } = req.body as {
      text?: unknown;
      model?: unknown;
      attachmentIds?: unknown;
    };
    const resolvedAttachments = await resolveAttachments(attachmentIds);
    // Text is required UNLESS at least one attachment resolved — an
    // image/file sent with no caption is still a valid message (Issues.md:
    // "Sending files, images... does not work").
    if ((typeof text !== "string" || text.length === 0) && resolvedAttachments.length === 0) {
      res.status(400).json({ error: "text or an attachment is required" });
      return;
    }
    if (model !== undefined && !VALID_MODEL_IDS.has(model as string)) {
      res.status(400).json({ error: "unknown model" });
      return;
    }
    const message = await conversations.appendMessage(
      req.params.id,
      "Edvard",
      typeof text === "string" ? text : "",
      typeof model === "string" ? model : undefined,
      resolvedAttachments,
    );
    if (!message) {
      res.status(404).json({ error: "conversation not found" });
      return;
    }
    repliesReceived.add(1);
    res.status(200).json({ status: "received", message });
  });

  app.delete("/conversations/:id/messages/:messageId", async (req, res) => {
    const deleted = await conversations.deleteMessage(req.params.id, req.params.messageId);
    if (!deleted) {
      res.status(404).json({ error: "conversation or message not found" });
      return;
    }
    res.status(200).json({ status: "deleted" });
  });

  app.patch("/conversations/:id/messages/:messageId", async (req, res) => {
    const { text } = req.body as { text?: unknown };
    if (typeof text !== "string" || text.length === 0) {
      res.status(400).json({ error: "text is required" });
      return;
    }
    const message = await conversations.editMessage(req.params.id, req.params.messageId, text);
    if (!message) {
      res.status(404).json({ error: "conversation or message not found" });
      return;
    }
    res.status(200).json({ status: "updated", message });
  });

  app.post("/conversations/:id/messages/:messageId/forget", async (req, res) => {
    const { forgotten } = req.body as { forgotten?: unknown };
    const ok = await conversations.setForgotten(
      req.params.id,
      req.params.messageId,
      typeof forgotten === "boolean" ? forgotten : true,
    );
    if (!ok) {
      res.status(404).json({ error: "conversation or message not found" });
      return;
    }
    res.status(200).json({ status: "updated" });
  });

  app.post("/conversations/:id/fork", async (req, res) => {
    const { atMessageId, addPersonaIds } = req.body as {
      atMessageId?: unknown;
      addPersonaIds?: unknown;
    };
    const extraIds = Array.isArray(addPersonaIds)
      ? (addPersonaIds as unknown[]).filter((p): p is string => typeof p === "string")
      : [];
    for (const personaId of extraIds) {
      if (!(await personas.get(personaId))) {
        res.status(400).json({ error: `unknown persona ${personaId}` });
        return;
      }
    }
    const forked = await conversations.fork(
      req.params.id,
      typeof atMessageId === "string" ? atMessageId : undefined,
      extraIds,
    );
    if (!forked) {
      res.status(404).json({ error: "conversation or message not found" });
      return;
    }
    res.status(201).json({ status: "created", conversation: await enrichConversation(forked, personas) });
  });

  // Ask (Decisions/0005): a synchronous side-question with the
  // conversation's context — nothing persisted, tool-less on the runner.
  app.post("/conversations/:id/ask", async (req, res) => {
    const { text } = req.body as { text?: unknown };
    if (typeof text !== "string" || text.length === 0) {
      res.status(400).json({ error: "text is required" });
      return;
    }
    if (!deps.invokeRunner) {
      res.status(503).json({ error: "runner not configured" });
      return;
    }
    const conversation = await conversations.get(req.params.id);
    if (!conversation) {
      res.status(404).json({ error: "conversation not found" });
      return;
    }
    const curator = conversation.personas?.find((p) => p.role === "curator");
    const payload: InvokePayload = curator
      ? { personaId: curator.personaId, messages: toInvokeMessages(conversation, text) }
      : {
          persona: {
            personality: conversation.personality,
            model: conversation.model,
            thinking: conversation.thinking,
          },
          messages: toInvokeMessages(conversation, text),
        };
    try {
      const reply = await deps.invokeRunner(payload);
      res.status(200).json({ reply });
    } catch (err) {
      logger.error({ err }, "ask invoke failed");
      res.status(502).json({ error: "runner invoke failed" });
    }
  });

  return app;
}

/**
 * Internal app (:8081): the agent surface. Guarded by the shared
 * x-agora-token (ADR 0007) when configured — the network boundary keeps it
 * cluster-internal, the token keeps arbitrary in-cluster pods out.
 */
export function createInternalApp(deps: ServerDeps): Express {
  const { config, store, conversations, personas, heartbeats, workflows, audit, webPush, logger } = deps;
  const app = express();
  app.use(express.json());

  const tokenGuard: RequestHandler = (req, res, next) => {
    if (!config.agentToken) {
      next();
      return;
    }
    if (req.header("x-agora-token") !== config.agentToken) {
      res.status(401).json({ error: "invalid agent token" });
      return;
    }
    next();
  };
  app.use(tokenGuard);

  registerCreateConversationRoute(app, deps);
  registerUpdateConversationRoute(app, deps);
  // Runner tools (create_persona/create_heartbeat/create_workflow, gated by
  // the manageAgora persona capability) call these over the internal app —
  // ADR 0007: agent-facing writes live here, not on the public app.
  registerCreatePersonaRoute(app, deps);
  registerCreateHeartbeatRoute(app, deps);
  registerCreateWorkflowRoute(app, deps);

  // Runner-facing reads/writes for capabilities, heartbeats, audit.
  app.get("/personas/:id", async (req, res) => {
    const persona = await personas.get(req.params.id);
    if (!persona) {
      res.status(404).json({ error: "persona not found" });
      return;
    }
    res.status(200).json({ persona });
  });

  // save_memory tool's write-back (Architecture §5).
  app.patch("/personas/:id", async (req, res) => {
    const { sharedMemory } = req.body as { sharedMemory?: unknown };
    if (typeof sharedMemory !== "string") {
      res.status(400).json({ error: "sharedMemory is required" });
      return;
    }
    const persona = await personas.update(req.params.id, { sharedMemory });
    if (!persona) {
      res.status(404).json({ error: "persona not found" });
      return;
    }
    res.status(200).json({ status: "updated", persona });
  });

  // Runner's read path when a due heartbeat has workflowId set — no
  // internal write-back needed, run results still land on
  // Heartbeat.lastRunAt/lastResult via the existing PATCH below.
  app.get("/workflows/:id", async (req, res) => {
    const workflow = await workflows.get(req.params.id);
    if (!workflow) {
      res.status(404).json({ error: "workflow not found" });
      return;
    }
    res.status(200).json({ workflow });
  });

  app.get("/heartbeats", async (_req, res) => {
    res.status(200).json({ heartbeats: await heartbeats.list() });
  });

  app.patch("/heartbeats/:id", async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const updates: HeartbeatUpdate = {};
    if (typeof body.lastRunAt === "string") updates.lastRunAt = body.lastRunAt;
    if (typeof body.lastResult === "string") updates.lastResult = body.lastResult;
    if (typeof body.forceRun === "boolean") updates.forceRun = body.forceRun;
    const heartbeat = await heartbeats.update(req.params.id, updates);
    if (!heartbeat) {
      res.status(404).json({ error: "heartbeat not found" });
      return;
    }
    res.status(200).json({ status: "updated", heartbeat });
  });

  app.post("/audit", async (req, res) => {
    const body = req.body as Record<string, unknown>;
    if (typeof body.capability !== "string" || typeof body.personaName !== "string") {
      res.status(400).json({ error: "personaName and capability are required" });
      return;
    }
    const entry = await audit.append({
      personaName: body.personaName,
      conversationId: typeof body.conversationId === "string" ? body.conversationId : null,
      capability: body.capability,
      detail: typeof body.detail === "string" ? body.detail : "",
      before: typeof body.before === "string" ? body.before : undefined,
      after: typeof body.after === "string" ? body.after : undefined,
    });
    // Inline in-chat activity (2026-07-24): every capability call also
    // shows up right where it happened in the conversation, not just in
    // the standalone Activity tab -- one write path (the runner's existing
    // audit() call) feeds both. appendMessage no-ops (returns null) on an
    // unknown/missing conversationId, same graceful-degrade posture as
    // every other conversationId-scoped call here.
    if (entry.conversationId) {
      await conversations.appendMessage(
        entry.conversationId,
        entry.personaName,
        `${entry.capability}: ${entry.detail}`,
        undefined,
        undefined,
        false,
        { capability: entry.capability, detail: entry.detail, before: entry.before, after: entry.after },
      );
    }
    res.status(201).json({ status: "recorded", entry });
  });

  app.post("/conversations/:id/notify", async (req, res) => {
    const { text, sender, system, push, thinking } = req.body as {
      text?: unknown; sender?: unknown; system?: unknown; push?: unknown; thinking?: unknown;
    };
    if (typeof text !== "string" || text.length === 0) {
      res.status(400).json({ error: "text is required" });
      return;
    }
    const conversation = await conversations.get(req.params.id);
    if (!conversation) {
      res.status(404).json({ error: "conversation not found" });
      return;
    }
    // Multi-persona conversations (Architecture §3): the runner says which
    // persona is speaking; single-persona callers can omit it and get the
    // conversation name, exactly the old behavior.
    const speaker =
      typeof sender === "string" && sender.length > 0 ? sender : conversation.name;
    const message = await conversations.appendMessage(
      conversation.id, speaker, text, undefined, undefined, system === true, undefined, thinking === true,
    );

    // Live streaming (2026-07-24): a single persona turn now lands as
    // several small messages (one per text block, as it's generated)
    // instead of one at the end -- push=false skips the phone notification
    // for every chunk but the last so streaming a turn doesn't spam a
    // notification per sentence. Defaults true so every other caller
    // (heartbeats' one-shot notify, auto_pause, legacy /notify) is unchanged.
    if (push === false) {
      res.status(200).json({ status: "recorded", message });
      return;
    }

    const subscription = await store.load();
    if (!subscription) {
      res.status(404).json({ error: "no subscription registered yet", message });
      return;
    }
    try {
      await webPush.sendNotification(
        subscription,
        JSON.stringify({ title: speaker, body: text, conversationId: conversation.id }),
      );
      notificationsSent.add(1, { persona: speaker });
      res.status(200).json({ status: "sent", message });
    } catch (err) {
      notificationsFailed.add(1, { persona: speaker });
      logger.error({ err }, "push send failed");
      res.status(502).json({ error: "push send failed", message });
    }
  });

  // Legacy global notify — appends into the Main conversation now
  // (ADR 0008); known external callers were deleted in the 2026-07-19
  // cleanup, this exists so nothing that still knows the old URL breaks.
  app.post("/notify", async (req, res) => {
    const { persona, text } = req.body as { persona?: unknown; text?: unknown };
    if (typeof text !== "string" || text.length === 0) {
      res.status(400).json({ error: "text is required" });
      return;
    }
    const title = typeof persona === "string" && persona.length > 0 ? persona : "Agora";
    const main = await resolveMain(deps);
    const message = await conversations.appendMessage(main.id, title, text);

    const subscription = await store.load();
    if (!subscription) {
      res.status(404).json({ error: "no subscription registered yet", message });
      return;
    }
    try {
      await webPush.sendNotification(
        subscription,
        JSON.stringify({ title, body: text, conversationId: main.id }),
      );
      notificationsSent.add(1, { persona: title });
      res.status(200).json({ status: "sent", message });
    } catch (err) {
      notificationsFailed.add(1, { persona: title });
      logger.error({ err }, "push send failed");
      res.status(502).json({ error: "push send failed", message });
    }
  });

  return app;
}
