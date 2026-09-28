/**
 * What an owner's answer to an account choice or an approval does (spec
 * 536). Choosing an account grants it to the bot for the effects its recipe
 * declares for that service, in the bot's direct audience. Deciding an
 * approval records the decision on the exact action it binds. Each runs in
 * the transaction that resolves the interaction and returns the text the
 * bot's continuation carries.
 */
import type { BotStateTransaction } from "./events.js";
import { BotInteractionError, type BotInteractionHandlers } from "./interactions.js";
import type { BotIntegrationTools } from "./integration-tools.js";
import { createBotApprovalsRepository } from "./repositories/approvals.js";
import { createBotGrantsRepository, type BotGrantRecord } from "./repositories/grants.js";
import type { BotInteractionRecord } from "./repositories/interactions.js";
import { BotStateError } from "./repositories/shared.js";

const AUDIENCE = "direct";

type AccountChoicePayload = { kind: "account_choice"; service: string; options: Array<{ connectionId: string; label: string }> };
type ApprovalPayload = { kind: "approval"; preview: string };

export function createBotAccessHandlers(deps: {
  tools: Pick<BotIntegrationTools, "declaredEffects">;
  now?: () => Date;
}): Omit<BotInteractionHandlers, "startConnect"> {
  const now = () => (deps.now?.() ?? new Date()).toISOString();

  return {
    async chooseAccount(tx: BotStateTransaction, interaction: BotInteractionRecord, connectionId: string, responderId: string) {
      const payload = interaction.payload as AccountChoicePayload;
      const option = payload.options.find((candidate) => candidate.connectionId === connectionId);
      if (!option) throw new BotInteractionError("invalid_request");
      const effects = await deps.tools.declaredEffects(interaction.ownerId, interaction.botId, payload.service);
      if (effects.length === 0) throw new BotInteractionError("invalid_request");
      let grant: BotGrantRecord;
      try {
        ({ grant } = await createBotGrantsRepository(tx.db).grant({
          ownerId: interaction.ownerId, botId: interaction.botId, service: payload.service, connectionId,
          accountLabel: option.label, effects, audience: AUDIENCE, grantedByActorId: responderId, now: now(),
        }, tx.db));
      } catch (error: unknown) {
        // A live grant of this account with other effects was changed elsewhere; ask the owner to refresh.
        if (error instanceof BotStateError && error.code === "conflict") throw new BotInteractionError("conflict");
        throw error;
      }
      await tx.publish(interaction.chatId, "bot.authority.changed", { agentId: interaction.botId, revision: grant.revision });
      return `Use account "${option.label}". Its access is now available to you.`;
    },

    async decideApproval(tx: BotStateTransaction, interaction: BotInteractionRecord, decision: "approve" | "deny") {
      const approvals = createBotApprovalsRepository(tx.db);
      const approval = await approvals.get({ ownerId: interaction.ownerId, approvalId: interaction.interactionId }, tx.db);
      if (!approval || approval.status !== "pending") throw new BotInteractionError("conflict");
      try {
        await approvals.decide({
          ownerId: interaction.ownerId, approvalId: approval.approvalId, baseRevision: approval.revision,
          decision: decision === "approve" ? "approved" : "denied", now: now(),
        }, tx.db);
      } catch (error: unknown) {
        if (error instanceof BotStateError) throw new BotInteractionError("conflict");
        throw error;
      }
      const preview = (interaction.payload as ApprovalPayload).preview;
      return decision === "approve"
        ? `Approved: ${preview}\nGo ahead with exactly this action now.`
        : `Not approved: ${preview}\nDo not do it. Continue without it.`;
    },
  };
}
