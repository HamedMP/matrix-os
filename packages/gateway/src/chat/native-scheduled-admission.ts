import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  CanonicalChatMessageSchema, CanonicalChatRunSchema, CanonicalChatTurnSchema,
  type CanonicalChatMessage, type CanonicalChatRun,
} from "@matrix-os/contracts";
import { NATIVE_SCHEDULED_INPUT_TEXT, parseNativeScheduledPhaseRequest, nativeScheduledRequestId, nativeScheduledRequestHash, type NativeScheduledPhaseRequest } from "./native-scheduled-source.js";
import type { NativeScheduledSourceRecord } from "./native-scheduled-source.js";
import type { ChatOwner } from "./records.js";
import type { ChatRepository } from "./repository.js";
import type { CanonicalChatProviderAdapter, CanonicalChatProviderRegistry, NativeScheduledPhaseIdentity } from "./provider-adapter.js";
import type { ChatProviderCatalogService } from "./provider-catalog.js";
import { validateChatProviderSelection } from "./provider-catalog.js";
import type { ChatExecutionRootResolver, ResolvedChatExecutionRoot } from "./execution-root.js";
import { ChatBusyError, ChatConflictError, ChatNotFoundError } from "./errors.js";
import { contextForChatSession } from "./session-history.js";

export { parseNativeScheduledPhaseRequest, nativeScheduledRequestId, nativeScheduledRequestHash } from "./native-scheduled-source.js";
export type { NativeScheduledPhaseRequest } from "./native-scheduled-source.js";

export interface NativeScheduledAdmissionOptions {
  repository: Pick<ChatRepository, "getNativeScheduledSource" | "findTurnAdmission" | "admitNativeScheduledTurn" | "finishRun">;
  catalog: Pick<ChatProviderCatalogService, "getCatalog">;
  adapters: CanonicalChatProviderRegistry;
  executionRoots?: ChatExecutionRootResolver;
  now?: () => Date;
  assertOpen(): void;
  assertPersonalExecutionAllowed(owner: ChatOwner, chatId: string): Promise<void>;
  atCapacity(owner: ChatOwner): boolean;
  hasStoppingExecution(owner: ChatOwner, chatId: string): boolean;
  reservePendingDispatch(runId: string): void;
  releasePendingDispatch(runId: string): void;
  /** Synchronous registration only; the orchestrator owns the returned phase completion. */
  registerDispatch(owner: ChatOwner, message: CanonicalChatMessage, run: CanonicalChatRun,
    adapter: CanonicalChatProviderAdapter, root: ResolvedChatExecutionRoot | undefined, resumeState: unknown,
    identity: NativeScheduledPhaseIdentity): { registered: true };
}

/** A restore and its future occurrence use the same current catalog and root requirements. */
export async function resolveNativeScheduledLaunch(
  deps: Pick<NativeScheduledAdmissionOptions, "catalog" | "executionRoots">,
  owner: ChatOwner,
  source: NativeScheduledSourceRecord,
) {
  const { run, chat } = source;
  const conflict = () => new ChatConflictError(run.chatId, chat.chat.revision);
  // This principal is derived from the admitted owner by the trusted host, never client/native fields.
  const catalog = await deps.catalog.getCatalog({ userId: owner.ownerId, source: "configured-container" }, run.selection);
  const validated = validateChatProviderSelection({ catalog, selection: run.selection, boundInstanceId: run.instanceId,
    requirements: { interactionMode: run.interactionMode, permissionMode: run.permissionMode,
      worktree: run.executionRoot?.kind === "worktree" } });
  if (!validated.ok || validated.instance.driverKind !== "claude_code" || !validated.instance.supports.resume
    || !isDeepStrictEqual(validated.selection, run.selection)) throw conflict();
  let root: ResolvedChatExecutionRoot | undefined;
  if (run.executionRoot) {
    if (!deps.executionRoots || !run.executionRootFingerprint) throw conflict();
    root = await deps.executionRoots.revalidate(owner, { ref: run.executionRoot, fingerprint: run.executionRootFingerprint });
    if (root.fingerprint !== run.executionRootFingerprint) throw conflict();
  }
  return { instance: validated.instance, root };
}

