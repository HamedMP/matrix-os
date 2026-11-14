import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod/v4";
import { CanonicalChatIdSchema, CanonicalChatRunIdSchema, CanonicalOwnerScopeSchema, canonicalExecutionRootProjectId } from "@matrix-os/contracts";
import type { CanonicalChatRun } from "@matrix-os/contracts";
import type { Kysely, Transaction, Selectable } from "kysely";
import type { ChatDatabase, ChatsTable } from "./database.js";
import type { ClaudeNativeRecoveryAdmissionFence } from "./claude-native-recovery-store.js";
import { ChatBusyError, ChatConflictError } from "./errors.js";
import { parseJson, toRun, type ChatOwner, type ChatRecord } from "./records.js";

export const NATIVE_SCHEDULED_INPUT_TEXT = "Scheduled task triggered.";

export const NativeScheduledSourceSchema = z.object({
  sourceRunId: CanonicalChatRunIdSchema,
  sessionId: z.string().min(1).max(512).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
  promptId: z.uuid(),
  prompt: z.string().min(1).max(24_000).refine(text => new TextEncoder().encode(text).byteLength <= 96 * 1024),
}).strict();
const NativeScheduledCheckpointSchema = NativeScheduledSourceSchema.pick({ sourceRunId: true, sessionId: true });
export type NativeScheduledSource = z.infer<typeof NativeScheduledSourceSchema>;
export type NativeScheduledCheckpoint = z.infer<typeof NativeScheduledCheckpointSchema>;

export interface NativeScheduledPhaseRequest extends NativeScheduledSource {
  owner: ChatOwner;
  chatId: string;
  /** Only the private Gateway restore owner can supply this fence. */
  recovery?: ClaudeNativeRecoveryAdmissionFence;
}

export function parseNativeScheduledPhaseRequest(value: NativeScheduledPhaseRequest): NativeScheduledPhaseRequest {
  return { ...NativeScheduledSourceSchema.parse({ sourceRunId: value.sourceRunId, sessionId: value.sessionId,
    promptId: value.promptId, prompt: value.prompt }), owner: CanonicalOwnerScopeSchema.parse(value.owner),
    chatId: CanonicalChatIdSchema.parse(value.chatId), ...(value.recovery === undefined ? {} : { recovery: value.recovery }) };
}

export function nativeScheduledRequestId(value: NativeScheduledPhaseRequest): string {
  const request = parseNativeScheduledPhaseRequest(value);
  return `req_native_${createHash("sha256").update(JSON.stringify([
    request.owner.type, request.owner.ownerId, request.chatId, request.sessionId, request.promptId,
  ])).digest("hex")}`;
}
export function nativeScheduledRequestHash(value: NativeScheduledPhaseRequest): string {
  const request = parseNativeScheduledPhaseRequest(value);
  return createHash("sha256").update(JSON.stringify([request.owner, request.chatId, request.sourceRunId,
    request.sessionId, request.promptId, request.prompt])).digest("hex");
}

export interface NativeScheduledSourceRecord {
  chat: ChatRecord;
  run: CanonicalChatRun;
  adapterState: { schemaVersion: number; state: unknown };
}

/** Called under the owner Chat lock for writes. Native callback data never selects an owner. */
export async function readNativeScheduledSource(
  executor: Kysely<ChatDatabase> | Transaction<ChatDatabase>, owner: ChatOwner,
  current: Selectable<ChatsTable>, sourceValue: NativeScheduledSource,
): Promise<Omit<NativeScheduledSourceRecord, "chat">> {
  const source = NativeScheduledSourceSchema.parse(sourceValue);
  return readNativeScheduledCheckpoint(executor, owner, current, { sourceRunId: source.sourceRunId, sessionId: source.sessionId });
}

