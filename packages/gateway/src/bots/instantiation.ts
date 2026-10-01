/**
 * Recipe bot creation (spec 536, data-model.md `bot_operations`). One
 * request moves an operation `reserved` -> `file_created` -> `active`:
 *
 * 1. Transaction 1 reserves the operation, fixing the bot and chat IDs.
 * 2. Under the owner lock, the definition file is created exclusively, then
 *    the workspace; the operation becomes `file_created`.
 * 3. Transaction 2 creates the chat, binds it as the bot's direct chat, and
 *    marks the operation `active`.
 *
 * Files and the database cannot share a transaction. A crash leaves a
 * reserved operation or a definition without a chat; both are finished
 * later with the same IDs, by a retried request or by reconciliation.
 * Nothing is dispatched until the operation is active, and an existing bot
 * is never deleted or replaced to repair one.
 */
import { createHash } from "node:crypto";
import { lstat, opendir } from "node:fs/promises";
import {
  InstantiateBotRequestSchema,
  InstantiateBotResponseSchema,
  type ChatAgent,
  type InstantiateBotRequest,
  type InstantiateBotResponse,
} from "@matrix-os/contracts";
import { ChatAgentStoreError, type ChatAgentStore } from "../chat/agent-store.js";
import { botWorkspacePath, createBotWorkspace } from "../chat/bot-workspace-root.js";
import type { ChatRepository } from "../chat/repository.js";
import type { Kysely } from "kysely";
import type { ChatDatabase } from "../chat/database.js";
import type { OwnerBotDatabase } from "./database.js";
import { BotRecipeCatalogError, type BotRecipeCatalog } from "./recipe-catalog.js";
import { createBotBindingsRepository } from "./repositories/bindings.js";
import { createBotOperationsRepository, type BotOperation } from "./repositories/operations.js";
import { BotStateError, type BotExecutor } from "./repositories/shared.js";
import { MATRIX_BOT_SELECTION } from "./selection.js";

export type BotInstantiationErrorCode = "invalid_request" | "conflict" | "rate_limited" | "unavailable";

/** Allowlisted failures; the route maps each to one status and a generic message. */
export class BotInstantiationError extends Error {
  constructor(readonly code: BotInstantiationErrorCode) {
    super(`Bot instantiation failed: ${code}`);
    this.name = "BotInstantiationError";
  }
}

/** Another request moved the same creation forward first. Internal only. */
class ConcurrentCreationError extends Error {
  constructor() {
    super("Bot creation advanced concurrently");
    this.name = "ConcurrentCreationError";
  }
}

const CONCURRENT_WAIT_ATTEMPTS = 20;
const CONCURRENT_WAIT_MS = 250;
const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** Recorded on the operation when a step fails; never shown to a client. */
type FailureCode =
  | "capacity_exceeded" | "definition_conflict" | "definition_failed" | "definition_missing" | "workspace_failed" | "activation_failed";

export function botAvatarSeed(botId: string): string {
  return createHash("sha256").update(`bot-avatar:${botId}`).digest("hex").slice(0, 32);
}

/** Hash of the normalized creation request; a retry with another payload is a conflict. */
export function instantiationPayloadHash(request: Pick<InstantiateBotRequest, "recipe" | "name">): string {
  return createHash("sha256").update(JSON.stringify({
    recipe: { recipeId: request.recipe.recipeId, version: request.recipe.version },
    name: request.name ?? null,
  })).digest("hex");
}

/**
 * The bot tables live in the chat repository's owner database, so its
 * connection (or open transaction) is also a bot executor once the bot
 * schema is migrated. Only the type changes; the runtime object is reused.
 */
