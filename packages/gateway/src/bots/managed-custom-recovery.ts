import { isDeepStrictEqual } from "node:util";
import { sql, type Transaction } from "kysely";
import { ChatAgentIdSchema, CreateManagedCustomBotRequestSchema, InstantiateBotResponseSchema, RecoverManagedCustomBotRequestSchema,
  isManagedCustomBot, type CanonicalChatModelSelection, type ChatAgent, type InstantiateBotResponse } from "@matrix-os/contracts";
import { ChatAgentStoreError, type ChatAgentStore } from "../chat/agent-store.js";
import { lockChatAgentOwner } from "../chat/agent-owner-lock.js";
import type { ChatAgentRecipeResolver } from "../chat/agent-recipe.js";
import type { ChatDatabase } from "../chat/database.js";
import type { ChatRepository } from "../chat/repository.js";
import { ManagedCustomDefinitionError, resolveManagedCustomDefinition } from "./custom-definition.js";
import { managedCustomRecoveryRequestId } from "./custom-creation-authority.js";
import { botAvatarSeed, BotInstantiationError, ownerBotExecutor, type BotCreationFailureReason } from "./instantiation.js";
import { createBotOperationsRepository, type BotOperation } from "./repositories/operations.js";
import { BotStateError } from "./repositories/shared.js";

export class ManagedCustomRecoveryError extends Error {
  constructor(readonly code: "invalid_request" | "not_found" | "conflict" | "unavailable", readonly reason?: BotCreationFailureReason) { super(code); this.name = "ManagedCustomRecoveryError"; }
}

