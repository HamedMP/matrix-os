import {createBotRoutinesRepository} from "./repositories/routines.js";
/**
 * The authoritative view of what a bot may do (spec 536,
 * `GET /api/chat-agents/:agentId/authority`). It is read from server state,
 * never from what the bot says: live grants, the state of each service the
 * recipe declares, open requests to the owner, and remembered items. Account
 * labels are the owner-visible ones; external account IDs never appear. If
 * the account inventory is unavailable, services without a live grant are
 * left out rather than reported as not connected.
 */
import { createHash } from "node:crypto";
import {
  BotConnectionStateSchema,
  BotAuthorityViewSchema,
  BotMemoryItemSchema,
  ChatAgentIdSchema,
  type BotAuthorityView,
  type BotConnectionState,
} from "@matrix-os/contracts";
import type { ChatAgentStore } from "../chat/agent-store.js";
import { getService } from "../integrations/registry.js";
import type { BotStateTransactions } from "./events.js";
import { BotIntegrationError, type BotIntegrationClient, type BotIntegrationConnection } from "./integration-client.js";
import type { BotRecipeCatalog } from "./recipe-catalog.js";
import { createBotGrantsRepository } from "./repositories/grants.js";
import { createBotMemoryRepository } from "./repositories/memory.js";

const AUDIENCE = "direct";
const MAX_PENDING = 32;
const MAX_DISPLAY_ACCOUNTS = 10;

export class BotAuthorityError extends Error {
  constructor(readonly code: "invalid_request" | "not_found") {
    super(`Bot authority refused: ${code}`);
    this.name = "BotAuthorityError";
  }
}

export function createBotAuthority(deps: {
  transact: BotStateTransactions;
  agents: Pick<ChatAgentStore, "get">;
  recipes: BotRecipeCatalog;
  resolveProcedure?(ownerId: string, agent: import("@matrix-os/contracts").ChatAgent): Promise<import("./recipe-catalog.js").BotRecipe>;
  client?: BotIntegrationClient;
  now?: () => Date;
}) {
  const now = () => (deps.now?.() ?? new Date()).toISOString();

  async function inventory(ownerId: string): Promise<BotIntegrationConnection[] | undefined> {
    if (!deps.client) return undefined;
    try {
      return await deps.client.inventory(ownerId);
    } catch (error: unknown) {
      if (!(error instanceof BotIntegrationError)) throw error;
      return undefined;
    }
  }

  return {
    async view(ownerId: string, agentIdValue: string): Promise<BotAuthorityView> {
      const agentId = ChatAgentIdSchema.safeParse(agentIdValue);
      if (!agentId.success) throw new BotAuthorityError("invalid_request");
      const agent = await deps.agents.get({ type: "personal", ownerId }, agentId.data);
      if (!agent?.recipeRef) throw new BotAuthorityError("not_found");
      let services: string[] = [];
      try {
        services = (deps.resolveProcedure ? await deps.resolveProcedure(ownerId, agent) : deps.recipes.resolve(agent.recipeRef)).integrations.map((entry) => entry.service);
      } catch (error: unknown) {
        console.warn("[bots] recipe unavailable for authority:", error instanceof Error ? error.name : "UnknownError");
      }
      const at = now();
      const { grants, pending, memory, routines } = await deps.transact(ownerId, async (tx) => ({
        routines: await createBotRoutinesRepository(tx.db).list(ownerId,agentId.data,tx.db),
        grants: await createBotGrantsRepository(tx.db).listLive({ ownerId, botId: agentId.data, audience: AUDIENCE, now: at }, tx.db),
        pending: await tx.db.selectFrom("bot_interactions").select(["interaction_id", "kind", "chat_id", "expires_at"])
          .where("owner_id", "=", ownerId).where("bot_id", "=", agentId.data)
          .where("status", "=", "pending").where("expires_at", ">", at)
          .orderBy("created_at", "asc").limit(MAX_PENDING).execute(),
        memory: await createBotMemoryRepository(tx.db).list({ ownerId, botId: agentId.data, now: at }, tx.db),
      }));
      const connected = await inventory(ownerId);
      const connections = services.flatMap((service): BotConnectionState[] => {
        const definition = getService(service);
        const logoUrl = definition?.logoUrl;
        const display = { service, serviceName: definition?.name ?? service,
          ...(logoUrl && BotConnectionStateSchema.shape.logoUrl.safeParse(logoUrl).success ? { logoUrl } : {}) };
        if (!connected) return grants.some((grant) => grant.service === service)
          ? [{ ...display, state: "granted", accounts: [] }] : [];
        const serviceConnections = connected.filter((connection) => connection.service === service);
        const accountStates = serviceConnections.map((connection) => ({
          displayKey: `acct_${createHash("sha256").update(`${ownerId}\0${service}\0${connection.connectionId}`).digest("hex").slice(0, 24)}`,
          label: connection.label, email: connection.email ?? null,
          state: grants.some((grant) => grant.service === service && grant.connectionId === connection.connectionId
            && grant.accountLabel === connection.label
            && serviceConnections.filter((candidate) => candidate.label === connection.label).length === 1)
            ? "granted" as const : "connected_not_granted" as const,
        }));
        const accounts = [...accountStates.filter((account) => account.state === "granted"),
          ...accountStates.filter((account) => account.state !== "granted")].slice(0, MAX_DISPLAY_ACCOUNTS);
        return [{ ...display, state: accountStates.some((account) => account.state === "granted") ? "granted"
          : accountStates.length ? "connected_not_granted" : "not_connected", accounts }];
      });
      return BotAuthorityViewSchema.parse({
        agentId: agentId.data,
        revision: agent.revision,
        grants: grants.map((grant) => ({
          grantId: grant.grantId, service: grant.service, accountLabel: grant.accountLabel,
          effects: grant.effects, audience: grant.audience, expiresAt: grant.expiresAt,
        })),
        connections,
        routines: routines.filter(r=>r.status!=="archived").map(r=>({routineId:r.routineId,summary:r.proposal.name,status:r.status,nextFireAt:r.nextFireAt})),
        pendingInteractions: pending.map((row) => ({
          interactionId: row.interaction_id, kind: row.kind, chatId: row.chat_id,
          expiresAt: new Date(row.expires_at).toISOString(),
        })),
        memory: {
          items: memory.flatMap((item) => {
            const parsed = BotMemoryItemSchema.safeParse({
              itemId: item.itemId, kind: item.kind, scope: item.scope, content: item.content,
              source: item.source, confirmed: item.confirmed, revision: item.revision,
            });
            return parsed.success ? [parsed.data] : [];
          }),
        },
      });
    },
  };
}

export type BotAuthority = ReturnType<typeof createBotAuthority>;