/** Private host entry only. The native prompt remains held until this dispatch attaches. */
export async function admitNativeScheduledPhase(
  deps: NativeScheduledAdmissionOptions, requestValue: NativeScheduledPhaseRequest,
): Promise<void> {
  const request = parseNativeScheduledPhaseRequest(requestValue);
  const { owner, chatId, recovery, ...nativeSource } = request;
  deps.assertOpen();
  if (owner.type !== "personal") throw new ChatConflictError(chatId, 0);
  await deps.assertPersonalExecutionAllowed(owner, chatId);
  const clientRequestId = nativeScheduledRequestId(request);
  const requestHash = nativeScheduledRequestHash(request);
  const duplicate = await deps.repository.findTurnAdmission(owner, chatId, clientRequestId, requestHash);
  if (duplicate) throw new ChatConflictError(chatId, duplicate.chat.chat.revision); // Never release a replayed native callback.
  if (deps.atCapacity(owner) || deps.hasStoppingExecution(owner, chatId)) throw new ChatBusyError(chatId);
  const source = await deps.repository.getNativeScheduledSource(owner, chatId, nativeSource);
  if (!source) throw new ChatNotFoundError(chatId);
  const adapter = deps.adapters.get("claude_code");
  if (!adapter?.resume || source.adapterState.schemaVersion !== adapter.stateSchemaVersion) throw new ChatConflictError(chatId, source.chat.chat.revision);
  const { instance, root } = await resolveNativeScheduledLaunch(deps, owner, source);
  const resumeState = adapter.parseState(source.adapterState.state);
  const context = contextForChatSession(source.run.context, resumeState);
  const timestamp = (deps.now ?? (() => new Date()))().toISOString();
  const turnId = `cturn_${randomUUID().replaceAll("-", "")}`;
  const message = CanonicalChatMessageSchema.parse({ id: `msg_${randomUUID().replaceAll("-", "")}`, chatId,
    seq: source.chat.chat.messageCount + 1, role: "system", purpose: "system", state: "committed", turnId,
    parts: [{ type: "text", text: NATIVE_SCHEDULED_INPUT_TEXT }], createdAt: timestamp });
  const turn = CanonicalChatTurnSchema.parse({ id: turnId, chatId, clientRequestId,
    baseMessageSeq: source.chat.chat.messageCount, inputMessageId: message.id, status: "accepted",
    createdAt: timestamp, updatedAt: timestamp });
  const run = CanonicalChatRunSchema.parse({ ...source.run, id: `run_${randomUUID().replaceAll("-", "")}`, turnId,
    attempt: 1, status: "accepted", outcome: undefined, startedAt: undefined, completedAt: undefined,
    historyBoundarySeq: turn.baseMessageSeq, context: context ? { ...context, requestHash } : undefined,
    capabilitySnapshot: { revision: instance.catalogRevision, ...instance.supports,
      steering: instance.supports.steering ?? "none" },
    createdAt: timestamp, updatedAt: timestamp });
  deps.reservePendingDispatch(run.id);
  let accepted = false;
  try {
    const admitted = await deps.repository.admitNativeScheduledTurn(owner, { chatId,
      baseRevision: source.chat.chat.revision, requestHash, message, turn, run,
      adapterState: source.adapterState }, nativeSource, recovery);
    if (admitted.alreadyAccepted) throw new ChatConflictError(chatId, admitted.chat.chat.revision);
    accepted = true;
    deps.assertOpen();
    if (deps.atCapacity(owner) || deps.hasStoppingExecution(owner, chatId)) throw new ChatBusyError(chatId);
    // Registration is synchronous; do not await the native phase's terminal result here.
    const registration = deps.registerDispatch(owner, admitted.message, admitted.run, adapter, root, resumeState,
      { sourceRunId: request.sourceRunId, sessionId: request.sessionId, promptId: request.promptId });
    if (registration.registered !== true) throw new ChatConflictError(chatId, admitted.chat.chat.revision);
    accepted = false;
  } catch (error: unknown) {
    if (accepted) await deps.repository.finishRun(owner, { chatId, runId: run.id, outcome: "failed",
      completedAt: (deps.now ?? (() => new Date()))().toISOString() });
    throw error;
  } finally { deps.releasePendingDispatch(run.id); }
}
