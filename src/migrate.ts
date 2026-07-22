import type pino from "pino";
import type { ConversationStore } from "./chat/conversation-store.js";
import type { MessageStore } from "./chat/message-store.js";
import type { PersonaStore } from "./chat/persona-store.js";
import { DEFAULT_MODEL } from "./chat/conversation-store.js";

/** The former hardcoded frontend template constants, now seeded once as
 * editable Persona records (critique finding #10 — Edvard asked for
 * editable templates; code constants can't be edited from a Studio). */
const SEED_TEMPLATES = [
  {
    name: "Trainer",
    personality:
      "You are a supportive but honest fitness/training coach. Be direct about what's working and what isn't, celebrate real progress, and never sugarcoat a missed session.",
  },
  {
    name: "Study buddy",
    personality:
      "You are a patient study partner. Ask questions that check real understanding rather than just confirming what was said, and suggest what to review next.",
  },
  {
    name: "Devil's advocate",
    personality:
      "You push back on every claim with the strongest reasonable counterargument, even ones you don't fully believe, to stress-test thinking before a decision is made.",
  },
  {
    name: "Plain assistant",
    personality:
      "You are a helpful, concise assistant. Answer directly, ask for clarification only when genuinely needed.",
  },
];

export interface MigrationDeps {
  conversations: ConversationStore;
  personas: PersonaStore;
  messages: MessageStore;
  logger: pino.Logger;
}

/**
 * One-time, idempotent, runs at startup before listen (critique finding
 * #7 — an explicit migration, never record creation as a side effect of
 * reads). Three steps, each independently guarded:
 *
 * 1. Seed template personas if none exist yet.
 * 2. Extract a Persona from every conversation still carrying only inline
 *    personality/model/thinking, link it as curator.
 * 3. Import the legacy Main thread into a real conversation (ADR 0008),
 *    paused so it doesn't start replying to months of history unasked.
 */
export async function runStartupMigration({
  conversations,
  personas,
  messages,
  logger,
}: MigrationDeps): Promise<void> {
  // 1. Templates
  const existing = await personas.list();
  if (!existing.some((p) => p.isTemplate)) {
    for (const template of SEED_TEMPLATES) {
      await personas.create({
        name: template.name,
        personality: template.personality,
        model: DEFAULT_MODEL,
        isTemplate: true,
      });
    }
    logger.info({ count: SEED_TEMPLATES.length }, "seeded template personas");
  }

  // 2. Inline persona fields → Persona records
  for (const summary of await conversations.list()) {
    if (summary.personas) continue;
    const conversation = await conversations.get(summary.id);
    if (!conversation || conversation.personas) continue;
    const all = await personas.list();
    let persona = all.find((p) => !p.isTemplate && p.name === conversation.name) ?? null;
    if (!persona) {
      persona = await personas.create({
        name: conversation.name,
        personality: conversation.personality,
        model: conversation.model,
        thinking: conversation.thinking,
      });
    }
    await conversations.update(conversation.id, {
      personas: [{ personaId: persona.id, role: "curator" }],
    });
    logger.info(
      { conversation: conversation.name, personaId: persona.id },
      "migrated conversation to persona link",
    );
  }

  // 3. Legacy Main thread (ADR 0008)
  const legacy = await messages.list();
  if (legacy.length > 0 && !(await conversations.findByName("Main"))) {
    const all = await personas.list();
    let persona = all.find((p) => !p.isTemplate && p.name === "Agora") ?? null;
    persona ??= await personas.create({
      name: "Agora",
      personality: "You are Agora, Edvard's own assistant inside his self-hosted chat platform.",
      model: DEFAULT_MODEL,
    });
    const main = await conversations.create("Main", "", persona.model, persona.thinking, [
      { personaId: persona.id, role: "curator" },
    ]);
    // Paused: the imported history never had a persona watching it — it
    // must not suddenly get a reply the moment this deploy lands. Edvard
    // resumes it explicitly if he wants Main live (ADR 0008).
    await conversations.update(main.id, { status: "paused" });
    await conversations.importMessages(main.id, legacy);
    logger.info({ imported: legacy.length }, "migrated legacy Main thread (paused)");
  }
}
