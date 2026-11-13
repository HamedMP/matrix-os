import { acceptedRoutineOriginTarget } from "./routine-chat-origin-target.js";
import type { BotInteractionRecord } from "./repositories/interactions.js";
import type { BotExecutor } from "./repositories/shared.js";
import { RoutineCliSourceContextSchema } from "./routine-cli-source-context.js";
import { RoutineCliOperationSchema } from "@matrix-os/contracts";
import { parseJson } from "../chat/records.js";

export interface RoutineChatOrigin {
  ownerId: string; computerId: string; requestId: string;
  sourceChatId: string; sourceRunId: string;
  canonicalChatId: string; botId: string; bindingCreatedAt: string; directChat: boolean;
}
type OriginCoordinates = { ownerId: string; botId: string; chatId: string };

function originFromReceipt(row: { owner_id: string; computer_id: string; client_request_id: string;
  source_context: unknown; operation: unknown; target_snapshot: unknown; admission: { disposition: string } }, target: OriginCoordinates): RoutineChatOrigin | undefined {
  const source = RoutineCliSourceContextSchema.safeParse(parseJson(row.source_context));
  const operation = RoutineCliOperationSchema.safeParse(parseJson(row.operation));
  if (!source.success || source.data.identity.kind !== "chat_run" || source.data.ownerId !== row.owner_id
    || target.ownerId !== row.owner_id || source.data.computerId !== row.computer_id || !operation.success
    || operation.data.operation !== "propose" || operation.data.requestId.toLowerCase() !== row.client_request_id.toLowerCase()
    || row.admission.disposition !== "queued") return;
  const { chatId: sourceChatId, runId: sourceRunId } = source.data.identity;
  const accepted = acceptedRoutineOriginTarget(row.target_snapshot, row.owner_id, row.computer_id, target.botId, target.chatId, sourceChatId);
  if (!accepted) return;
  return { bindingCreatedAt: accepted.bindingCreatedAt, ownerId: row.owner_id, computerId: row.computer_id,
    requestId: row.client_request_id, sourceChatId, sourceRunId, canonicalChatId: target.chatId, botId: target.botId, directChat: "purpose" in accepted };
}

function originProposalRows(db: BotExecutor, ownerId: string) {
  return db.selectFrom("routine_cli_proposals as proposal")
    .innerJoin("routine_cli_requests as receipt", join => join.onRef("receipt.owner_id", "=", "proposal.owner_id")
      .onRef("receipt.computer_id", "=", "proposal.computer_id").onRef("receipt.client_request_id", "=", "proposal.client_request_id"))
    .selectAll("receipt").select(["proposal.run_id", "proposal.task_id"])
    .where("proposal.owner_id", "=", ownerId);
}

/** Exact immutable ledger join, never current preference or mutable standing approval. */
export async function initialRoutineChatOrigin(db: BotExecutor, interaction: BotInteractionRecord): Promise<RoutineChatOrigin | undefined> {
  const rows = await originProposalRows(db, interaction.ownerId).where("proposal.interaction_id", "=", interaction.interactionId)
    .where("proposal.stage", "=", "pending_approval").limit(2).execute();
  if (rows.length !== 1 || rows[0].task_id !== interaction.taskId || rows[0].run_id !== interaction.sourceRunId) return;
  return originFromReceipt(rows[0], interaction);
}

/** The only route into an approval for a scheduler-owned Bot is an already claimed exact CLI intent. */
export async function claimedRoutineChatOrigin(db: BotExecutor, target: OriginCoordinates & { taskId: string; runId: string }, computerId: string) {
  const row = await originProposalRows(db, target.ownerId).where("proposal.computer_id", "=", computerId)
    .where("proposal.task_id", "=", target.taskId).where("proposal.run_id", "=", target.runId)
    .where("proposal.stage", "=", "target_task_claimed").executeTakeFirst();
  return row && originFromReceipt(row, target);
}
/** Edited approval maps through the stable routine origin, not its replaced approval_id. */
export async function routineChatOriginForInteraction(db: BotExecutor, interaction: BotInteractionRecord): Promise<RoutineChatOrigin | undefined> {
  if (interaction.kind !== "approval" || interaction.payload.tool !== "routine.activate") return;
  const initial = await initialRoutineChatOrigin(db, interaction);
  if (initial) return initial;
  if (typeof interaction.payload.preview !== "string") return;
  let preview: { source?: { routineId?: string } };
  try { preview = JSON.parse(interaction.payload.preview); }
  catch (error: unknown) {
    if (error instanceof SyntaxError) {
      console.warn("[routine-origin] Saved approval preview is invalid");
      return;
    }
    throw error;
  }
  const routineId = preview?.source?.routineId;
  if (typeof routineId !== "string" || !/^rt_[a-f0-9]{24}$/.test(routineId)) return;
  const row = await db.selectFrom("bot_routines as routine").innerJoin("routine_cli_requests as receipt", join =>
    join.onRef("receipt.owner_id", "=", "routine.owner_id").onRef("receipt.computer_id", "=", "routine.origin_computer_id").onRef("receipt.client_request_id", "=", "routine.origin_request_id"))
    .selectAll("receipt").where("routine.owner_id", "=", interaction.ownerId).where("routine.routine_id", "=", routineId)
    .where("routine.bot_id", "=", interaction.botId).where("routine.chat_id", "=", interaction.chatId).executeTakeFirst();
  return row && originFromReceipt(row, interaction);
}
