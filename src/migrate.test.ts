import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import pino from "pino";
import { ConversationStore } from "./chat/conversation-store.js";
import { MessageStore } from "./chat/message-store.js";
import { PersonaStore } from "./chat/persona-store.js";
import { runStartupMigration } from "./migrate.js";

describe("runStartupMigration", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  async function makeStores() {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agora-migrate-test-"));
    return {
      conversations: new ConversationStore(dir),
      messages: new MessageStore(dir),
      personas: new PersonaStore(dir),
      logger: pino({ enabled: false }),
    };
  }

  it("seeds template personas exactly once", async () => {
    const deps = await makeStores();
    await runStartupMigration(deps);
    const templates = (await deps.personas.list()).filter((p) => p.isTemplate);
    expect(templates.length).toBe(4);
    await runStartupMigration(deps);
    expect((await deps.personas.list()).filter((p) => p.isTemplate).length).toBe(4);
  });

  it("extracts a curator persona from inline conversation fields, idempotently", async () => {
    const deps = await makeStores();
    const conversation = await deps.conversations.create(
      "Marcus",
      "stern trainer",
      "anthropic:claude-sonnet-5",
      true,
    );
    await runStartupMigration(deps);

    const migrated = await deps.conversations.get(conversation.id);
    expect(migrated?.personas).toHaveLength(1);
    expect(migrated?.personas?.[0].role).toBe("curator");

    const persona = await deps.personas.get(migrated!.personas![0].personaId);
    expect(persona?.name).toBe("Marcus");
    expect(persona?.personality).toBe("stern trainer");
    expect(persona?.model).toBe("anthropic:claude-sonnet-5");
    expect(persona?.thinking).toBe(true);
    expect(persona?.isTemplate).toBe(false);

    // Second run must not create a duplicate persona or relink.
    await runStartupMigration(deps);
    const marcuses = (await deps.personas.list()).filter((p) => p.name === "Marcus");
    expect(marcuses).toHaveLength(1);
  });

  it("imports the legacy Main thread as a paused conversation", async () => {
    const deps = await makeStores();
    await deps.messages.append("Edvard", "hello from history");
    await deps.messages.append("Claude", "historic reply");
    await runStartupMigration(deps);

    const main = await deps.conversations.findByName("Main");
    expect(main).not.toBeNull();
    expect(main?.status).toBe("paused");
    expect(main?.messages.map((m) => m.text)).toEqual(["hello from history", "historic reply"]);
    expect(main?.personas?.[0].role).toBe("curator");

    // Idempotent — a restart must not import twice.
    await runStartupMigration(deps);
    const again = await deps.conversations.findByName("Main");
    expect(again?.messages).toHaveLength(2);
  });

  it("does not create Main when there is no legacy history", async () => {
    const deps = await makeStores();
    await runStartupMigration(deps);
    expect(await deps.conversations.findByName("Main")).toBeNull();
  });
});
