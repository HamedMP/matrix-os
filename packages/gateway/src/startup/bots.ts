/**
 * Starts recipe bot services on the owner database the chat repository
 * owns (spec 536, technical-design "Integration Wiring and Startup"):
 * migrations first, then creation and its reconciliation. Bots stay
 * unavailable, and their routes answer 503, when the schema cannot be
 * prepared; the rest of the gateway keeps running. Closing stops
 * reconciliation; the database stays with its owner.
 */
import type { ChatAgentStore } from "../chat/agent-store.js";
import type { ChatRepository } from "../chat/repository.js";
import { bootstrapBotDatabase } from "../bots/database.js";
import { createBotInstantiation, ensureBotWorkspace, ownerBotExecutor, type BotInstantiation } from "../bots/instantiation.js";
import { createBotRecipeCatalog } from "../bots/recipe-catalog.js";
import { createBotOperationReconciler } from "../bots/reconciliation.js";
import { createBotOperationsRepository } from "../bots/repositories/operations.js";

export interface BotServices {
  instantiation: BotInstantiation;
  close(): Promise<void>;
}

export async function startBots(options: {
  homePath: string;
  repository: Pick<ChatRepository, "kysely" | "withTransaction">;
  agents: ChatAgentStore;
}): Promise<BotServices | undefined> {
  const db = ownerBotExecutor(options.repository.kysely);
  try {
    await bootstrapBotDatabase(db);
  } catch (error: unknown) {
    console.warn("[bots] bot state unavailable:", error instanceof Error ? error.name : "UnknownError");
    return undefined;
  }
  const instantiation = createBotInstantiation({
    db,
    chats: options.repository,
    agents: options.agents,
    recipes: createBotRecipeCatalog(),
    ensureWorkspace: (botId) => ensureBotWorkspace(options.homePath, botId),
  });
  const reconciler = createBotOperationReconciler({ operations: createBotOperationsRepository(db), instantiation });
  await reconciler.start();
  return {
    instantiation,
    close: () => reconciler.stop(),
  };
}
