import { randomBytes } from "node:crypto";
import { chatContextRequestHash } from "../chat/agent-context.js";
import { MATRIX_BOT_SELECTION } from "./selection.js";
import type { RoutineCliRequestRecord } from "./repositories/routine-cli-requests.js";
import type { BotExecutor } from "./repositories/shared.js";
import { RoutineCliError } from "./routine-cli-errors.js";
export const ROUTINE_CLI_REQUEST_PREFIX = "req_cli_routine_";
export const newRoutineCliCanonicalRequestId = () => ROUTINE_CLI_REQUEST_PREFIX + randomBytes(16).toString("hex");
export function routineCliProposalInput(receipt: Pick<RoutineCliRequestRecord, "operation">) {
  if (receipt.operation.operation !== "propose") throw new RoutineCliError("permission_denied");
  const text = `Request routine approval: ${receipt.operation.proposal.name}`;
  const input = { parts: [{ type: "text" as const, text }], selection: MATRIX_BOT_SELECTION, interactionMode: "default", permissionMode: "default" };
  return { text, input, hash: chatContextRequestHash(input) };
}
/** The original first-attempt payload hash, actual admitted driver and exact run/turn mapping are mandatory. */
export async function routineCliCanonicalRun(ex: BotExecutor, input: { ownerId: string; chatId: string; runId: string }) {
  return ex.selectFrom("chat_runs as run").innerJoin("chat_turns as turn", join => join.onRef("turn.id", "=", "run.turn_id").onRef("turn.chat_id", "=", "run.chat_id"))
    .innerJoin("chats as chat", "chat.id", "run.chat_id")
    .select(["run.id", "turn.id as turn_id", "run.client_request_id", "turn.client_request_id as original_request_id", "run.request_hash", "run.driver_kind", "run.attempt", "run.status", "run.permission_mode", "run.interaction_mode"])
    .where("run.id", "=", input.runId).where("run.chat_id", "=", input.chatId).where("chat.owner_type", "=", "personal").where("chat.owner_id", "=", input.ownerId).executeTakeFirst();
}

/** Queue claim in the fixed canonical baseline preserves its hash on the queue row, not chat_runs.
 * Accept that exact durable claimed mapping only; never compute a replacement hash from display text. */
export async function routineCliCanonicalHashMatches(ex: BotExecutor, run: NonNullable<Awaited<ReturnType<typeof routineCliCanonicalRun>>>, chatId: string, expected: string) {
  if (run.request_hash !== null) return run.request_hash === expected;
  return !!await ex.selectFrom("chat_queued_turns").select("id").where("chat_id", "=", chatId)
    .where("client_request_id", "=", run.client_request_id).where("request_hash", "=", expected).where("status", "=", "claimed")
    .where("driver_kind", "=", "matrix_bot").where("claimed_run_id", "=", run.id).where("claimed_turn_id", "=", run.turn_id).executeTakeFirst();
}
