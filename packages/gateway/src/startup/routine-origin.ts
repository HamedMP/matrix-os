import type { ChatRepository } from "../chat/repository.js";
import type { OwnerBotDatabase } from "../bots/database.js";
import type { BotStateTransactions } from "../bots/events.js";
import type { BotInteractionService } from "../bots/interactions.js";
import type { Kysely } from "kysely";
import { createRoutineChatOriginService, type RoutineChatOriginService } from "../bots/routine-chat-origin.js";
import { createRoutineOriginPlatformClient } from "../bots/routine-origin-platform-client.js";
import { createRoutineCreationAdmission } from "../chat/routine-creation-policy.js";

export interface RoutineOriginPlatformConfiguration {
  platformUrl: string; token: string; handle: string; machineId: string; runtimeSlot: string;
}
export interface RoutineOriginStartup {
  routineOrigin?: RoutineChatOriginService;
  routineOriginProofs?: ReturnType<typeof createRoutineOriginPlatformClient>;
  routineOriginMachine?: Pick<RoutineOriginPlatformConfiguration, "handle" | "machineId" | "runtimeSlot">;
  beforeRoutineCreationAdmission?: ReturnType<typeof createRoutineCreationAdmission>;
}

/** Compose existing owner DB and human-proof transport; no new executor or grant. */
export function createRoutineOriginStartup(options: {
  db: Kysely<OwnerBotDatabase>; transact: BotStateTransactions;
  repository: Pick<ChatRepository, "appendRoutineReceipt">;
  interactions: Pick<BotInteractionService, "resolveWithin">;
  computerId?: string; platform?: RoutineOriginPlatformConfiguration; now?: () => Date;
}): RoutineOriginStartup {
  const { computerId, platform } = options;
  if (!computerId || !platform) return {};
  if (typeof options.repository.appendRoutineReceipt !== "function" || typeof options.interactions.resolveWithin !== "function") {
    throw new Error("Routine origin dependencies are unavailable");
  }
  const routineOriginMachine = { handle: platform.handle, machineId: platform.machineId, runtimeSlot: platform.runtimeSlot };
  const routineOriginProofs = createRoutineOriginPlatformClient(platform);
  const beforeRoutineCreationAdmission = createRoutineCreationAdmission({ ...routineOriginMachine,
    verifyCreation: routineOriginProofs.verifyCreation });
  const routineOrigin = createRoutineChatOriginService({ db: options.db, transact: options.transact,
    chats: options.repository, interactions: options.interactions, computerId,
    expectedMachine: routineOriginMachine, now: options.now });
  return { routineOrigin, routineOriginProofs, routineOriginMachine, beforeRoutineCreationAdmission };
}