export function ownerBotExecutor(kysely: Kysely<ChatDatabase>): Kysely<OwnerBotDatabase> {
  return kysely as unknown as Kysely<OwnerBotDatabase>;
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

/**
 * Creates the bot workspace, or reuses it on a retry of the same creation:
 * only a real, empty directory is reused, since no run has used it yet.
 */
export async function ensureBotWorkspace(homePath: string, botId: string): Promise<void> {
  try {
    await createBotWorkspace({ homePath, botId });
    return;
  } catch (error: unknown) {
    if (!isCode(error, "EEXIST")) throw error;
  }
  const path = botWorkspacePath(homePath, botId);
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new BotInstantiationError("unavailable");
  const directory = await opendir(path);
  let entry;
  try {
    entry = await directory.read();
  } finally {
    await directory.close();
  }
  if (entry) throw new BotInstantiationError("unavailable");
}

export function createBotInstantiation(deps: {
  db: BotExecutor;
  chats: Pick<ChatRepository, "withTransaction">;
  agents: Pick<ChatAgentStore, "createRecipeBot" | "get" | "count">;
  recipes: BotRecipeCatalog;
  ensureWorkspace(botId: string): Promise<void>;
  now?: () => Date;
}) {
  const now = () => (deps.now?.() ?? new Date()).toISOString();
  const operations = createBotOperationsRepository(deps.db);
  const owner = (ownerId: string) => ({ type: "personal" as const, ownerId });

  async function fail(operation: BotOperation, failureCode: FailureCode): Promise<void> {
    try {
      await operations.markFailed({
        ownerId: operation.ownerId, clientRequestId: operation.clientRequestId,
        baseRevision: operation.revision, failureCode, now: now(),
      });
    } catch (error: unknown) {
      console.warn("[bots] creation failure was not recorded:", error instanceof Error ? error.name : "UnknownError");
    }
  }

  /** Transaction 2: the chat, its direct binding, and activation commit together. */
  async function activate(operation: BotOperation, agent: ChatAgent): Promise<BotOperation> {
    return deps.chats.withTransaction(async (repository) => {
      const record = await repository.create(owner(operation.ownerId), {
        id: operation.chatId,
        // Derived from the reserved bot ID, so a person's own chat requests never collide with it.
        clientRequestId: `req_botchat_${operation.botId}`,
        title: agent.name,
        currentSelection: agent.selection,
      });
      if (record.chat.id !== operation.chatId) throw new BotInstantiationError("conflict");
      const trx = ownerBotExecutor(repository.kysely);
      const at = now();
      await createBotBindingsRepository(trx).bindDirect({ ownerId: operation.ownerId, botId: operation.botId, chatId: operation.chatId, now: at }, trx);
      const active = await createBotOperationsRepository(trx).markActive({
        ownerId: operation.ownerId, clientRequestId: operation.clientRequestId, baseRevision: operation.revision, now: at,
      }, trx);
      // Delivered only if the chat, binding, and activation commit.
      await repository.appendOutboxEvent(owner(operation.ownerId), operation.chatId, record.chat.revision, "bot.created", {
        agentId: operation.botId, chatId: operation.chatId, revision: agent.revision,
      });
      return active;
    });
  }

  /**
   * Moves an unfinished operation forward with its fixed IDs. `definition`
   * creates or reads the bot's file; everything after it is idempotent. The
   * workspace is checked on every attempt, so an operation is never
   * activated with its workspace missing.
   */
  async function advance(operation: BotOperation, definition: () => Promise<ChatAgent | null>): Promise<{ operation: BotOperation; agent: ChatAgent }> {
    let current = operation;
    let step: FailureCode = "definition_failed";
    try {
      const agent = await definition();
      if (!agent) {
        step = "definition_missing";
        throw new BotInstantiationError("unavailable");
      }
      step = "workspace_failed";
      await deps.ensureWorkspace(current.botId);
      if (current.status !== "file_created") {
        current = await operations.markFileCreated({
          ownerId: current.ownerId, clientRequestId: current.clientRequestId, baseRevision: current.revision, now: now(),
        });
      }
      step = "activation_failed";
      return { operation: await activate(current, agent), agent };
    } catch (error: unknown) {
      // Another request for the same creation moved it forward first; it is not a failure.
      if (error instanceof BotStateError && (error.code === "revision_conflict" || error.code === "invalid_transition")) {
        throw new ConcurrentCreationError();
      }
      const capacity = error instanceof ChatAgentStoreError && error.code === "agent_capacity";
      const conflict = error instanceof ChatAgentStoreError && error.code === "agent_conflict";
      if (!(error instanceof BotInstantiationError)) {
        console.warn("[bots] bot creation step failed:", step, error instanceof Error ? error.name : "UnknownError");
      }
      await fail(current, capacity ? "capacity_exceeded" : conflict ? "definition_conflict" : step);
      throw new BotInstantiationError(capacity ? "rate_limited" : "unavailable");
    }
  }

  /** Answers a request whose operation is active; a concurrent duplicate may have finished it. */
  async function replay(operation: BotOperation, created: boolean): Promise<InstantiateBotResponse | undefined> {
    if (operation.status !== "active") return undefined;
    const agent = await deps.agents.get(owner(operation.ownerId), operation.botId);
    if (!agent) throw new BotInstantiationError("unavailable");
    return response(operation, agent, created);
  }

  /** Waits, bounded, for a concurrent request to finish the same creation. */
  async function awaitConcurrent(ownerId: string, clientRequestId: string, created: boolean): Promise<InstantiateBotResponse> {
    for (let attempt = 0; attempt < CONCURRENT_WAIT_ATTEMPTS; attempt += 1) {
      const latest = await operations.get(ownerId, clientRequestId);
      const replayed = latest ? await replay(latest, created) : undefined;
      if (replayed) return replayed;
      if (!latest || latest.status === "failed_recoverable") break;
      await sleep(CONCURRENT_WAIT_MS);
    }
    throw new BotInstantiationError("unavailable");
  }

  function response(operation: BotOperation, agent: ChatAgent, created: boolean): InstantiateBotResponse {
    return InstantiateBotResponseSchema.parse({
      agent: { id: agent.id, name: agent.name, avatarSeed: botAvatarSeed(agent.id), revision: agent.revision, status: "active" },
      chatId: operation.chatId,
      operation: created ? "created" : "replayed",
    });
  }

  return {
    async instantiate(ownerId: string, requestValue: unknown): Promise<InstantiateBotResponse> {
      const parsed = InstantiateBotRequestSchema.safeParse(requestValue);
      if (!parsed.success) throw new BotInstantiationError("invalid_request");
      const request = parsed.data;
      const payloadHash = instantiationPayloadHash(request);
      const scope = owner(ownerId);
      // A retry is answered from its operation first, so retiring a recipe never breaks replay.
      const existing = await operations.get(ownerId, request.clientRequestId);
      if (existing && existing.payloadHash !== payloadHash) throw new BotInstantiationError("conflict");
      const replayedExisting = existing ? await replay(existing, false) : undefined;
      if (replayedExisting) return replayedExisting;
      let recipe;
      try {
        recipe = deps.recipes.resolve(request.recipe);
      } catch (error: unknown) {
        if (!(error instanceof BotRecipeCatalogError)) throw error;
        if (!existing) throw new BotInstantiationError("invalid_request");
        // An unfinished creation of a now-retired recipe finishes only from its saved definition.
        recipe = undefined;
      }
      // Checked before reserving so a full owner is refused without leaving an operation behind.
      if (!existing && await deps.agents.count(scope) >= 100) throw new BotInstantiationError("rate_limited");
      let reserved: { operation: BotOperation; created: boolean };
      try {
        reserved = await operations.reserve({ ownerId, clientRequestId: request.clientRequestId, payloadHash, now: now() });
      } catch (error: unknown) {
        if (error instanceof BotStateError && error.code === "conflict") throw new BotInstantiationError("conflict");
        throw error;
      }
      const { operation, created } = reserved;
      const replayed = await replay(operation, false);
      if (replayed) return replayed;
      const definition = recipe
        ? () => deps.agents.createRecipeBot(scope, {
          id: operation.botId,
          createHash: payloadHash,
          fields: {
            name: request.name ?? recipe.name,
            description: recipe.description,
            instructions: recipe.instructions,
            selection: MATRIX_BOT_SELECTION,
          },
          recipeRef: { recipeId: recipe.recipeId, version: recipe.version },
        })
        : () => deps.agents.get(scope, operation.botId);
      try {
        const finished = await advance(operation, definition);
        return response(finished.operation, finished.agent, created);
      } catch (error: unknown) {
        if (error instanceof ConcurrentCreationError) return awaitConcurrent(ownerId, request.clientRequestId, created);
        if (!(error instanceof BotInstantiationError) || error.code !== "unavailable") throw error;
        const latest = await operations.get(ownerId, request.clientRequestId);
        const concurrent = latest ? await replay(latest, created) : undefined;
        if (concurrent) return concurrent;
        throw error;
      }
    },
    /**
     * Reconciliation: finishes an unfinished operation whose definition file
     * exists. Without one, the payload is unknown, so the operation is marked
     * recoverable and only a retried request can finish it.
     */
    async resume(operation: BotOperation): Promise<void> {
      try {
        await advance(operation, () => deps.agents.get(owner(operation.ownerId), operation.botId));
      } catch (error: unknown) {
        // A request finishing the same creation is not a reconciliation failure.
        if (!(error instanceof ConcurrentCreationError)) throw error;
      }
    },
  };
}

export type BotInstantiation = ReturnType<typeof createBotInstantiation>;
