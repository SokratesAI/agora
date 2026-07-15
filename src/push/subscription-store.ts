import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

/**
 * Single-subscription store — Agora's PoC has exactly one operator (Edvard,
 * one phone), so there is exactly one subscription. Deliberately simpler
 * than WhatsApp Bridge's hardened auth-state persistence: a push
 * subscription is an opaque, non-secret endpoint URL + public keys, not a
 * credential, so atomic write is proportionate; the symlink-rejection /
 * backup-file machinery that threat model needed doesn't apply here.
 */
export class SubscriptionStore {
  private readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "subscription.json");
  }

  async load(): Promise<PushSubscriptionRecord | null> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return JSON.parse(raw) as PushSubscriptionRecord;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async save(subscription: PushSubscriptionRecord): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${randomUUID()}.tmp`;
    const handle = await fs.open(tmpPath, "w", 0o600);
    try {
      await handle.writeFile(JSON.stringify(subscription, null, 2));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmpPath, this.filePath);
  }
}
