import { mergeDesktopDefaults, mergeDesktopPatch, type DesktopSettingsPatch } from "../../../gateway/src/desktop-settings.js";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import type { RuntimeLease } from "../runtime/contracts.js";
import { isRuntimePrivatePath, RUNTIME_PRIVATE_DIRECTORY } from '../../runtime/paths.mjs';

export class WorkspaceError extends Error {
  constructor(readonly code: "conflict" | "not_found" | "invalid", message = code) { super(message); }
}
type Json = Record<string, unknown>;
export interface WorkspaceDatabase {
  shared_workspaces: {
    owner_id: string; layout: Json; revision: number; settings: Json;
    runtime_state: string; placement: string; generation: number;
    idle_since: number | null; checkpoint: Json | null;
  };
  shared_files: { owner_id: string; path: string; object_key: string; bytes: number; revision: number; updated_at: string };
  shared_chats: { owner_id: string; id: string; request_id: string; title: string; created_at: string };
  shared_runtime_jobs: {
    owner_id: string; job_id: string; generation: number; state: string;
    expires_at: number; max_run_at: number; payload: Json;
  };
  shared_chat_messages: { owner_id: string; chat_id: string; request_id: string; id: string; seq: number; role: string; text: string; created_at: string };
  shared_runtime_bindings: { runtime_id: string; owner_id: string };
  shared_cleanup_cursors: { job: string; cursor: string | null; lease_id: string | null; lease_until: number };
}
export interface SharedFile { path: string; objectKey: string; bytes: number; revision: number; updatedAt: string }
export interface SharedMessage { id: string; chatId: string; seq: number; role: string; text: string; createdAt: string }
export interface RuntimeOutput { text: string; files: { path: string; objectKey: string; bytes: number; baseRevision: number }[] }
export interface SharedChat { id: string; title: string; createdAt: string; ownerId: string }
export interface WorkspaceBootstrap {
  layout: { windows: unknown[] }; modules: unknown[]; apps: unknown[];
  icons: Record<string, unknown>; revision: number;
}
export interface WorkspaceSettingsSnapshot { settings: Json; revision: number }
export interface ChatAdmissionInput { chatId: string; idempotencyKey: string; message: string }
export interface WorkspaceRepository {
  bootstrap(ownerId: string): Promise<WorkspaceBootstrap>;
  saveLayout(ownerId: string, layout: { windows: unknown[] }, baseRevision: number): Promise<{ revision: number }>;
  settings(ownerId: string): Promise<Json>;
  settingsSnapshot(ownerId: string): Promise<WorkspaceSettingsSnapshot>;
  patchDesktopSettings(ownerId: string, patch: DesktopSettingsPatch): Promise<{ config: Json; revision: number }>;
  saveSetting(ownerId: string, key: string, value: unknown, baseRevision: number): Promise<{ revision: number }>;
  listFiles(ownerId: string, prefix: string, limit: number): Promise<SharedFile[]>;
  file(ownerId: string, path: string): Promise<SharedFile | null>;
  commitFile(ownerId: string, path: string, objectKey: string, bytes: number, baseRevision: number): Promise<SharedFile>;
  listChats(ownerId: string, limit: number): Promise<SharedChat[]>;
  createChat(ownerId: string, requestId: string, title: string): Promise<SharedChat>;
  admitChatMessage(ownerId: string, input: ChatAdmissionInput): Promise<SharedChat>;
  chat(ownerId: string, chatId: string): Promise<SharedChat | null>;
  messages(ownerId: string, chatId: string): Promise<SharedMessage[]>;
  appendMessage(ownerId: string, chatId: string, requestId: string, role: "user" | "assistant", text: string): Promise<void>;
}
const fileRecord = (row: WorkspaceDatabase["shared_files"]): SharedFile => ({ path: row.path, objectKey: row.object_key, bytes: row.bytes, revision: row.revision, updatedAt: row.updated_at });
const chatRecord = (row: WorkspaceDatabase["shared_chats"]): SharedChat => ({ id: row.id, title: row.title, createdAt: row.created_at, ownerId: row.owner_id });

