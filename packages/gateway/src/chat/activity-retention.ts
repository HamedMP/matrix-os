import { CanonicalChatRunActivitySchema, type CanonicalChatRunActivity } from "@matrix-os/contracts";
import type { Kysely, Transaction } from "kysely";
import type { ChatDatabase } from "./database.js";
import { ChatConflictError } from "./errors.js";

const MAX_RUN_ACTIVITIES = 500;
type Candidate = { id: string; event: unknown };

function controlKey(activity: CanonicalChatRunActivity): string | undefined {
  if (activity.type === "approval.requested" || activity.type === "approval.resolved") return `approval:${activity.approvalId}`;
  if (activity.type === "input.requested" || activity.type === "input.submitted" || activity.type === "input.resolved") return `input:${activity.requestId}`;
  return undefined;
}
function isTerminal(activity: CanonicalChatRunActivity): boolean {
  return activity.type === "run.error" || (activity.type === "run.status" && ["completed", "failed", "aborted"].includes(activity.status));
}

/** The input is bounded by 500 retained rows and one batch of at most 100 events. */
export function planRunActivityRetention(
  candidates: readonly Candidate[],
  incoming: readonly CanonicalChatRunActivity[],
  resolvedApprovalIds: readonly string[] = [],
  limit = MAX_RUN_ACTIVITIES,
): { removedActivityIds: string[]; droppedActivityIds: string[] } {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RUN_ACTIVITIES) throw new RangeError("Invalid activity retention limit");
  const parsed = candidates.map(row => ({ id: row.id, activity: CanonicalChatRunActivitySchema.safeParse(row.event) }));
  const existingIds = new Set(candidates.map(row => row.id));
  const incomingById = new Map(incoming.map(activity => [activity.id, activity]));
  let overflow = candidates.length + [...incomingById.keys()].filter(id => !existingIds.has(id)).length - limit;
  const removedActivityIds: string[] = [];
  const droppedActivityIds: string[] = [];
  if (overflow <= 0) return { removedActivityIds, droppedActivityIds };

  // Pending controls and uncertain input submissions must remain reconstructible.
  // Resolved controls are evicted as a group, never as a partial input ledger.
  const resolved = new Set(resolvedApprovalIds.map(id => `approval:${id}`));
  const touched = new Set(incoming.flatMap(activity => controlKey(activity) ?? []));
  const groups = new Map<string, typeof parsed>();
  for (const activity of [...parsed.flatMap(row => row.activity.success ? [row.activity.data] : []), ...incoming]) {
    if (activity.type === "input.resolved" || activity.type === "approval.resolved") resolved.add(controlKey(activity)!);
  }
  for (const row of parsed) {
    if (!row.activity.success) continue;
    const key = controlKey(row.activity.data);
    if (key) groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const visited = new Set<string>();
  for (const row of parsed) {
    if (overflow <= 0) break;
    if (!row.activity.success) continue; // Corrupt control history fails closed.
    const key = controlKey(row.activity.data);
    if (key && visited.has(key)) continue;
    if (key) visited.add(key);
    const group = key ? groups.get(key)! : [row];
    if ((key && (!resolved.has(key) || touched.has(key)))
      || group.some(entry => incomingById.has(entry.id) || (entry.activity.success && isTerminal(entry.activity.data)))) continue;
    removedActivityIds.push(...group.map(entry => entry.id));
    overflow -= group.length;
  }
  // If controls occupy every slot, display-only output can be discarded safely.
  // A new control that still cannot fit must fail closed instead of disappearing.
  for (const activity of incomingById.values()) {
    if (overflow <= 0) break;
    if (!existingIds.has(activity.id) && !controlKey(activity) && !isTerminal(activity)) {
      droppedActivityIds.push(activity.id);
      overflow -= 1;
    }
  }
  if (overflow > 0) throw new RangeError("Activity control retention exhausted");
  return { removedActivityIds, droppedActivityIds };
}

/** Called under the owning Chat row lock, in the caller's write transaction. */
export async function retainRunActivityWindow(
  db: Kysely<ChatDatabase> | Transaction<ChatDatabase>,
  input: { chatId: string; runId: string; revision: number; activities: CanonicalChatRunActivity[]; persistedCount: number; unseenCount: number },
): Promise<{ activities: CanonicalChatRunActivity[]; removedActivityIds: string[] }> {
  if (input.persistedCount + input.unseenCount <= MAX_RUN_ACTIVITIES) return { activities: input.activities, removedActivityIds: [] };
  const candidates = await db.selectFrom("chat_run_events").select(["id", "event"])
    .where("run_id", "=", input.runId).orderBy("occurred_at").orderBy("run_seq").orderBy("id")
    .limit(MAX_RUN_ACTIVITIES + 1).execute();
  if (candidates.length > MAX_RUN_ACTIVITIES) throw new ChatConflictError(input.chatId, input.revision);
  const approvalIds = candidates.flatMap(row => {
    const activity = CanonicalChatRunActivitySchema.safeParse(row.event);
    return activity.success && activity.data.type === "approval.requested" ? [activity.data.approvalId] : [];
  });
  const outcomes = approvalIds.length ? await db.selectFrom("chat_approval_outcomes").select("approval_id")
    .where("run_id", "=", input.runId).where("approval_id", "in", approvalIds).execute() : [];
  let plan: ReturnType<typeof planRunActivityRetention>;
  try {
    plan = planRunActivityRetention(candidates, input.activities, outcomes.map(row => row.approval_id));
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    throw new ChatConflictError(input.chatId, input.revision);
  }
  if (plan.removedActivityIds.length) await db.deleteFrom("chat_run_events")
    .where("run_id", "=", input.runId).where("id", "in", plan.removedActivityIds).execute();
  return {
    activities: input.activities.filter(activity => !plan.droppedActivityIds.includes(activity.id)),
    removedActivityIds: plan.removedActivityIds,
  };
}