/** Explicit owner action. Reserves the existing identities, never creates another Bot or Chat. */
export function createManagedCustomRecovery(deps: {
  chats: Pick<ChatRepository, "withTransaction">;
  agents: Pick<ChatAgentStore, "getCreationSnapshot" | "promoteManagedCustom">;
  customRecipes: Pick<ChatAgentRecipeResolver, "resolve">;
  validateSelection(ownerId: string, selection: CanonicalChatModelSelection): Promise<void>;
  ensureWorkspace(botId: string): Promise<void>;
  hasLiveRuntime(ownerId: string, chatId: string): boolean;
}) {
  const conflict = () => new ManagedCustomRecoveryError("conflict");
  const owner = (ownerId: string) => ({ type: "personal" as const, ownerId });

  async function qualify(ownerId: string, agent: ChatAgent) {
    if (agent.archived || agent.selection.instanceId !== "matrix_pi_default" || agent.selection.options?.length) throw conflict();
    const parsed = CreateManagedCustomBotRequestSchema.safeParse({ clientRequestId: "req_recovery_validation", name: agent.name,
      description: agent.description, instructions: agent.instructions, selection: agent.selection, ...(agent.recipe ? { recipe: agent.recipe } : {}) });
    if (!parsed.success) throw new ManagedCustomRecoveryError("invalid_request");
    await deps.validateSelection(ownerId, agent.selection);
    await resolveManagedCustomDefinition(agent, deps.customRecipes);
  }

  async function directChat(repository: ChatRepository, ownerId: string, botId: string) {
    const db = ownerBotExecutor(repository.kysely);
    const binding = await db.selectFrom("bot_chat_bindings").selectAll().where("owner_id", "=", ownerId).where("bot_id", "=", botId)
      .where("kind", "=", "direct").where("removed_at", "is", null).executeTakeFirst();
    if (!binding) throw new ManagedCustomRecoveryError("not_found");
    const chat = await db.selectFrom("chats").selectAll().where("id", "=", binding.chat_id)
      .where("owner_type", "=", "personal").where("owner_id", "=", ownerId).forUpdate().executeTakeFirst();
    if (!chat || chat.lifecycle !== "active" || chat.collaboration !== null) throw conflict();
    // Recheck/lock after the Chat lock so removal cannot race final activation.
    const live = await db.selectFrom("bot_chat_bindings").select("chat_id").where("owner_id", "=", ownerId).where("bot_id", "=", botId)
      .where("chat_id", "=", chat.id).where("kind", "=", "direct").where("removed_at", "is", null).forUpdate().executeTakeFirst();
    if (!live) throw conflict();
    return chat;
  }

  async function idle(repository: ChatRepository, ownerId: string, botId: string, chat: Awaited<ReturnType<typeof directChat>>) {
    if (chat.bound_driver_kind !== null || chat.bound_instance_id !== null || chat.bound_at_turn_id !== null || deps.hasLiveRuntime(ownerId, chat.id)) throw conflict();
    const db = ownerBotExecutor(repository.kysely);
    const badRun = await db.selectFrom("chat_runs").select("id").where("chat_id", "=", chat.id)
      .where(eb => eb.or([eb("status", "not in", ["completed", "failed", "aborted"]),
        sql<boolean>`context_snapshot->'agent'->>'id' IS DISTINCT FROM ${botId}`])).limit(1).executeTakeFirst();
    const turn = await db.selectFrom("chat_turns").select("id").where("chat_id", "=", chat.id)
      .where("status", "in", ["accepted", "running"]).limit(1).executeTakeFirst();
    const queue = await db.selectFrom("chat_queued_turns").select("id").where("chat_id", "=", chat.id).where("status", "in", ["queued", "claimed"]).limit(1).executeTakeFirst();
    const task = await db.selectFrom("bot_tasks").select("task_id").where("owner_id", "=", ownerId).where("bot_id", "=", botId)
      .where("status", "not in", ["completed", "failed", "cancelled"]).limit(1).executeTakeFirst();
    const effect = await db.selectFrom("bot_tool_checkpoints as checkpoint").innerJoin("bot_tasks as task", "task.task_id", "checkpoint.task_id")
      .select("checkpoint.checkpoint_id").where("task.owner_id", "=", ownerId).where("task.bot_id", "=", botId)
      .where("checkpoint.phase", "in", ["prepared", "dispatched", "effect_unknown"]).limit(1).executeTakeFirst();
    const approval = await db.selectFrom("bot_approvals").select("approval_id").where("owner_id", "=", ownerId).where("bot_id", "=", botId)
      .where("status", "in", ["pending", "approved"]).where("expires_at", ">", new Date().toISOString()).limit(1).executeTakeFirst();
    if (badRun || turn || queue || task || effect || approval) throw conflict();
  }

  function response(operation: BotOperation, agent: ChatAgent): InstantiateBotResponse {
    return InstantiateBotResponseSchema.parse({ agent: { id: agent.id, name: agent.name, avatarSeed: botAvatarSeed(agent.id), revision: agent.revision, status: "active" },
      chatId: operation.chatId, operation: "replayed" });
  }

  return {
    /** No discovery or mutations. A file reference alone never authorizes resumption. */
    async projectUnfinished(ownerId: string, listed: readonly ChatAgent[]): Promise<{ agentId: string; baseRevision: number }[]> {
      const candidates = listed.slice(0, 100).filter(agent => !agent.archived && agent.selection.instanceId === "matrix_pi_default"
        && !agent.selection.options?.length && (!agent.recipeRef || isManagedCustomBot(agent)))
        .map(agent => {
          const baseRevision = agent.recipeRef ? agent.revision - 1 : agent.revision;
          return { agent, baseRevision, requestId: managedCustomRecoveryRequestId(ownerId, agent.id, baseRevision) };
        }).filter(candidate => candidate.baseRevision >= 1);
      if (!candidates.length) return [];
      return deps.chats.withTransaction(async repository => {
        await lockChatAgentOwner(repository.kysely, owner(ownerId));
        const operations = await ownerBotExecutor(repository.kysely).selectFrom("bot_operations").selectAll()
          .where("owner_id", "=", ownerId).where("client_request_id", "in", candidates.map(candidate => candidate.requestId))
          .where("status", "!=", "active").limit(100).execute();
        const result: { agentId: string; baseRevision: number }[] = [];
        for (const { agent, baseRevision, requestId } of candidates) {
          const operation = operations.find(operation => operation.bot_id === agent.id && operation.client_request_id === requestId);
          if (!operation) continue;
          const stored = await deps.agents.getCreationSnapshot(owner(ownerId), agent.id);
          if (!stored || !isDeepStrictEqual(stored.agent, agent) || stored.createHash !== operation.payload_hash) continue;
          if (operation.workspace_rel_path !== `bots/${agent.id}`) continue;
          try {
            const chat = await directChat(repository, ownerId, agent.id);
            if (chat.id !== operation.chat_id) continue;
            await idle(repository, ownerId, agent.id, chat);
            result.push({ agentId: agent.id, baseRevision });
          } catch (error: unknown) {
            // An ineligible candidate must not hide unrelated Bots. Infrastructure
            // failures still fail the read instead of enabling a fallback action.
            if (!(error instanceof ManagedCustomRecoveryError) || !["conflict", "not_found"].includes(error.code)) throw error;
          }
        }
        return result;
      });
    },
    async recover(ownerId: string, agentIdValue: string, requestValue: unknown): Promise<InstantiateBotResponse> {
      const id = ChatAgentIdSchema.safeParse(agentIdValue), parsed = RecoverManagedCustomBotRequestSchema.safeParse(requestValue);
      if (!id.success || !parsed.success) throw new ManagedCustomRecoveryError("invalid_request");
      const botId = id.data, baseRevision = parsed.data.baseRevision;
      const requestId = managedCustomRecoveryRequestId(ownerId, botId, baseRevision);
      try {
        // Read-only preflight holds locks only while inspecting owner state.
        // Provider discovery can take longer than the lock/client deadlines.
        const preflight = await deps.chats.withTransaction(async repository => {
          await lockChatAgentOwner(repository.kysely, owner(ownerId));
          const stored = await deps.agents.getCreationSnapshot(owner(ownerId), botId);
          if (!stored) throw new ManagedCustomRecoveryError("not_found");
          const chat = await directChat(repository, ownerId, botId);
          const operations = createBotOperationsRepository(ownerBotExecutor(repository.kysely));
          const existing = await operations.get(ownerId, requestId);
          if (existing && (existing.botId !== botId || existing.chatId !== chat.id || existing.payloadHash !== stored.createHash)) throw conflict();
          if (existing?.status === "active") {
            if (!isManagedCustomBot(stored.agent) || stored.agent.archived) throw conflict();
            return { operation: existing, agent: stored.agent, active: true as const };
          }
          if (stored.agent.recipeRef ? !existing || !isManagedCustomBot(stored.agent) || stored.agent.revision !== baseRevision + 1
            : stored.agent.revision !== baseRevision) throw conflict();
          await idle(repository, ownerId, botId, chat);
          return { agent: stored.agent, createHash: stored.createHash, chatId: chat.id, active: false as const };
        });
        if (preflight.active) return response(preflight.operation, preflight.agent);
        await qualify(ownerId, preflight.agent);
        // Commit reservation only after validation, and only for the exact
        // snapshot validated above. Concurrent edits must never be adopted.
        const reserved = await deps.chats.withTransaction(async repository => {
          await lockChatAgentOwner(repository.kysely, owner(ownerId));
          const stored = await deps.agents.getCreationSnapshot(owner(ownerId), botId);
          const chat = await directChat(repository, ownerId, botId);
          const db = ownerBotExecutor(repository.kysely), operations = createBotOperationsRepository(db);
          const existing = await operations.get(ownerId, requestId);
          if (!stored || chat.id !== preflight.chatId || stored.createHash !== preflight.createHash
            || existing && (existing.botId !== botId || existing.chatId !== chat.id || existing.payloadHash !== stored.createHash)) throw conflict();
          if (existing?.status === "active") {
            if (!isManagedCustomBot(stored.agent) || stored.agent.archived) throw conflict();
            return { operation: existing, agent: stored.agent, active: true as const };
          }
          if (JSON.stringify(stored.agent) !== JSON.stringify(preflight.agent)) throw conflict();
          await idle(repository, ownerId, botId, chat);
          const operation = existing ?? await operations.reserveRecovery({ ownerId, clientRequestId: requestId, botId, chatId: chat.id,
            payloadHash: stored.createHash, now: new Date().toISOString() }, db);
          return { operation, agent: stored.agent, active: false as const };
        });
        if (reserved.active) return response(reserved.operation, reserved.agent);
        await deps.ensureWorkspace(botId);
        // Phase 2 serializes definition edits and new Chat admissions. File writes
        // cannot roll back with Postgres; a promoted orphan stays nonexecutable
        // until this exact reserved operation successfully activates on retry.
        return await deps.chats.withTransaction(async repository => {
          await lockChatAgentOwner(repository.kysely, owner(ownerId));
          const chat = await directChat(repository, ownerId, botId);
          const db = ownerBotExecutor(repository.kysely), operations = createBotOperationsRepository(db);
          let operation = await operations.get(ownerId, requestId);
          const stored = await deps.agents.getCreationSnapshot(owner(ownerId), botId);
          if (!operation || !stored || operation.botId !== botId || operation.chatId !== chat.id || operation.payloadHash !== stored.createHash) throw conflict();
          if (operation.status === "active") {
            if (!isManagedCustomBot(stored.agent) || stored.agent.archived) throw conflict();
            return response(operation, stored.agent);
          }
          if (JSON.stringify(stored.agent) !== JSON.stringify(reserved.agent)) throw conflict();
          await idle(repository, ownerId, botId, chat);
          const agent = await deps.agents.promoteManagedCustom(owner(ownerId), botId, { baseRevision, createHash: operation.payloadHash },
            repository.kysely as Transaction<ChatDatabase>);
          const at = new Date().toISOString();
          if (operation.status !== "file_created") operation = await operations.markFileCreated({ ownerId, clientRequestId: requestId, baseRevision: operation.revision, now: at });
          const updated = await db.updateTable("chats").set({ current_selection: JSON.stringify({ instanceId: "matrix_bot_default", model: agent.selection.model }),
            revision: sql<number>`revision + 1`, updated_at: at }).where("id", "=", chat.id).where("revision", "=", chat.revision)
            .where("bound_driver_kind", "is", null).where("bound_instance_id", "is", null).where("bound_at_turn_id", "is", null)
            .returning("revision").executeTakeFirst();
          if (!updated) throw conflict();
          operation = await operations.markActive({ ownerId, clientRequestId: requestId, baseRevision: operation.revision, now: at });
          await repository.appendOutboxEvent(owner(ownerId), chat.id, Number(updated.revision), "chat.updated", { agentId: botId, revision: agent.revision });
          return response(operation, agent);
        });
      } catch (error: unknown) {
        if (error instanceof ManagedCustomRecoveryError) throw error;
        if (error instanceof BotInstantiationError) throw new ManagedCustomRecoveryError(error.code === "invalid_request" ? "invalid_request" : "unavailable");
        if (error instanceof ManagedCustomDefinitionError) throw new ManagedCustomRecoveryError("invalid_request", error.code);
        if (error instanceof ChatAgentStoreError) throw new ManagedCustomRecoveryError(error.code === "agent_not_found" ? "not_found" : error.code === "agent_conflict" ? "conflict" : "unavailable");
        if (error instanceof BotStateError) throw conflict();
        console.warn("[bots] managed recovery failed:", error instanceof Error ? error.name : "UnknownError");
        throw new ManagedCustomRecoveryError("unavailable");
      }
    },
  };
}
export type ManagedCustomRecovery = ReturnType<typeof createManagedCustomRecovery>;
