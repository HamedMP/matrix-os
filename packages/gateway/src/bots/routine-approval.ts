import { RoutineAuthorizationSchema, routineApprovalDigest, routineSelection, hasLiveRoutineChat, type RoutineAuthorization } from "./routine-authorization.js";
import { z } from "zod/v4";
import { BOT_ROUTINE_APPROVAL_PREVIEW_LIMIT, BotRoutineProposalSchema, BotRoutineEditRequestSchema, type BotRoutineProposal } from "@matrix-os/contracts";
import type { OwnerBotDatabase } from "./database.js";
import { sql, type Kysely } from "kysely";
import { projectBotInteraction } from "./interactions.js";
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
  async function definitionRevision(ownerId: string, botId: string): Promise<number | null> {
    try { return await deps.definitionRevision(ownerId, botId); }
    catch (error: unknown) {
      if (error instanceof BotStateError && error.code === "not_found") return null;
      throw error;
    }
  }
  async function sourceMatches(ownerId: string, proposal: BotRoutineProposal, source: RoutineAuthorization): Promise<boolean> {
    if (!deps.source) return false;
    try {
      const resolved = await deps.source.resolve(routineSelection(proposal, source), ownerId, "routine"),
        b = resolved.subscription;
      return resolved.accessSourceId === "matrix_chatgpt_plan" && resolved.route.modelId === proposal.selection.model && Boolean(b && b.accountId === source.accountId && b.grantRevision === source.grantRevision && b.computerId === source.computerId);
    } catch (error: unknown) {
      console.warn("[bots] routine source unavailable", error instanceof Error ? error.name : "UnknownError");
      return false;
    }
  }
  async function proposeWithin(tx: BotStateTransaction, binding: BotRuntimeBinding, raw: unknown) {
    if (!tx.db.isTransaction) throw new BotStateError("invalid_input");
    const proposal = BotRoutineProposalSchema.parse(raw);
    if (binding.requestClass !== "interactive" || binding.accessSourceId !== "matrix_chatgpt_plan" || !binding.subscription || proposal.selection.model !== binding.route.modelId) throw new BotStateError("invalid_input");
    const source = RoutineAuthorizationSchema.parse({
      accountId: binding.subscription.accountId,
      computerId: binding.subscription.computerId,
      grantRevision: binding.subscription.grantRevision,
      definitionRevision: await definitionRevision(binding.ownerId, binding.botId)
    });
    if (!(await sourceMatches(binding.ownerId, proposal, source))) throw new BotStateError("invalid_input");
    const preview = JSON.stringify({
      proposal,
      source
    });
    if (preview.length > BOT_ROUTINE_APPROVAL_PREVIEW_LIMIT || Buffer.byteLength(preview) > BOT_ROUTINE_APPROVAL_PREVIEW_LIMIT) throw new BotStateError("too_large");
    const at = now().toISOString(),
      expiresAt = new Date(Date.parse(at) + 86400000).toISOString();
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
        sourceRunId: binding.runId,
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
      if (await definitionRevision(binding.ownerId, binding.botId) !== source.definitionRevision
        || !await sourceMatches(binding.ownerId, proposal, source)) throw new BotStateError("invalid_input");
      return { interactionId: interaction.interactionId, status: "pending" as const };
  }
  async function authorize(routine: BotRoutine, executor: BotExecutor = deps.db): Promise<boolean> {
    const source = routine.authorization;
    if (!source || !routine.approvalId || routine.status !== "active" || source.routineId && source.routineId !== routine.routineId) return false;
    if (!(await hasLiveRoutineChat(executor, routine.ownerId, routine.botId, routine.chatId))) return false;
    const approval = await createBotApprovalsRepository(executor).get({ ownerId: routine.ownerId, approvalId: routine.approvalId });
    if (!approval || approval.status !== "approved" || !approval.claimedAt || approval.botId !== routine.botId || approval.tool !== "routine.activate"
      || approval.argsHash !== routineApprovalDigest(routine.proposal, source) || approval.account !== source.accountId
      || approval.policyRevision !== source.grantRevision || approval.audience !== "direct") return false;
    if ((await definitionRevision(routine.ownerId, routine.botId)) !== source.definitionRevision) return false;
    return sourceMatches(routine.ownerId, routine.proposal, source);
  }
  return {
    authorize,
    targetAvailable: async (ownerId: string, botId: string, chatId: string) => await hasLiveRoutineChat(deps.db, ownerId, botId, chatId) && await definitionRevision(ownerId, botId) !== null,
    async requestEdit(ownerId: string, routineId: string, raw: unknown) {
      const input = BotRoutineEditRequestSchema.parse(raw), repository = createBotRoutinesRepository(deps.db);
      const existing = await repository.get(ownerId, routineId);
      if (!existing) throw new BotStateError("not_found");
      if (existing.revision !== input.baseRevision) throw new BotStateError("revision_conflict");
      if (existing.status === "archived" || !existing.authorization || !existing.approvalId) throw new BotStateError("invalid_transition");
      if (!(await authorize({ ...existing, status: "active" }))) throw new BotStateError("invalid_input");
      const proposal = BotRoutineProposalSchema.parse({ ...existing.proposal, name: input.name, prompt: input.prompt, schedule: input.schedule });
      const source = RoutineAuthorizationSchema.parse({ ...existing.authorization, routineId, baseRoutineRevision: input.baseRevision });
      const preview = JSON.stringify({ proposal, source }), argsHash = routineApprovalDigest(proposal, source), at = now().toISOString();
      if (preview.length > BOT_ROUTINE_APPROVAL_PREVIEW_LIMIT || Buffer.byteLength(preview) > BOT_ROUTINE_APPROVAL_PREVIEW_LIMIT) throw new BotStateError("too_large");
      return deps.transact(ownerId, async tx => {
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'routine-edit:' + ownerId + ':' + routineId},0))`.execute(tx.db);
        const current = await repository.get(ownerId, routineId, tx.db);
        if (!current || current.revision !== input.baseRevision || current.approvalId !== existing.approvalId || current.status === "archived") throw new BotStateError("revision_conflict");
        const candidates = await tx.db.selectFrom("bot_interactions").select(["interaction_id", "payload"])
          .where("owner_id", "=", ownerId).where("status", "=", "pending").where("expires_at", ">", at)
          .where(sql<boolean>`payload->>'tool' = 'routine.activate'`).limit(32).execute();
        const interactions = createBotInteractionsRepository(tx.db), approvals = createBotApprovalsRepository(tx.db);
        for (const candidate of candidates) {
          const record = await interactions.get({ ownerId, interactionId: candidate.interaction_id });
          if (!record || typeof record.payload.preview !== "string") continue;
          let value: unknown;
          try { value = JSON.parse(record.payload.preview); }
          catch (error: unknown) { if (error instanceof SyntaxError) continue; throw error; }
          const parsed = EnvelopeSchema.safeParse(value);
          if (!parsed.success || parsed.data.source.routineId !== routineId) continue;
          if (record.payload.argsDigest !== argsHash) throw new BotStateError("conflict");
          return { interaction: projectBotInteraction(record, ownerId) };
        }
        const previousApproval = await approvals.get({ ownerId, approvalId: existing.approvalId! });
        if (!previousApproval) throw new BotStateError("not_found");
        const expiresAt = new Date(Date.parse(at) + 86400000).toISOString();
        const { interaction } = await interactions.create({ ownerId, botId: existing.botId, chatId: existing.chatId,
          taskId: previousApproval.taskId, kind: "approval", responderActorId: ownerId, blocking: false, expiresAt, now: at,
          payload: { kind: "approval", tool: "routine.activate", preview, argsDigest: argsHash, audience: "direct", policyRevision: source.grantRevision } });
        await approvals.create({ ownerId, botId: existing.botId, approvalId: interaction.interactionId,
          taskId: previousApproval.taskId, runId: previousApproval.runId, tool: "routine.activate", argsHash, account: source.accountId,
          audience: "direct", policyRevision: source.grantRevision, expiresAt, now: at });
        await tx.publish(existing.chatId, "interaction.requested", { interactionId: interaction.interactionId, chatId: existing.chatId,
          agentId: existing.botId, kind: "approval", blocking: false, expiresAt, revision: interaction.revision });
        return { interaction: projectBotInteraction(interaction, ownerId) };
      });
    },
    proposeWithin,
    async propose(binding: BotRuntimeBinding, raw: unknown) {
      return deps.transact(binding.ownerId, tx => proposeWithin(tx, binding, raw));
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
      // Registry/source reads do not perform provider I/O. A stale proposal must
      // fail at confirmation, not appear active until its first occurrence fails.
      if (decision === "approve" && ((await definitionRevision(interaction.ownerId, interaction.botId)) !== source.definitionRevision
        || !(await hasLiveRoutineChat(tx.db, interaction.ownerId, interaction.botId, interaction.chatId))
        || !(await sourceMatches(interaction.ownerId, proposal, source)))) throw new BotStateError("invalid_input");
      const at = now().toISOString();
      await approvals.decide({
        ownerId: interaction.ownerId,
        approvalId: approval.approvalId,
        baseRevision: approval.revision,
        decision: decision === "approve" ? "approved" : "denied",
        now: at
      }, tx.db);
      if (decision === "deny") return source.routineId ? "The schedule changes were not applied. The existing schedule is unchanged." : "The routine was not activated.";
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
      const repository = createBotRoutinesRepository(tx.db);
      const data = {
        ownerId: interaction.ownerId,
        botId: interaction.botId,
        chatId: interaction.chatId,
        proposal,
        authorization: source,
        approvalId: approval.approvalId,
        nextFireAt,
        now: at
      };
      const routine = source.routineId && source.baseRoutineRevision ? await repository.revise({ ...data,
        routineId: source.routineId, baseRevision: source.baseRoutineRevision }, tx.db) : await repository.create(data, tx.db);
      await tx.publish(interaction.chatId, "bot.authority.changed", {
        agentId: interaction.botId,
        revision: routine.revision
      });
      return `Routine ${source.routineId ? "updated" : "activated"}: ${proposal.name}. Status: ${routine.status}. Next run: ${routine.nextFireAt}.`;
    },
  };
}
export type BotRoutineApprovals = ReturnType<typeof createBotRoutineApprovals>;
