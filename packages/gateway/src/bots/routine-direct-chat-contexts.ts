import { createHash, randomBytes } from "node:crypto";
import { sql, type Expression, type Kysely, type RawBuilder, type Transaction } from "kysely";
import { CanonicalChatIdSchema } from "@matrix-os/contracts";
import type { ChatAgentStore } from "../chat/agent-store.js";
import { hasNonPrivateChatScopeSql } from "../chat/private-routine-authority.js";
import type { ChatRepository } from "../chat/repository.js";
import type { OwnerBotDatabase } from "./database.js";
import { ownerBotExecutor } from "./instantiation.js";
import { ROUTINE_DIRECT_CHAT_RECIPE } from "./recipe-catalog.js";
import { createBotBindingsRepository } from "./repositories/bindings.js";
import { RoutineCliScopeSchema } from "./repositories/routine-cli-preferences.js";
import type { BotExecutor } from "./repositories/shared.js";
import { ROUTINE_DIRECT_CHAT_ID_PATTERN, isRoutineDirectChatId } from "./routine-direct-chat-identity.js";
import { RoutineCliError, routineCliBoundary } from "./routine-cli-errors.js";
import { MATRIX_BOT_SELECTION } from "./selection.js";

const MAX_CONTEXTS_PER_OWNER = 64;
const scopeSchema = RoutineCliScopeSchema.extend({ sourceChatId: CanonicalChatIdSchema }).strict();
type DirectChatScope = { ownerId: string; computerId: string; sourceChatId: string };
type DirectChatTarget = { botId: string; chatId: string };

export interface RoutineDirectChatContexts {
  ensure(scope: DirectChatScope, signal: AbortSignal): Promise<void>;
  getWithin(trx: Transaction<OwnerBotDatabase>, scope: DirectChatScope): Promise<DirectChatTarget | null>;
}