/** Pair immutable bytes with their current metadata revision despite concurrent replacements. */
export async function readSharedFileSnapshot(repository: Pick<WorkspaceRepository, "file">,
  read: (key: string) => Promise<string | null>, ownerId: string, initial: SharedFile,
): Promise<{ file: SharedFile; content: string }> {
  let file = initial;
  for (let attempt = 0; attempt < 3; attempt++) {
    const content = await read(file.objectKey);
    const latest = await repository.file(ownerId, file.path);
    if (!latest) throw new WorkspaceError("not_found");
    if (content !== null && latest.objectKey === file.objectKey && latest.revision === file.revision) return { file, content };
    file = latest;
  }
  throw new WorkspaceError("conflict");
}

export async function ensureWorkspace(db: Kysely<WorkspaceDatabase>, ownerId: string): Promise<void> {
  await db.insertInto("shared_workspaces").values({
    owner_id: ownerId, layout: { windows: [] }, revision: 0, settings: {},
    runtime_state: "sleeping", placement: "pooled", generation: 1, idle_since: null, checkpoint: null,
  }).onConflict((oc) => oc.column("owner_id").doNothing()).execute();
}

/** Caller-owned admission transaction: Chat input, budget and outbox commit together. */
export async function admitWorkspaceChatMessage(trx: Kysely<WorkspaceDatabase>, ownerId: string, input: ChatAdmissionInput): Promise<SharedChat> {
  if (!input.message.trim() || input.message.length > 16_000 || new TextEncoder().encode(input.message).byteLength > 64_000) throw new WorkspaceError("invalid");
  await ensureWorkspace(trx, ownerId);
  await trx.selectFrom("shared_workspaces").select("owner_id").where("owner_id", "=", ownerId).forUpdate().executeTakeFirstOrThrow();
  const admitted = await trx.selectFrom("shared_chat_messages").selectAll().where("owner_id", "=", ownerId)
    .where("request_id", "=", input.idempotencyKey).where("role", "=", "user").limit(2).execute();
  if (admitted.length) {
    if (admitted.length !== 1 || admitted[0].text !== input.message) throw new WorkspaceError("conflict");
    const chat = await trx.selectFrom("shared_chats").selectAll().where("owner_id", "=", ownerId).where("id", "=", admitted[0].chat_id).executeTakeFirst();
    if (!chat) throw new WorkspaceError("not_found");
    return chatRecord(chat);
  }
  const existing = await trx.selectFrom("shared_chats").selectAll().where("owner_id", "=", ownerId).where("id", "=", input.chatId).executeTakeFirst();
  const chat = existing ? chatRecord(existing) : await new PostgresWorkspaceRepository(trx, false).upsertChat(trx, ownerId, input.idempotencyKey, input.message.slice(0, 100));
  await trx.selectFrom("shared_chats").select("id").where("owner_id", "=", ownerId).where("id", "=", chat.id).forUpdate().executeTakeFirstOrThrow();
  await new PostgresWorkspaceRepository(trx, false).insertMessage(trx, ownerId, chat.id, input.idempotencyKey, "user", input.message);
  return chat;
}

