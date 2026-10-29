import { RoutineAuthorizationSchema, routineApprovalDigest, routineSelection, hasLiveRoutineChat, type RoutineAuthorization } from "./routine-authorization.js";
import { z } from "zod/v4";
import { BotRoutineProposalSchema, type BotRoutineProposal } from "@matrix-os/contracts";
import type { OwnerBotDatabase } from "./database.js";
import type { Kysely } from "kysely";
import type { BotStateTransaction, BotStateTransactions } from "./events.js";
import type { BotRuntimeBinding } from "./runtime-registry.js";
import type { ChatGptPlanAuthority } from "./chatgpt-plan.js";
import type { BotInteractionRecord } from "./repositories/interactions.js";
import { createBotInteractionsRepository } from "./repositories/interactions.js";
import { createBotApprovalsRepository } from "./repositories/approvals.js";
import { createBotTasksRepository } from "./repositories/tasks.js";
import { createBotRoutinesRepository, type BotRoutine } from "./repositories/routines.js";
import { BotStateError, type BotExecutor } from "./repositories/shared.js";
import { nextBotRoutineFire } from "./routine-schedule.js";
const EnvelopeSchema = z.object({
  proposal: BotRoutineProposalSchema,
  source: RoutineAuthorizationSchema
}).strict();
/** Approval activates only a standing routine; existing per-action account/effect approvals still apply. */
export function createBotRoutineApprovals(deps: {
  db: Kysely<OwnerBotDatabase>;
  transact: BotStateTransactions;
  source?: Pick<ChatGptPlanAuthority, "resolve">;
  definitionRevision(ownerId: string, botId: string): Promise<number>;
  now?: () => Date;
}) {
  const now = () => deps.now?.() ?? new Date();
  async function sourceMatches(ownerId: string, proposal: BotRoutineProposal, source: RoutineAuthorization): Promise<boolean> {
    if (!deps.source) return false;
    try {
      const resolved = await deps.source.resolve(routineSelection(proposal, source), ownerId, "background"),
        b = resolved.subscription;
      return resolved.accessSourceId === "matrix_chatgpt_plan" && resolved.route.modelId === proposal.selection.model && Boolean(b && b.accountId === source.accountId && b.grantRevision === source.grantRevision && b.computerId === source.computerId);
    } catch (error: unknown) {
      console.warn("[bots] routine source unavailable", error instanceof Error ? error.name : "UnknownError");
      return false;
    }
  }
  return {
    async propose(binding: BotRuntimeBinding, raw: unknown) {
      const proposal = BotRoutineProposalSchema.parse(raw);
      if (binding.requestClass !== "interactive" || binding.accessSourceId !== "matrix_chatgpt_plan" || !binding.subscription || proposal.selection.model !== binding.route.modelId) throw new BotStateError("invalid_input");
      const source = RoutineAuthorizationSchema.parse({
        accountId: binding.subscription.accountId,
        computerId: binding.subscription.computerId,
        grantRevision: binding.subscription.grantRevision,
        definitionRevision: await deps.definitionRevision(binding.ownerId, binding.botId)
      });
      if (!(await sourceMatches(binding.ownerId, proposal, source))) throw new BotStateError("invalid_input");
      const preview = JSON.stringify({
        proposal,
        source
      });
      if (preview.length > 4096) throw new BotStateError("too_large");
      const at = now().toISOString(),
        expiresAt = new Date(Date.parse(at) + 86400000).toISOString();
      return deps.transact(binding.ownerId, async tx => {
        if (!(await hasLiveRoutineChat(tx.db, binding.ownerId, binding.botId, binding.chatId))) throw new BotStateError("not_found");
        const task = await createBotTasksRepository(tx.db).get({
          ownerId: binding.ownerId,
          taskId: binding.taskId
        }, tx.db);
        if (!task || task.botId !== binding.botId || task.chatId !== binding.chatId || task.runId !== binding.runId || task.status !== "running") throw new BotStateError("not_found");
        const argsHash = routineApprovalDigest(proposal, source),
          policyRevision = source.grantRevision;
        const {
          interaction
        } = await createBotInteractionsRepository(tx.db).create({
          ownerId: binding.ownerId,
          botId: binding.botId,
          chatId: binding.chatId,
          taskId: binding.taskId,
          kind: "approval",
          payload: {
            kind: "approval",
            tool: "routine.activate",
            argsDigest: argsHash,
            audience: "direct",
            preview,
            policyRevision
          },
          responderActorId: binding.ownerId,
          blocking: true,
          expiresAt,
          now: at
        }, tx.db);
        await createBotApprovalsRepository(tx.db).create({
          ownerId: binding.ownerId,
          approvalId: interaction.interactionId,
          botId: binding.botId,
          taskId: binding.taskId,
          runId: binding.runId,
          tool: "routine.activate",
          argsHash,
          account: source.accountId,
          audience: "direct",
          policyRevision,
          expiresAt,
          now: at
        }, tx.db);
        await tx.publish(binding.chatId, "interaction.requested", {
          interactionId: interaction.interactionId,
          chatId: binding.chatId,
          agentId: binding.botId,
          kind: "approval",
          blocking: true,
          expiresAt,
          revision: interaction.revision
        });
        return {
          interactionId: interaction.interactionId,
          status: "pending" as const
        };
      });
    },
    async decide(tx: BotStateTransaction, interaction: BotInteractionRecord, decision: "approve" | "deny") {
      const payload = interaction.payload as Record<string, unknown>;
      if (payload.tool !== "routine.activate" || payload.audience !== "direct" || typeof payload.preview !== "string") throw new BotStateError("invalid_input");
      const {
        proposal,
        source
      } = EnvelopeSchema.parse(JSON.parse(payload.preview));
      const argsHash = routineApprovalDigest(proposal, source),
        approvals = createBotApprovalsRepository(tx.db),
        approval = await approvals.get({
          ownerId: interaction.ownerId,
          approvalId: interaction.interactionId
        }, tx.db);
      if (!approval || approval.botId !== interaction.botId || approval.taskId !== interaction.taskId || approval.tool !== "routine.activate" || approval.argsHash !== argsHash || payload.argsDigest !== argsHash || approval.account !== source.accountId || approval.audience !== "direct" || approval.policyRevision !== source.grantRevision || payload.policyRevision !== source.grantRevision) throw new BotStateError("invalid_input");
      const at = now().toISOString();
      await approvals.decide({
        ownerId: interaction.ownerId,
        approvalId: approval.approvalId,
        baseRevision: approval.revision,
        decision: decision === "approve" ? "approved" : "denied",
        now: at
      }, tx.db);
      if (decision === "deny") return "The routine was not activated.";
      const claimed = await approvals.claim({
        ownerId: interaction.ownerId,
        approvalId: approval.approvalId,
        taskId: interaction.taskId,
        tool: "routine.activate",
        argsHash,
        account: source.accountId,
        audience: "direct",
        policyRevision: source.grantRevision,
        now: at
      }, tx.db);
      if (claimed.status !== "claimed") throw new BotStateError("invalid_transition");
      const nextFireAt = nextBotRoutineFire(proposal.schedule, at);
      if (!nextFireAt) throw new BotStateError("invalid_input");
      const routine = await createBotRoutinesRepository(tx.db).create({
        ownerId: interaction.ownerId,
        botId: interaction.botId,
        chatId: interaction.chatId,
        proposal,
        authorization: source,
        approvalId: approval.approvalId,
        nextFireAt,
        now: at
      }, tx.db);
      await tx.publish(interaction.chatId, "bot.authority.changed", {
        agentId: interaction.botId,
        revision: routine.revision
      });
      return `Routine activated: ${proposal.name}. Next run: ${routine.nextFireAt}.`;
    },
    async authorize(routine: BotRoutine, executor: BotExecutor = deps.db): Promise<boolean> {
      const source = routine.authorization;
      if (!source || !routine.approvalId || routine.status !== "active") return false;
      if (!(await hasLiveRoutineChat(executor, routine.ownerId, routine.botId, routine.chatId))) return false;
      const approval = await createBotApprovalsRepository(executor).get({
        ownerId: routine.ownerId,
        approvalId: routine.approvalId
      });
      if (!approval || approval.status !== "approved" || !approval.claimedAt || approval.botId !== routine.botId || approval.tool !== "routine.activate" || approval.argsHash !== routineApprovalDigest(routine.proposal, source) || approval.account !== source.accountId || approval.policyRevision !== source.grantRevision || approval.audience !== "direct") return false;
      if ((await deps.definitionRevision(routine.ownerId, routine.botId)) !== source.definitionRevision) return false;
      return sourceMatches(routine.ownerId, routine.proposal, source);
    }
  };
}
export type BotRoutineApprovals = ReturnType<typeof createBotRoutineApprovals>;
