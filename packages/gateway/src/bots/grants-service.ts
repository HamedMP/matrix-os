/**
 * Revoking a bot's access to an account (spec 536,
 * `DELETE /api/chat-agents/:agentId/grants/:grantId`). The revocation and its
 * `bot.authority.changed` event commit together; queued and running work
 * rechecks the grant before its next effect, so nothing is cancelled here.
 */
import { BotGrantIdSchema, ChatAgentIdSchema, RevokeBotGrantResponseSchema, type RevokeBotGrantResponse } from "@matrix-os/contracts";
import type { BotStateTransactions } from "./events.js";
import { createBotBindingsRepository } from "./repositories/bindings.js";
import { createBotGrantsRepository } from "./repositories/grants.js";

export class BotGrantError extends Error {
  constructor(readonly code: "invalid_request" | "not_found" | "conflict") {
    super(`Bot grant refused: ${code}`);
    this.name = "BotGrantError";
  }
}

export function createBotGrantService(deps: { transact: BotStateTransactions; now?: () => Date }) {
  const now = () => (deps.now?.() ?? new Date()).toISOString();
  return {
    async revoke(ownerId: string, agentIdValue: string, grantIdValue: string): Promise<RevokeBotGrantResponse> {
      const agentId = ChatAgentIdSchema.safeParse(agentIdValue);
      const grantId = BotGrantIdSchema.safeParse(grantIdValue);
      if (!agentId.success || !grantId.success) throw new BotGrantError("invalid_request");
      const at = now();
      return deps.transact(ownerId, async (tx) => {
        const grant = await tx.db.selectFrom("bot_grants").select(["bot_id", "revision"])
          .where("owner_id", "=", ownerId).where("grant_id", "=", grantId.data).where("revoked_at", "is", null)
          .executeTakeFirst();
        if (!grant || grant.bot_id !== agentId.data) throw new BotGrantError("not_found");
        if (!await createBotGrantsRepository(tx.db).revoke({ ownerId, grantId: grantId.data, now: at }, tx.db)) {
          throw new BotGrantError("conflict");
        }
        const chatId = await createBotBindingsRepository(tx.db).directChatId({ ownerId, botId: agentId.data }, tx.db);
        if (chatId) await tx.publish(chatId, "bot.authority.changed", { agentId: agentId.data, revision: Number(grant.revision) + 1 });
        return RevokeBotGrantResponseSchema.parse({ grantId: grantId.data, revokedAt: at });
      });
    },
  };
}

export type BotGrantService = ReturnType<typeof createBotGrantService>;
