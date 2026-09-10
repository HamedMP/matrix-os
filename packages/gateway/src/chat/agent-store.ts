import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, opendir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sql, type Kysely } from "kysely";
import { z } from "zod/v4";
import {
  CanonicalOwnerScopeSchema, ChatAgentIdSchema, ChatAgentSchema,
  CreateChatAgentRequestSchema, UpdateChatAgentRequestSchema,
  type ChatAgent, type CreateChatAgentRequest, type UpdateChatAgentRequest,
} from "@matrix-os/contracts";
import { resolveWithinHome } from "../path-security.js";
import type { ChatDatabase } from "./database.js";
import type { ChatOwner } from "./records.js";

const MAX_AGENTS = 100;
const MAX_FILE_BYTES = 40 * 1024;
const TEMP_TTL_MS = 15 * 60_000;
const AgentMetadataSchema = ChatAgentSchema.omit({ instructions: true }).extend({
  createHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
type StoredAgent = { agent: ChatAgent; createHash: string };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export class ChatAgentStoreError extends Error {
  constructor(readonly code: "agent_not_found" | "agent_conflict" | "agent_capacity" | "agent_unavailable") {
    super(code);
    this.name = "ChatAgentStoreError";
  }
}

/** Files own role definitions; Postgres only serializes writes across gateway processes. */
export class ChatAgentStore {
  private sweepTimer?: ReturnType<typeof setInterval>;
  private sweep: Promise<void> | null = null;
  constructor(private readonly options: { homePath: string; db: Kysely<ChatDatabase>; now?: () => Date }) {}

  async bootstrap(): Promise<void> {
    await sql`CREATE TABLE IF NOT EXISTS chat_agent_owner_locks (owner_key TEXT PRIMARY KEY)`.execute(this.options.db);
    await this.sweepTemporaryFiles();
    this.sweepTimer ??= setInterval(() => {
      if (this.sweep) return;
      this.sweep = this.sweepTemporaryFiles().catch((error: unknown) => {
        console.warn("[chat-agents] Temporary file cleanup failed:", error instanceof Error ? error.name : "UnknownError");
      }).finally(() => { this.sweep = null; });
    }, 5 * 60_000);
    this.sweepTimer.unref();
  }

  async close(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    await this.sweep;
  }

  private ownerKey(owner: ChatOwner): string {
    const parsed = CanonicalOwnerScopeSchema.parse(owner);
    if (parsed.type !== "personal") throw new ChatAgentStoreError("agent_unavailable");
    return digest(`${parsed.type}:${parsed.ownerId}`);
  }

  private async directory(segments: string[], create = false): Promise<string | null> {
    let current = this.options.homePath;
    for (const segment of ["agents", "custom", "chat-bots", ...segments]) {
      const target = resolveWithinHome(this.options.homePath, join(current, segment));
      if (!target) throw new ChatAgentStoreError("agent_unavailable");
      current = target;
      if (create) await mkdir(current, { recursive: true });
      let info;
      try { info = await lstat(current); } catch (error: unknown) {
        if (isCode(error, "ENOENT")) return null;
        throw error;
      }
      if (!info.isDirectory() || info.isSymbolicLink()) throw new ChatAgentStoreError("agent_unavailable");
    }
    return current;
  }

  private async withOwnerLock<T>(owner: ChatOwner, action: () => Promise<T>): Promise<T> {
    const key = this.ownerKey(owner);
    return this.options.db.transaction().execute(async (trx) => {
      await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
      await sql`INSERT INTO chat_agent_owner_locks (owner_key) VALUES (${key}) ON CONFLICT DO NOTHING`.execute(trx);
      await sql`SELECT owner_key FROM chat_agent_owner_locks WHERE owner_key = ${key} FOR UPDATE`.execute(trx);
      return action();
    });
  }

  private async read(path: string): Promise<StoredAgent | null> {
    let file;
    try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch (error: unknown) {
      if (isCode(error, "ENOENT")) return null;
      if (isCode(error, "ELOOP")) throw new ChatAgentStoreError("agent_unavailable");
      throw error;
    }
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new ChatAgentStoreError("agent_unavailable");
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_FILE_BYTES) throw new ChatAgentStoreError("agent_unavailable");
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      const match = /^---\n([^\n]+)\n---\n([\s\S]*)$/.exec(text);
      if (!match) throw new ChatAgentStoreError("agent_unavailable");
      const metadata = AgentMetadataSchema.parse(JSON.parse(match[1]!));
      const { createHash, ...fields } = metadata;
      const instructions = match[2]!.endsWith("\n") ? match[2]!.slice(0, -1) : match[2]!;
      return { agent: ChatAgentSchema.parse({ ...fields, instructions }), createHash };
    } catch (error: unknown) {
      if (error instanceof SyntaxError || error instanceof z.ZodError) throw new ChatAgentStoreError("agent_unavailable");
      throw error;
    } finally { await file.close(); }
  }

  private async write(directory: string, value: StoredAgent, exclusive: boolean): Promise<void> {
    const { instructions, ...metadata } = value.agent;
    const text = `---\n${JSON.stringify({ ...metadata, createHash: value.createHash })}\n---\n${instructions}\n`;
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new ChatAgentStoreError("agent_unavailable");
    const path = join(directory, `${value.agent.id}.md`);
    const temporary = join(directory, `.${randomUUID()}.tmp`);
    await writeFile(temporary, text, { flag: "wx", mode: 0o600 });
    try {
      if (exclusive) await link(temporary, path);
      else await rename(temporary, path);
    } finally {
      try { await unlink(temporary); } catch (error: unknown) {
        if (!isCode(error, "ENOENT")) throw error;
      }
    }
  }

  async get(owner: ChatOwner, agentId: string): Promise<ChatAgent | null> {
    const id = ChatAgentIdSchema.parse(agentId);
    const directory = await this.directory([this.ownerKey(owner)]);
    const stored = directory ? await this.read(join(directory, `${id}.md`)) : null;
    if (stored && stored.agent.id !== id) throw new ChatAgentStoreError("agent_unavailable");
    return stored?.agent ?? null;
  }

  async list(owner: ChatOwner, includeArchived = false): Promise<ChatAgent[]> {
    const directory = await this.directory([this.ownerKey(owner)]);
    if (!directory) return [];
    const agents: ChatAgent[] = [];
    let scanned = 0;
    for await (const entry of await opendir(directory)) {
      if (++scanned > MAX_AGENTS + 128) throw new ChatAgentStoreError("agent_capacity");
      if (!/^bot_[a-z0-9]{8,64}\.md$/.test(entry.name)) continue;
      const agent = await this.get(owner, entry.name.slice(0, -3));
      if (agent && (includeArchived || !agent.archived)) agents.push(agent);
      if (agents.length > MAX_AGENTS) throw new ChatAgentStoreError("agent_capacity");
    }
    return agents.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  }

  async create(owner: ChatOwner, inputValue: CreateChatAgentRequest): Promise<ChatAgent> {
    const input = CreateChatAgentRequestSchema.parse(inputValue);
    const ownerKey = this.ownerKey(owner);
    const id = `bot_${digest(`${ownerKey}:${input.clientRequestId}`).slice(0, 32)}`;
    const { clientRequestId: _requestId, ...fields } = input;
    const createHash = digest(JSON.stringify(fields));
    return this.withOwnerLock(owner, async () => {
      const directory = (await this.directory([ownerKey], true))!;
      const existing = await this.read(join(directory, `${id}.md`));
      if (existing) {
        if (existing.createHash !== createHash) throw new ChatAgentStoreError("agent_conflict");
        return existing.agent;
      }
      if ((await this.list(owner, true)).length >= MAX_AGENTS) throw new ChatAgentStoreError("agent_capacity");
      const now = (this.options.now?.() ?? new Date()).toISOString();
      const agent = ChatAgentSchema.parse({ ...fields, id, revision: 1, archived: false, createdAt: now, updatedAt: now });
      await this.write(directory, { agent, createHash }, true);
      return agent;
    });
  }

  async update(owner: ChatOwner, agentId: string, inputValue: UpdateChatAgentRequest): Promise<ChatAgent> {
    const id = ChatAgentIdSchema.parse(agentId);
    const { baseRevision, ...patch } = UpdateChatAgentRequestSchema.parse(inputValue);
    return this.withOwnerLock(owner, async () => {
      const directory = await this.directory([this.ownerKey(owner)]);
      const existing = directory ? await this.read(join(directory, `${id}.md`)) : null;
      if (!existing) throw new ChatAgentStoreError("agent_not_found");
      if (existing.agent.revision !== baseRevision) throw new ChatAgentStoreError("agent_conflict");
      const agent = ChatAgentSchema.parse({ ...existing.agent, ...patch, revision: baseRevision + 1,
        updatedAt: (this.options.now?.() ?? new Date()).toISOString() });
      await this.write(directory!, { agent, createHash: existing.createHash }, false);
      return agent;
    });
  }

  private async sweepTemporaryFiles(): Promise<void> {
    const root = await this.directory([]);
    if (!root) return;
    let owners = 0;
    for await (const owner of await opendir(root)) {
      if (++owners > 256) break;
      if (!owner.isDirectory() || !/^[a-f0-9]{64}$/.test(owner.name)) continue;
      const directory = await this.directory([owner.name]);
      if (!directory) continue;
      let files = 0;
      for await (const entry of await opendir(directory)) {
        if (++files > MAX_AGENTS + 128) break;
        if (!entry.isFile() || !/^\.[a-f0-9-]{36}\.tmp$/.test(entry.name)) continue;
        const path = join(directory, entry.name);
        try {
          const info = await lstat(path);
          if (info.isFile() && !info.isSymbolicLink() && Date.now() - info.mtimeMs > TEMP_TTL_MS) await unlink(path);
        } catch (error: unknown) { if (!isCode(error, "ENOENT")) throw error; }
      }
    }
  }
}