/** Resolve only an existing owner-bound native checkpoint, without creating a due occurrence. */
export async function readNativeScheduledCheckpoint(
  executor: Kysely<ChatDatabase> | Transaction<ChatDatabase>, owner: ChatOwner,
  current: Selectable<ChatsTable>, sourceValue: NativeScheduledCheckpoint,
  { requireLatestRun = false } = {},
): Promise<Omit<NativeScheduledSourceRecord, "chat">> {
  const source = NativeScheduledCheckpointSchema.parse(sourceValue);
  const conflict = () => new ChatConflictError(current.id, Number(current.revision));
  if (owner.type !== "personal" || current.lifecycle !== "active" || current.collaboration !== null) throw conflict();
  const row = await executor.selectFrom("chat_runs").selectAll()
    .where("id", "=", source.sourceRunId).where("chat_id", "=", current.id).executeTakeFirst();
  if (!row) throw conflict();
  const run = toRun(row);
  if (["accepted", "running", "waiting_for_approval", "waiting_for_input"].includes(run.status)) throw new ChatBusyError(current.id);
  if (run.driverKind !== "claude_code" || run.status !== "completed" || run.outcome !== "completed"
    || run.interactionMode !== "default" || run.context?.agent
    || current.bound_driver_kind !== "claude_code" || current.bound_instance_id !== run.instanceId
    || current.current_selection === null || !isDeepStrictEqual(parseJson(current.current_selection), run.selection)
    || (current.project_id ?? undefined) !== (run.executionRoot ? canonicalExecutionRootProjectId(run.executionRoot) : undefined)) throw conflict();
  const checkpoint = await executor.selectFrom("chat_run_adapter_state").selectAll()
    .where("run_id", "=", run.id).where("driver_kind", "=", "claude_code")
    .where("instance_id", "=", run.instanceId).executeTakeFirst();
  if (!checkpoint) throw conflict();
  const state: unknown = parseJson(checkpoint.state);
  const parsed = z.object({ sessionId: z.string() }).passthrough().safeParse(state);
  if (!parsed.success || parsed.data.sessionId !== source.sessionId) throw conflict();
  if (requireLatestRun) {
    // A newer attempt with no checkpoint still supersedes the old recovery source.
    const latestRun = await executor.selectFrom("chat_runs as execution")
      .innerJoin("chat_turns as turn", "turn.id", "execution.turn_id")
      .select("execution.id").where("execution.chat_id", "=", current.id)
      .orderBy("turn.base_message_seq", "desc").orderBy("execution.attempt", "desc").executeTakeFirst();
    if (latestRun?.id !== run.id) throw conflict();
    return { run, adapterState: { schemaVersion: Number(checkpoint.schema_version), state } };
  }
  const latest = await executor.selectFrom("chat_run_adapter_state as checkpoint")
    .innerJoin("chat_runs as execution", "execution.id", "checkpoint.run_id")
    .innerJoin("chat_turns as turn", "turn.id", "execution.turn_id")
    .select("checkpoint.state").where("execution.chat_id", "=", current.id)
    .where("execution.driver_kind", "=", "claude_code").where("execution.instance_id", "=", run.instanceId)
    .orderBy("turn.base_message_seq", "desc").orderBy("execution.attempt", "desc").executeTakeFirst();
  const latestState = latest ? z.object({ sessionId: z.string() }).passthrough().safeParse(parseJson(latest.state)) : undefined;
  if (!latestState?.success || latestState.data.sessionId !== source.sessionId) throw conflict();
  return { run, adapterState: { schemaVersion: Number(checkpoint.schema_version), state } };
}

export function sameNativeScheduledRun(source: CanonicalChatRun, run: CanonicalChatRun): boolean {
  return run.driverKind === "claude_code" && run.instanceId === source.instanceId
    && isDeepStrictEqual(run.selection, source.selection) && run.permissionMode === source.permissionMode
    && run.interactionMode === source.interactionMode && !run.context?.agent
    && isDeepStrictEqual(run.executionRoot, source.executionRoot)
    && run.executionRootFingerprint === source.executionRootFingerprint;
}
