import { CanonicalChatIdSchema, CanonicalChatRunActivitySchema, CanonicalOwnerScopeSchema, type CanonicalChatRunActivity } from "@matrix-os/contracts";
import { sql } from "kysely";
import { assertInputClaim, getChatInputState, pendingInputTransition } from "./input-submission.js";
import { ChatConflictError, ChatNotFoundError, ChatRunNotActiveError } from "./errors.js";
import { jsonb, type ChatOwner } from "./records.js";
import type { AssistantDeltaDependencies, AssistantDeltaExecutor as Executor } from "./assistant-delta-repository.js";
import type { ChatActivityWriteHook } from "./activity-write-hook.js";
export interface ActivityWriteDependencies extends Omit<AssistantDeltaDependencies, 'hook'> { hook?: ChatActivityWriteHook }
const ACTIVE_RUNS = ["accepted", "running", "waiting_for_approval", "waiting_for_input"] as const;
const validateOwner = (owner: ChatOwner) => CanonicalOwnerScopeSchema.parse(owner);
function isTerminalActivity(activity: CanonicalChatRunActivity): boolean {
  return activity.type === "run.error"
    || (activity.type === "run.status"
      && ["completed", "failed", "aborted"].includes(activity.status));
}

function isRetentionProtectedActivity(
  activity: CanonicalChatRunActivity,
  resolvedApprovalIds: readonly string[],
): boolean {
  return isTerminalActivity(activity)
    || (activity.type === "approval.requested" && !resolvedApprovalIds.includes(activity.approvalId));
}

function railTransitionForActivity(activity: CanonicalChatRunActivity): {
  runStatus: "running" | "waiting_for_approval" | "waiting_for_input";
  attention: "none" | "approval_required" | "input_required";
} | undefined {
  switch (activity.type) {
    case "approval.requested":
      return { runStatus: "waiting_for_approval", attention: "approval_required" };
    case "input.requested":
      return { runStatus: activity.asynchronous ? "running" : "waiting_for_input", attention: "input_required" };
    case "approval.resolved":
    case "input.resolved":
      return { runStatus: "running", attention: "none" };
    default:
      return undefined;
  }
}

function canTransitionAgentActivity(
  current: Extract<CanonicalChatRunActivity, { type: "agent.activity" }>,
  next: Extract<CanonicalChatRunActivity, { type: "agent.activity" }>,
): boolean {
  if (current.activityId !== next.activityId || current.kind !== next.kind || current.label !== next.label) return false;
  if (current.status === "running") return true;
  if (current.status === "partial") {
    return ["partial", "completed", "failed", "cancelled"].includes(next.status);
  }
  return current.status === next.status;
}

