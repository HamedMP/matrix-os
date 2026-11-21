import type { Kysely } from "kysely";
import type { ChatAgentStore } from "../chat/agent-store.js";
import type { OwnerBotDatabase } from "./database.js";
import type { RequestPrincipal } from "../request-principal.js";
import { RoutineCliError } from "./routine-cli-errors.js";
import { RoutineCliScopeSchema } from "./repositories/routine-cli-preferences.js";
import { createRoutineCliTargetService } from "./routine-cli-targets.js";
/** Owner navigation only. Startup supplies its actual configured identity; no source/action validator
 * is installed, and no grants or synthetic principal are created. TargetService fences binding/Chat/definition. */
export function createRoutineCliDestinationService(input: { db: Kysely<OwnerBotDatabase>; agents: ChatAgentStore; ownerId?: string | null; computerId?: string | null; configuredOwnerIds?: readonly string[] }) {
  if (!input.db || typeof input.db.transaction !== "function" || !input.agents || typeof input.agents.get !== "function") throw new Error("Routine destination dependencies unavailable");
  const scope = RoutineCliScopeSchema.safeParse({ ownerId: input.ownerId, computerId: input.computerId });
  if (!scope.success) return null;
  const configured = input.configuredOwnerIds ?? [scope.data.ownerId];
  if (!Array.isArray(configured) || configured.length < 1 || configured.length > 2
    || configured.some(ownerId => !RoutineCliScopeSchema.shape.ownerId.safeParse(ownerId).success)
    || !configured.includes(scope.data.ownerId)) return null;
  // At most two captured configured identities, not aliases to rewrite/merge. Existing Bot routes
  // persist the actual principal.userId, so each identity retains its own owner+Computer row.
  const services = configured.filter((ownerId, index) => configured.indexOf(ownerId) === index).map(ownerId => {
    const ownerScope = { ...scope.data, ownerId };
    return { ownerId, service: createRoutineCliTargetService({ db: input.db, agents: input.agents, scope: ownerScope,
      canAccessTarget: async (target, trx) => target.ownerId === ownerId && target.computerId === ownerScope.computerId && Boolean(await trx.selectFrom("chats").select("id")
        .where("id", "=", target.chatId).where("owner_id", "=", ownerId).where("owner_type", "=", "personal").where("lifecycle", "=", "active").where("collaboration", "is", null).executeTakeFirst()),
    }) };
  });
  const serviceFor = (principal: RequestPrincipal) => {
    const selected = services.find(entry => entry.ownerId === principal.userId);
    if (!selected) throw new RoutineCliError("permission_denied");
    return selected.service;
  };
  return {
    getOwnerView: async (principal: RequestPrincipal) => serviceFor(principal).getOwnerView(principal),
    remember: async (principal: RequestPrincipal, value: Parameters<ReturnType<typeof createRoutineCliTargetService>["remember"]>[1]) => serviceFor(principal).remember(principal, value),
    reset: async (principal: RequestPrincipal, value: Parameters<ReturnType<typeof createRoutineCliTargetService>["reset"]>[1]) => serviceFor(principal).reset(principal, value),
  };
}