/** Used by the scheduler's due-work query as well as the interactive authority path. */
export function routineDirectChatSourceEligible(ownerId: Expression<string>, sourceChatId: Expression<string>): RawBuilder<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM chats origin
    WHERE origin.id = ${sourceChatId} AND origin.owner_id = ${ownerId}
      AND origin.owner_type = 'personal' AND origin.lifecycle = 'active'
      AND origin.collaboration IS NULL AND origin.id !~ ${ROUTINE_DIRECT_CHAT_ID_PATTERN.source}
      AND NOT ${hasNonPrivateChatScopeSql(sql.ref("origin.owner_type"), sql.ref("origin.owner_id"), sql.ref("origin.id"))}
      AND NOT EXISTS (
        SELECT 1 FROM bot_chat_bindings origin_binding
        WHERE origin_binding.chat_id = origin.id AND origin_binding.removed_at IS NULL
      )
  )`;
}

export async function routineDirectChatSourceIsEligible(db: BotExecutor, input: { ownerId: string; sourceChatId: string },
  options: { lock?: boolean } = {}): Promise<boolean> {
  if (isRoutineDirectChatId(input.sourceChatId)) return false;
  if (options.lock) {
    const origin = await db.selectFrom("chats").select("id").where("id", "=", input.sourceChatId)
      .where("owner_id", "=", input.ownerId).where("owner_type", "=", "personal").forUpdate().executeTakeFirst();
    if (!origin) return false;
    // Lock removed rows too so restoring an old binding is fenced just like a new FK insert.
    await sql`WITH locked AS MATERIALIZED (
      SELECT 1 FROM bot_chat_bindings WHERE chat_id = ${input.sourceChatId}
      ORDER BY owner_id, bot_id FOR SHARE
    ) SELECT count(*) FROM locked`.execute(db);
  }
  const result = await sql<{ eligible: boolean }>`SELECT ${routineDirectChatSourceEligible(sql.val(input.ownerId), sql.val(input.sourceChatId))} AS eligible`.execute(db);
  return result.rows[0]?.eligible === true;
}

export function createRoutineDirectChatContexts(options: {
  db: Kysely<OwnerBotDatabase>;
  agents: Pick<ChatAgentStore, "createRecipeBot">;
  repository: Pick<ChatRepository, "withTransaction">;
  ensureWorkspace(botId: string): Promise<void>;
  now?: () => Date;
}): RoutineDirectChatContexts {
  const { db, agents, repository } = options;
  const now = () => (options.now?.() ?? new Date()).toISOString();
  const mapping = (ex: BotExecutor, scope: DirectChatScope) => ex.selectFrom("routine_direct_chat_contexts")
    .where("owner_id", "=", scope.ownerId).where("computer_id", "=", scope.computerId).where("source_chat_id", "=", scope.sourceChatId);
  const assertLive = (signal: AbortSignal) => {
    if (signal.aborted) throw new RoutineCliError("permission_denied");
  };

  async function getWithin(trx: Transaction<OwnerBotDatabase>, scope: DirectChatScope): Promise<DirectChatTarget | null> {
    if (!trx.isTransaction) throw new RoutineCliError("unavailable");
    if (!await routineDirectChatSourceIsEligible(trx, scope)) return null;
    const row = await mapping(trx, scope).select(["bot_id", "chat_id"]).where("activated_at", "is not", null).executeTakeFirst();
    if (!row) return null;
    const bindings = await trx.selectFrom("bot_chat_bindings as binding").innerJoin("chats as chat", "chat.id", "binding.chat_id")
      .select(["binding.owner_id", "binding.bot_id", "binding.kind"]).where("binding.chat_id", "=", row.chat_id)
      .where("chat.owner_id", "=", scope.ownerId).where("chat.owner_type", "=", "personal")
      .where("chat.collaboration", "is", null).where("chat.lifecycle", "=", "active")
      .where("binding.removed_at", "is", null).limit(2).execute();
    const binding = bindings[0];
    if (bindings.length !== 1 || !binding || binding.owner_id !== scope.ownerId || binding.bot_id !== row.bot_id || binding.kind !== "direct") return null;
    return { botId: row.bot_id, chatId: row.chat_id };
  }

  async function reserve(scope: DirectChatScope, signal: AbortSignal) {
    return db.transaction().execute(async trx => {
      await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${"routine-direct-chat:" + scope.ownerId}, 0))`.execute(trx);
      assertLive(signal);
      if (!await routineDirectChatSourceIsEligible(trx, scope, { lock: true })) throw new RoutineCliError("permission_denied");
      const existing = await mapping(trx, scope).select(["bot_id", "chat_id", "activated_at"]).executeTakeFirst();
      if (existing) {
        if (existing.activated_at && !await getWithin(trx, scope)) throw new RoutineCliError("target_unavailable");
        return existing;
      }
      const count = await trx.selectFrom("routine_direct_chat_contexts").select(eb => eb.fn.countAll<string>().as("total"))
        .where("owner_id", "=", scope.ownerId).executeTakeFirstOrThrow();
      if (Number(count.total) >= MAX_CONTEXTS_PER_OWNER) throw new RoutineCliError("unavailable");
      return trx.insertInto("routine_direct_chat_contexts").values({
        owner_id: scope.ownerId, computer_id: scope.computerId, source_chat_id: scope.sourceChatId,
        bot_id: `bot_routine${randomBytes(16).toString("hex")}`, chat_id: `chat_routine_${randomBytes(16).toString("hex")}`,
      }).returning(["bot_id", "chat_id", "activated_at"]).executeTakeFirstOrThrow();
    });
  }

  return {
    getWithin,
    ensure: (raw, signal) => routineCliBoundary(async () => {
      assertLive(signal);
      const scope = scopeSchema.parse(raw);
      const identity = await reserve(scope, signal);
      if (identity.activated_at) return;
      assertLive(signal);
      const owner = { type: "personal" as const, ownerId: scope.ownerId };
      const { recipeId, version, name, description, instructions } = ROUTINE_DIRECT_CHAT_RECIPE;
      const definitionHash = createHash("sha256").update(JSON.stringify([scope, identity.bot_id, identity.chat_id, recipeId, version])).digest("hex");
      await agents.createRecipeBot(owner, {
        id: identity.bot_id, createHash: definitionHash, fields: { name, description, instructions, selection: MATRIX_BOT_SELECTION }, recipeRef: { recipeId, version },
      });
      try {
        await options.ensureWorkspace(identity.bot_id);
      } catch (error: unknown) {
        // A concurrent retry may have activated and used the workspace while we waited for the definition.
        if (!await db.transaction().execute(trx => getWithin(trx, scope))) throw error;
        return;
      }
      assertLive(signal);
      await repository.withTransaction(async repo => {
        const trx = ownerBotExecutor(repo.kysely);
        await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
        if (!await routineDirectChatSourceIsEligible(trx, scope, { lock: true })) throw new RoutineCliError("permission_denied");
        assertLive(signal);
        const reserved = await mapping(trx, scope).select(["bot_id", "chat_id", "activated_at"]).forUpdate().executeTakeFirst();
        if (!reserved || reserved.bot_id !== identity.bot_id || reserved.chat_id !== identity.chat_id) throw new RoutineCliError("target_unavailable");
        if (reserved.activated_at) return;
        const record = await repo.create(owner, {
          id: identity.chat_id, clientRequestId: `req_${identity.chat_id}`, title: name, currentSelection: MATRIX_BOT_SELECTION,
        });
        if (record.chat.id !== identity.chat_id) throw new RoutineCliError("target_unavailable");
        const at = now();
        await createBotBindingsRepository(trx).bindDirect({ ownerId: scope.ownerId, botId: identity.bot_id, chatId: identity.chat_id, now: at });
        await trx.updateTable("routine_direct_chat_contexts").set({ activated_at: at })
          .where("owner_id", "=", scope.ownerId).where("computer_id", "=", scope.computerId)
          .where("source_chat_id", "=", scope.sourceChatId).where("activated_at", "is", null).executeTakeFirst();
      });
    }),
  };
}