export async function appendRunActivities(deps: ActivityWriteDependencies,
    ownerInput: ChatOwner,
    chatId: string,
    runId: string,
    input: CanonicalChatRunActivity[],
    expectedInputClaim?: { requestId: string; submissionId: string },
    signal?: AbortSignal,
  ): Promise<number> {
    const owner = validateOwner(ownerInput);
    if (input.length > 100) throw new ChatConflictError(chatId, 0);
    const activities = input.map((activity) => CanonicalChatRunActivitySchema.parse(activity));
    if (activities.some((activity) => activity.chatId !== chatId || activity.runId !== runId)) {
      throw new ChatConflictError(chatId, 0);
    }
    if (activities.length === 0) return 0;
    expectedInputClaim = expectedInputClaim ? Object.freeze({ ...expectedInputClaim }) : undefined;
    const content = async (trx: Executor) => {
      const current = await deps.selectOwnedChat(trx, owner, CanonicalChatIdSchema.parse(chatId), true);
      if (!current) throw new ChatNotFoundError(chatId);
      const run = await trx.selectFrom("chat_runs").select("id")
        .where("id", "=", runId).where("chat_id", "=", chatId)
        .where("status", "in", [...ACTIVE_RUNS]).executeTakeFirst();
      const existingRun = run ?? await trx.selectFrom("chat_runs").select("id")
        .where("id", "=", runId).where("chat_id", "=", chatId).executeTakeFirst();
      if (existingRun && !run) throw new ChatRunNotActiveError(chatId, runId);
      if (!run) throw new ChatNotFoundError(chatId);
      if (expectedInputClaim) {
        const state = await getChatInputState(trx, owner, { chatId, runId, requestId: expectedInputClaim.requestId });
        if (state.resolved || state.submitted?.id !== expectedInputClaim.submissionId) throw new ChatConflictError(chatId, Number(current.revision));
      }
      const count = await trx.selectFrom("chat_run_events").select(({ fn }) => fn.countAll().as("count"))
        .where("run_id", "=", runId).executeTakeFirstOrThrow();
      const activityIds = [...new Set(activities.map((activity) => activity.id))];
      const existing = await trx.selectFrom("chat_run_events").select(["id", "chat_id", "run_id", "run_seq", "event"])
        .where("id", "in", activityIds).execute();
      if (existing.some((row) => row.chat_id !== chatId || row.run_id !== runId)) {
        throw new ChatConflictError(chatId, Number(current.revision));
      }
      const unseenCount = activityIds.length - existing.length;
      const overflow = Number(count.count) + unseenCount - 500;
      let removedActivityIds: string[] = [];
      if (overflow > 0) {
        if (!activities.some(isTerminalActivity)) {
          throw new ChatConflictError(chatId, Number(current.revision));
        }
        const candidates = await trx.selectFrom("chat_run_events")
          .select(["id", "event"])
          .where("run_id", "=", runId)
          .orderBy("occurred_at")
          .orderBy("run_seq")
          .orderBy("id")
          .execute();
        const parsedCandidates = candidates.map((row) => ({
          id: row.id,
          activity: CanonicalChatRunActivitySchema.safeParse(row.event),
        }));
        // Bounded by the 500 persisted events plus at most 100 incoming events.
        const resolvedApprovalIds = activities.flatMap((activity) =>
          activity.type === "approval.resolved" ? [activity.approvalId] : []);
        const requestedApprovalIds = parsedCandidates.flatMap(({ activity }) =>
          activity.success && activity.data.type === "approval.requested" ? [activity.data.approvalId] : []);
        for (const { activity } of parsedCandidates) {
          if (activity.success && activity.data.type === "approval.resolved"
            && !resolvedApprovalIds.includes(activity.data.approvalId)) {
            resolvedApprovalIds.push(activity.data.approvalId);
          }
        }
        if (requestedApprovalIds.length > 0) {
          const outcomes = await trx.selectFrom("chat_approval_outcomes")
            .select("approval_id")
            .where("run_id", "=", runId)
            .where("approval_id", "in", requestedApprovalIds)
            .execute();
          for (const outcome of outcomes) {
            if (!resolvedApprovalIds.includes(outcome.approval_id)) {
              resolvedApprovalIds.push(outcome.approval_id);
            }
          }
        }
        const evictedIds = parsedCandidates.flatMap(({ id, activity }) => {
          return activity.success && !isRetentionProtectedActivity(activity.data, resolvedApprovalIds) ? [id] : [];
        }).slice(0, overflow);
        if (evictedIds.length !== overflow) {
          throw new ChatConflictError(chatId, Number(current.revision));
        }
        await trx.deleteFrom("chat_run_events").where("id", "in", evictedIds).execute();
        removedActivityIds = evictedIds;
      }
      const latestSequence = await trx.selectFrom("chat_run_events")
        .select(({ fn }) => fn.max("run_seq").as("sequence"))
        .where("run_id", "=", runId)
        .executeTakeFirst();
      const existingIds = new Set(existing.map((row) => row.id));
      const existingById = new Map(existing.map((row) => [row.id, row]));
      let nextSequence = Number(latestSequence?.sequence ?? 0);
      let changed = 0;
      let railTransition: ReturnType<typeof railTransitionForActivity>;
      for (const activity of activities) {
        if (existingIds.has(activity.id)) {
          const row = existingById.get(activity.id);
          if (!row) throw new ChatConflictError(chatId, Number(current.revision));
          const persisted = CanonicalChatRunActivitySchema.parse(row.event);
          if (activity.type === "approval.resolved") {
            if (persisted.type !== "approval.resolved"
              || persisted.approvalId !== activity.approvalId
              || persisted.decision !== activity.decision) {
              throw new ChatConflictError(chatId, Number(current.revision));
            }
            await persistApprovalOutcome(trx, persisted, Number(current.revision));
          }
          if (persisted.type !== "agent.activity" || activity.type !== "agent.activity") continue;
          if (!canTransitionAgentActivity(persisted, activity)) {
            throw new ChatConflictError(chatId, Number(current.revision));
          }
          const updated = CanonicalChatRunActivitySchema.parse({
            ...activity,
            sequence: Number(row.run_seq ?? persisted.sequence),
            occurredAt: persisted.occurredAt,
          });
          if (JSON.stringify(updated) === JSON.stringify(persisted)) continue;
          await trx.updateTable("chat_run_events").set({ event: jsonb(updated) })
            .where("id", "=", activity.id)
            .where("chat_id", "=", chatId)
            .where("run_id", "=", runId)
            .execute();
          changed += 1;
          continue;
        }
        await assertInputClaim(trx, owner, activity);
        nextSequence += 1;
        const sequenced = CanonicalChatRunActivitySchema.parse({
          ...activity,
          sequence: nextSequence,
        });
        const row = await trx.insertInto("chat_run_events").values({
          id: sequenced.id,
          chat_id: chatId,
          run_id: runId,
          run_seq: nextSequence,
          event: jsonb(sequenced),
          occurred_at: sequenced.occurredAt,
        }).onConflict((oc) => oc.column("id").doNothing()).returning("id").executeTakeFirst();
        if (row) {
          if (sequenced.type === "approval.resolved") {
            await persistApprovalOutcome(trx, sequenced, Number(current.revision));
          }
          changed += 1;
          railTransition = railTransitionForActivity(sequenced) ?? railTransition;
          if (sequenced.type === "terminal.bound") {
            await trx.insertInto("chat_terminal_bindings").values({
              chat_id: chatId,
              session_id: sequenced.terminalSessionId,
              session_created_at: sequenced.terminalSessionCreatedAt,
              run_id: runId,
              bound_at: sequenced.occurredAt,
            }).onConflict((conflict) => conflict.columns(["chat_id", "session_id"]).doUpdateSet({
              run_id: runId,
              session_created_at: sequenced.terminalSessionCreatedAt,
            })).execute();
          }
        }
      }
      if (changed > 0) {
        const revision = Number(current.revision) + 1;
        if (railTransition) {
          if (activities.some(activity => activity.type === "input.resolved" || activity.type === "approval.resolved")) railTransition = await pendingInputTransition(trx, runId);
          await trx.updateTable("chat_runs").set({
            status: railTransition.runStatus,
            updated_at: sql`now()`,
          }).where("id", "=", runId).where("status", "in", [...ACTIVE_RUNS]).execute();
        }
        await trx.updateTable("chats").set({
          revision,
          ...(railTransition ? { attention: railTransition.attention } : {}),
          updated_at: sql`now()`,
        }).where("id", "=", chatId).execute();
        await deps.appendOutbox(trx, owner, chatId, revision, "run.activity", { runId, activityIds, removedActivityIds });
      }
      return changed;
     };
    return deps.hook ? deps.hook.write({ owner, chatId, runId, activityIds: activities.map(activity => activity.id) }, deps.transact, content, signal) : deps.transact(content);
}
async function persistApprovalOutcome(
  trx: Executor,
  activity: Extract<CanonicalChatRunActivity, { type: "approval.resolved" }>,
  latestRevision: number,
): Promise<void> {
  await trx.insertInto("chat_approval_outcomes").values({
    run_id: activity.runId,
    approval_id: activity.approvalId,
    chat_id: activity.chatId,
    decision: activity.decision,
    activity_id: activity.id,
    resolved_at: activity.occurredAt,
  }).onConflict((conflict) => conflict.columns(["run_id", "approval_id"]).doNothing()).execute();
  const outcome = await trx.selectFrom("chat_approval_outcomes")
    .select(["chat_id", "decision"])
    .where("run_id", "=", activity.runId)
    .where("approval_id", "=", activity.approvalId)
    .executeTakeFirstOrThrow();
  if (outcome.chat_id !== activity.chatId || outcome.decision !== activity.decision) {
    throw new ChatConflictError(activity.chatId, latestRevision);
  }
}
