import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { z } from "zod/v4";
import type { ChatDatabase } from "./database.js";
import type { ChatOwner } from "./records.js";
import { redactAssistantParts, redactSharedAssistantText } from "./safe-activity-projection.js";
import { hasCompanyDriveMaterial } from "./drive-sharing-guard.js";

export { ShareSnapshotSchema, ShareTokenSchema } from "@matrix-os/contracts";
import { ShareSnapshotSchema, ShareTokenSchema, type ShareSnapshot } from "@matrix-os/contracts";
const MAX_SNAPSHOT_BYTES = 256 * 1024;
const MAX_SHARES_PER_CHAT = 10;
const SHARE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export class ChatSharingError extends Error {
  constructor(readonly code: "not_found" | "conflict" | "limit") { super(code); }
}

export async function bootstrapChatSharing(db: Kysely<ChatDatabase>) {
  await sql`CREATE TABLE IF NOT EXISTS chat_shares (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    snapshot JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
  )`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS chat_shares_chat ON chat_shares(chat_id)`.execute(db);
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}


async function readSnapshot(trx: Kysely<ChatDatabase>, chatId: string, title: string) {
  // Callers hold the Chat lock also used by admission and sharing transitions.
  if (await hasCompanyDriveMaterial(trx, chatId)) throw new ChatSharingError("conflict");
  const rows = await trx.selectFrom("chat_messages").select(["role", "parts"])
    .where("chat_id", "=", chatId).where("state", "=", "committed").where("role", "in", ["user", "assistant"])
    .orderBy("seq").limit(201).execute();
  if (rows.length > 200) throw new ChatSharingError("limit");
  const messages = rows.flatMap((row) => {
    const parts = z.array(z.unknown()).max(200).parse(row.parts);
    const textParts = parts.flatMap((part) => {
      const parsed = z.object({ type: z.literal("text"), text: z.string() }).safeParse(part);
      return parsed.success ? [parsed.data] : [];
    });
    const safeParts = row.role === "assistant" ? redactAssistantParts(textParts) : textParts;
    const text = safeParts.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
    return text ? [{ role: row.role, text }] : [];
  });
  const snapshot = ShareSnapshotSchema.parse({ title, messages });
  if (!snapshot.messages.length || Buffer.byteLength(JSON.stringify(snapshot)) > MAX_SNAPSHOT_BYTES) throw new ChatSharingError("limit");
  return snapshot;
}

export class ChatSharing {
  // The gateway owns this shared pool and closes it after its routes drain.
  constructor(private readonly db: Kysely<ChatDatabase>) {}

  async create(owner: ChatOwner, chatId: string, revision: number, fingerprint?: string) {
    return this.db.transaction().execute(async (trx) => {
      await sql`SET LOCAL statement_timeout = '5s'`.execute(trx);
      await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
      const chat = await trx.selectFrom("chats").selectAll().where("id", "=", chatId)
        .where("owner_type", "=", owner.type).where("owner_id", "=", owner.ownerId).forUpdate().executeTakeFirst();
      if (!chat) throw new ChatSharingError("not_found");
      if (Number(chat.revision) !== revision) throw new ChatSharingError("conflict");
      await trx.deleteFrom("chat_shares").where("chat_id", "=", chatId).where("expires_at", "<=", new Date()).execute();
      const existing = await trx.selectFrom("chat_shares").select("id").where("chat_id", "=", chatId).limit(MAX_SHARES_PER_CHAT).execute();
      if (existing.length >= MAX_SHARES_PER_CHAT) throw new ChatSharingError("limit");
      const snapshot = await readSnapshot(trx, chatId, chat.title);
      if (fingerprint && tokenHash(JSON.stringify(snapshot)) !== fingerprint) throw new ChatSharingError("conflict");
      const id = randomUUID();
      const token = randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + SHARE_LIFETIME_MS);
      await trx.insertInto("chat_shares").values({ id, chat_id: chatId, token_hash: tokenHash(token), snapshot: JSON.stringify(snapshot), expires_at: expiresAt }).execute();
      return { id, token, expiresAt: expiresAt.toISOString(), snapshot };
    });
  }

  async preview(owner: ChatOwner, chatId: string) {
    return this.db.transaction().execute(async (trx) => {
      await sql`SET LOCAL statement_timeout = '5s'`.execute(trx);
      await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
      const chat = await trx.selectFrom("chats").select(["title", "revision"])
        .where("id", "=", chatId).where("owner_type", "=", owner.type).where("owner_id", "=", owner.ownerId)
        .forShare().executeTakeFirst();
      if (!chat) throw new ChatSharingError("not_found");
      const snapshot = await readSnapshot(trx, chatId, chat.title);
      return { ...snapshot, revision: Number(chat.revision), fingerprint: tokenHash(JSON.stringify(snapshot)) };
    });
  }

  async list(owner: ChatOwner, chatId: string) {
    return this.db.selectFrom("chat_shares").innerJoin("chats", "chats.id", "chat_shares.chat_id")
      .select(["chat_shares.id", "chat_shares.created_at as createdAt", "chat_shares.expires_at as expiresAt"])
      .where("chats.id", "=", chatId).where("owner_type", "=", owner.type).where("owner_id", "=", owner.ownerId)
      .where("chat_shares.expires_at", ">", new Date()).limit(MAX_SHARES_PER_CHAT).execute();
  }

  async revoke(owner: ChatOwner, chatId: string, id: string) {
    await this.db.deleteFrom("chat_shares").where("id", "=", id).where("chat_id", "=", chatId)
      .where("chat_id", "in", this.db.selectFrom("chats").select("id").where("owner_type", "=", owner.type).where("owner_id", "=", owner.ownerId))
      .execute();
  }

  async read(token: string): Promise<ShareSnapshot | null> {
    if (!ShareTokenSchema.safeParse(token).success) return null;
    return this.db.transaction().execute(async (trx) => {
      await sql`SET LOCAL statement_timeout = '5s'`.execute(trx);
      await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
      const row = await trx.selectFrom("chat_shares").innerJoin("chats", "chats.id", "chat_shares.chat_id")
        .select(["chat_shares.snapshot", "chat_shares.chat_id"])
        .where("token_hash", "=", tokenHash(token)).where("expires_at", ">", new Date())
        .forShare("chats").executeTakeFirst();
      // Old immutable snapshots also fail closed once their source becomes drive-backed.
      if (!row || await hasCompanyDriveMaterial(trx, row.chat_id)) return null;
      const snapshot = ShareSnapshotSchema.parse(row.snapshot);
      return { ...snapshot, messages: snapshot.messages.map((message) => message.role === "assistant"
        ? { ...message, text: redactSharedAssistantText(message.text) }
        : message) };
    });
  }
}