export class PostgresWorkspaceRepository implements WorkspaceRepository {
  constructor(readonly db: Kysely<WorkspaceDatabase>, private readonly ownsDb = true) {}
  async initialize(): Promise<void> {
    await this.db.schema.createTable("shared_workspaces").ifNotExists()
      .addColumn("owner_id", "text", (c) => c.primaryKey())
      .addColumn("layout", "jsonb", (c) => c.notNull())
      .addColumn("revision", "integer", (c) => c.notNull())
      .addColumn("settings", "jsonb", (c) => c.notNull())
      .addColumn("runtime_state", "text", (c) => c.notNull())
      .addColumn("placement", "text", (c) => c.notNull())
      .addColumn("generation", "integer", (c) => c.notNull())
      .addColumn("idle_since", "double precision")
      .addColumn("checkpoint", "jsonb").execute();
    await this.db.schema.createTable("shared_files").ifNotExists()
      .addColumn("owner_id", "text", (c) => c.notNull())
      .addColumn("path", "text", (c) => c.notNull())
      .addColumn("object_key", "text", (c) => c.notNull())
      .addColumn("bytes", "integer", (c) => c.notNull())
      .addColumn("revision", "integer", (c) => c.notNull())
      .addColumn("updated_at", "text", (c) => c.notNull())
      .addPrimaryKeyConstraint("shared_files_owner_path", ["owner_id", "path"]).execute();
    await this.db.schema.createTable("shared_chats").ifNotExists()
      .addColumn("owner_id", "text", (c) => c.notNull())
      .addColumn("id", "text", (c) => c.notNull())
      .addColumn("request_id", "text", (c) => c.notNull())
      .addColumn("title", "text", (c) => c.notNull())
      .addColumn("created_at", "text", (c) => c.notNull())
      .addPrimaryKeyConstraint("shared_chats_owner_id", ["owner_id", "id"])
      .addUniqueConstraint("shared_chats_request", ["owner_id", "request_id"]).execute();
    await this.db.schema.createTable("shared_chat_messages").ifNotExists()
      .addColumn("owner_id", "text", (c) => c.notNull()).addColumn("chat_id", "text", (c) => c.notNull())
      .addColumn("request_id", "text", (c) => c.notNull()).addColumn("id", "text", (c) => c.notNull())
      .addColumn("seq", "integer", (c) => c.notNull()).addColumn("role", "text", (c) => c.notNull())
      .addColumn("text", "text", (c) => c.notNull()).addColumn("created_at", "text", (c) => c.notNull())
      .addPrimaryKeyConstraint("shared_messages_owner_request", ["owner_id", "chat_id", "request_id"])
      .addUniqueConstraint("shared_messages_seq", ["owner_id", "chat_id", "seq"]).execute();
    await this.db.schema.createTable("shared_cleanup_cursors").ifNotExists()
      .addColumn("job", "text", (c) => c.primaryKey()).addColumn("cursor", "text")
      .addColumn("lease_id", "text").addColumn("lease_until", "double precision", (c) => c.notNull()).execute();
  }
  async bootstrap(ownerId: string): Promise<WorkspaceBootstrap> {
    // Reads return a default without creating a runtime or mutating durable data.
    const row = await this.db.selectFrom("shared_workspaces").selectAll().where("owner_id", "=", ownerId).executeTakeFirst();
    return { layout: (row?.layout ?? { windows: [] }) as { windows: unknown[] }, modules: [], apps: [], icons: {}, revision: row?.revision ?? 0 };
  }
  async saveLayout(ownerId: string, layout: { windows: unknown[] }, baseRevision: number) {
    return this.db.transaction().execute(async (trx) => {
      await ensureWorkspace(trx, ownerId);
      const updated = await trx.updateTable("shared_workspaces").set({ layout, revision: sql`revision + 1` })
        .where("owner_id", "=", ownerId).where("revision", "=", baseRevision).returning("revision").executeTakeFirst();
      if (!updated) throw new WorkspaceError("conflict");
      return updated;
    });
  }
  async settings(ownerId: string): Promise<Json> {
    return (await this.db.selectFrom("shared_workspaces").select("settings").where("owner_id", "=", ownerId).executeTakeFirst())?.settings ?? {};
  }
  async settingsSnapshot(ownerId: string): Promise<WorkspaceSettingsSnapshot> {
    const row = await this.db.selectFrom("shared_workspaces").select(["settings", "revision"]).where("owner_id", "=", ownerId).executeTakeFirst();
    return row ?? { settings: {}, revision: 0 };
  }
  async patchDesktopSettings(ownerId: string, patch: DesktopSettingsPatch): Promise<{ config: Json; revision: number }> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.db.transaction().execute(async (trx) => {
      await ensureWorkspace(trx, ownerId);
      const snapshot = await trx.selectFrom("shared_workspaces").select(["settings", "revision"]).where("owner_id", "=", ownerId).forUpdate().executeTakeFirstOrThrow();
      const stored = snapshot.settings.desktop;
      const current = stored !== null && typeof stored === "object" && !Array.isArray(stored) ? stored as Json : {};
      const next = mergeDesktopPatch(current, patch);
      const updated = await trx.updateTable("shared_workspaces").set({
        settings: sql`jsonb_set(settings, '{desktop}', ${JSON.stringify(next)}::jsonb, true)`, revision: sql`revision + 1`,
      }).where("owner_id", "=", ownerId).where("revision", "=", snapshot.revision).returning("revision").executeTakeFirst();
      if (!updated) throw new WorkspaceError("conflict");
      return { config: mergeDesktopDefaults(next), revision: updated.revision };
        });
      } catch (error) {
        if (!(error instanceof WorkspaceError) || error.code !== "conflict" || attempt === 2) throw error;
      }
    }
    throw new WorkspaceError("conflict");
  }
  async saveSetting(ownerId: string, key: string, value: unknown, baseRevision: number) {
    return this.db.transaction().execute(async (trx) => {
      await ensureWorkspace(trx, ownerId);
      const updated = await trx.updateTable("shared_workspaces").set({
        settings: sql`jsonb_set(settings, ARRAY[${key}]::text[], ${JSON.stringify(value)}::jsonb, true)`, revision: sql`revision + 1`,
      }).where("owner_id", "=", ownerId).where("revision", "=", baseRevision).returning("revision").executeTakeFirst();
      if (!updated) throw new WorkspaceError("conflict");
      return updated;
    });
  }
  async listFiles(ownerId: string, prefix: string, limit: number) {
    const query = this.db.selectFrom("shared_files").selectAll().where("owner_id", "=", ownerId)
      .where('path','!=',RUNTIME_PRIVATE_DIRECTORY).where('path','not like',`${RUNTIME_PRIVATE_DIRECTORY}/%`);
    const rows = await (prefix ? query.where("path", "like", `${prefix.replace(/[\\%_]/g, "\\$&")}%`) : query).orderBy("path").limit(limit).execute();
    return rows.map(fileRecord);
  }
  async file(ownerId: string, path: string) {
    if (isRuntimePrivatePath(path)) return null;
    const row = await this.db.selectFrom("shared_files").selectAll().where("owner_id", "=", ownerId).where("path", "=", path).executeTakeFirst();
    return row ? fileRecord(row) : null;
  }
  async commitFile(ownerId: string, path: string, objectKey: string, bytes: number, baseRevision: number) {
    if (isRuntimePrivatePath(path)) throw new WorkspaceError('invalid');
    const values = { owner_id: ownerId, path, object_key: objectKey, bytes, revision: 1, updated_at: new Date().toISOString() };
    const row = baseRevision === 0
      ? await this.db.insertInto("shared_files").values(values).onConflict((oc) => oc.columns(["owner_id", "path"]).doNothing()).returningAll().executeTakeFirst()
      : await this.db.updateTable("shared_files").set({ object_key: objectKey, bytes, revision: sql`revision + 1`, updated_at: values.updated_at })
        .where("owner_id", "=", ownerId).where("path", "=", path).where("revision", "=", baseRevision).returningAll().executeTakeFirst();
    if (!row) throw new WorkspaceError("conflict");
    return fileRecord(row);
  }
  async listChats(ownerId: string, limit: number) {
    return (await this.db.selectFrom("shared_chats").selectAll().where("owner_id", "=", ownerId).orderBy("created_at", "desc").limit(limit).execute()).map(chatRecord);
  }
  async createChat(ownerId: string, requestId: string, title: string) {
    return this.db.transaction().execute(trx => this.upsertChat(trx, ownerId, requestId, title));
  }
  async upsertChat(trx: Kysely<WorkspaceDatabase>, ownerId: string, requestId: string, title: string): Promise<SharedChat> {
    await trx.insertInto("shared_chats").values({ owner_id: ownerId, id: `chat_${crypto.randomUUID().replaceAll("-", "")}`, request_id: requestId, title, created_at: new Date().toISOString() })
      .onConflict((oc) => oc.columns(["owner_id", "request_id"]).doNothing()).execute();
    const row = await trx.selectFrom("shared_chats").selectAll().where("owner_id", "=", ownerId).where("request_id", "=", requestId).executeTakeFirstOrThrow();
    return chatRecord(row);
  }
  /** A durable input and its Chat are one admission; Queue delivery happens after commit. */
  async admitChatMessage(ownerId: string, input: ChatAdmissionInput): Promise<SharedChat> {
    return this.db.transaction().execute(trx => admitWorkspaceChatMessage(trx, ownerId, input));
  }

  async chat(ownerId: string, chatId: string) {
    const row = await this.db.selectFrom("shared_chats").selectAll().where("owner_id", "=", ownerId).where("id", "=", chatId).executeTakeFirst();
    return row ? chatRecord(row) : null;
  }
  async messages(ownerId: string, chatId: string): Promise<SharedMessage[]> {
    const rows = await this.db.selectFrom("shared_chat_messages").selectAll().where("owner_id", "=", ownerId).where("chat_id", "=", chatId).orderBy("seq", "desc").limit(200).execute();
    return rows.reverse().map((row) => ({ id: row.id, chatId: row.chat_id, seq: row.seq, role: row.role, text: row.text, createdAt: row.created_at }));
  }
  async appendMessage(ownerId: string, chatId: string, requestId: string, role: "user" | "assistant", text: string) {
    if (text.length > 32000 || new TextEncoder().encode(text).byteLength > 96000) throw new WorkspaceError("invalid");
    await this.db.transaction().execute(async (trx) => {
      const chat = await trx.selectFrom("shared_chats").select("id").where("owner_id", "=", ownerId).where("id", "=", chatId).forUpdate().executeTakeFirst();
      if (!chat) throw new WorkspaceError("not_found");
      const existing = await trx.selectFrom("shared_chat_messages").selectAll().where("owner_id", "=", ownerId).where("chat_id", "=", chatId).where("request_id", "=", requestId).executeTakeFirst();
      if (existing && (existing.text !== text || existing.role !== role)) throw new WorkspaceError("conflict");
      await this.insertMessage(trx, ownerId, chatId, requestId, role, text);
    });
  }
  async insertMessage(trx: Kysely<WorkspaceDatabase>, ownerId: string, chatId: string, requestId: string, role: "user" | "assistant", text: string) {
    const latest = await trx.selectFrom("shared_chat_messages").select("seq").where("owner_id", "=", ownerId).where("chat_id", "=", chatId).orderBy("seq", "desc").limit(1).executeTakeFirst();
    await trx.insertInto("shared_chat_messages").values({ owner_id: ownerId, chat_id: chatId, request_id: requestId,
      id: `msg_${crypto.randomUUID().replaceAll("-", "")}`, seq: (latest?.seq ?? 0) + 1, role, text, created_at: new Date().toISOString(),
    }).onConflict((oc) => oc.columns(["owner_id", "chat_id", "request_id"]).doNothing()).execute();
  }
  /** R2 writes happen first. Publication atomically checks the live lease and file revisions. */
  async publishOutput(lease: RuntimeLease, output: RuntimeOutput, now = Date.now()): Promise<boolean> {
    if (output.text.length > 32000 || output.files.length > 20 || new TextEncoder().encode(output.text).byteLength > 96000) throw new WorkspaceError("invalid");
    return this.db.transaction().execute(async (trx) => {
      const workspace = await trx.selectFrom("shared_workspaces").selectAll().where("owner_id", "=", lease.ownerId).forUpdate().executeTakeFirst();
      const job = await trx.selectFrom("shared_runtime_jobs").selectAll().where("owner_id", "=", lease.ownerId).where("job_id", "=", lease.jobId)
        .where("generation", "=", lease.generation).where("state", "=", "running").where("expires_at", ">", now).where("max_run_at", ">", now).executeTakeFirst();
      if (!workspace || workspace.generation !== lease.generation || !job) throw new WorkspaceError("conflict");
      const chatId = typeof job.payload.chatId === "string" ? job.payload.chatId : null;
      if (!chatId) return false;
      const chat = await trx.selectFrom("shared_chats").select("id").where("owner_id", "=", lease.ownerId).where("id", "=", chatId).forUpdate().executeTakeFirst();
      if (!chat) throw new WorkspaceError("not_found");
      const exists = await trx.selectFrom("shared_chat_messages").select("id").where("owner_id", "=", lease.ownerId).where("chat_id", "=", chatId).where("request_id", "=", `output_${lease.jobId}`).executeTakeFirst();
      if (exists) return false;
      const scoped = new PostgresWorkspaceRepository(trx, false);
      for (const file of output.files) await scoped.commitFile(lease.ownerId, file.path, file.objectKey, file.bytes, file.baseRevision);
      await this.insertMessage(trx, lease.ownerId, chatId, `output_${lease.jobId}`, "assistant", output.text);
      return true;
    });
  }
  /** System-only bounded query for the scheduled orphan collector. */
  async referencedObjectKeysForCleanup(keys: string[]): Promise<string[]> {
    if (keys.length > 100) throw new WorkspaceError("invalid");
    if (!keys.length) return [];
    return (await this.db.selectFrom("shared_files").select("object_key").where("object_key", "in", keys).limit(100).execute()).map((row) => row.object_key);
  }
  async close() { if (this.ownsDb) await this.db.destroy(); }
}
export function createPostgresWorkspaceRepository(connectionString: string): PostgresWorkspaceRepository {
  const pool = new Pool({ connectionString, max: 3, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 10_000, statement_timeout: 10_000, query_timeout: 12_000 });
  return new PostgresWorkspaceRepository(new Kysely<WorkspaceDatabase>({ dialect: new PostgresDialect({ pool }) }));
}
