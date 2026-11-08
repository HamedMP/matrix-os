import { acceptedBinding } from "./routine-chat-origin-target.js";
import type { BotInteractionRecord } from "./repositories/interactions.js";
import type { BotExecutor } from "./repositories/shared.js";
import { RoutineCliSourceContextSchema } from "./routine-cli-source-context.js";
import { RoutineCliOperationSchema } from "@matrix-os/contracts";
import { parseJson } from "../chat/records.js";

export interface RoutineChatOrigin {
  ownerId: string; computerId: string; requestId: string;
  sourceChatId: string; sourceRunId: string;
  canonicalChatId: string; botId: string; bindingCreatedAt: string;
}
/** Exact immutable ledger join, never current preference or mutable standing approval. */
export async function initialRoutineChatOrigin(db: BotExecutor, interaction: BotInteractionRecord): Promise<RoutineChatOrigin | undefined> {
  const rows = await db.selectFrom("routine_cli_proposals as proposal")
    .innerJoin("routine_cli_requests as receipt", join => join.onRef("receipt.owner_id", "=", "proposal.owner_id")
      .onRef("receipt.computer_id", "=", "proposal.computer_id").onRef("receipt.client_request_id", "=", "proposal.client_request_id"))
    .selectAll("receipt").select(["proposal.run_id", "proposal.task_id"])
    .where("proposal.owner_id", "=", interaction.ownerId).where("proposal.interaction_id", "=", interaction.interactionId)
    .where("proposal.stage", "=", "pending_approval").limit(2).execute();
  if (rows.length !== 1) return;
  const row = rows[0], source = RoutineCliSourceContextSchema.safeParse(parseJson(row.source_context)),
    operation = RoutineCliOperationSchema.safeParse(parseJson(row.operation));
  const bindingCreatedAt = acceptedBinding(row.target_snapshot, row.owner_id, row.computer_id, interaction.botId, interaction.chatId);
  if (!source.success || source.data.identity.kind !== "chat_run" || source.data.ownerId !== row.owner_id
    || source.data.computerId !== row.computer_id || !operation.success || operation.data.operation !== "propose"
    || operation.data.requestId.toLowerCase() !== row.client_request_id.toLowerCase()
    || !bindingCreatedAt || row.admission.disposition !== "queued"
    || row.task_id !== interaction.taskId || row.run_id !== interaction.sourceRunId) return;
  return { bindingCreatedAt, ownerId: row.owner_id, computerId: row.computer_id, requestId: row.client_request_id,
    sourceChatId: source.data.identity.chatId, sourceRunId: source.data.identity.runId, canonicalChatId: interaction.chatId, botId: interaction.botId };
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
  if (!row) return;
  const bindingCreatedAt = acceptedBinding(row.target_snapshot, row.owner_id, row.computer_id, interaction.botId, interaction.chatId);
  if (!bindingCreatedAt || row.admission.disposition !== "queued") return;
  const source = RoutineCliSourceContextSchema.safeParse(parseJson(row.source_context));
  if (!source.success || source.data.identity.kind !== "chat_run" || source.data.ownerId !== row.owner_id || source.data.computerId !== row.computer_id) return;
  return { bindingCreatedAt, ownerId: row.owner_id, computerId: row.computer_id, requestId: row.client_request_id,
    sourceChatId: source.data.identity.chatId, sourceRunId: source.data.identity.runId, canonicalChatId: interaction.chatId, botId: interaction.botId };
}
