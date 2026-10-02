import type { CanonicalChatModelSelection, CanonicalProviderDriverKind } from "@matrix-os/contracts";
import type { CanonicalChatProviderAdapter } from "../chat/provider-adapter.js";
import type { ClaimedQueuedTurn } from "../chat/repository.js";
import { SharedChatRunPreparationError, type SharedDispatchRun } from "../chat/shared-execution-coordinator.js";
import type { AuthorizedCollaborationContext } from "./authority.js";
import type { SharedRunOwnerSource, SharedRunOwnerSourceDecision } from "./shared-run-owner-source.js";
import { MATRIX_BOT_INSTANCE_ID, MATRIX_BOT_MODEL } from "../bots/selection.js";

export type SharedMatrixBotExecution = NonNullable<ClaimedQueuedTurn["sharedExecution"]>;

/** An explicitly configured company Pi route; never the owner's personal default. */
export interface SharedMatrixBotExtension {
  resolvePolicyDriver(execution: SharedMatrixBotExecution, run: SharedDispatchRun, context: AuthorizedCollaborationContext): Promise<"claude_code" | "codex">;
  /** Pins the exact owner decision and model to the canonical Run before returning its adapter. */
  prepareAdapter(execution: SharedMatrixBotExecution, run: SharedDispatchRun, context: AuthorizedCollaborationContext, decision: SharedRunOwnerSourceDecision): Promise<{ adapter: CanonicalChatProviderAdapter; modelId: string }>;
  readiness?(ownerId: string, selection: CanonicalChatModelSelection | null): Promise<"ready" | "reconnect_required" | "unavailable">;
}

/** The first owner binding must use the company route, just as its later turns do. */
export async function resolveSharedMatrixBotReadiness(input: {
  ownerId: string;
  selection?: CanonicalChatModelSelection | null;
  boundDriverKind?: CanonicalProviderDriverKind | null;
  extension?: SharedMatrixBotExtension;
  standard(ownerId: string, selection?: CanonicalChatModelSelection | null, driver?: CanonicalProviderDriverKind | null): Promise<"ready" | "reconnect_required" | "unavailable">;
}): Promise<"ready" | "reconnect_required" | "unavailable"> {
  if (input.boundDriverKind === "matrix_bot"
    || (!input.boundDriverKind && input.selection?.instanceId === MATRIX_BOT_INSTANCE_ID)) {
    if (input.selection?.instanceId !== MATRIX_BOT_INSTANCE_ID || input.selection.model !== MATRIX_BOT_MODEL) return "unavailable";
    return input.extension?.readiness?.(input.ownerId, input.selection) ?? "unavailable";
  }
  return input.standard(input.ownerId, input.selection, input.boundDriverKind);
}

/** Called only after the shared queue's fresh membership and dispatch fence. */
export async function prepareSharedMatrixBotAdapter(input: {
  execution: SharedMatrixBotExecution;
  run: SharedDispatchRun;
  context: AuthorizedCollaborationContext;
  ownerSource: Pick<SharedRunOwnerSource, "prepare">;
  extension: SharedMatrixBotExtension;
  admit(decision: SharedRunOwnerSourceDecision, modelId: string): Promise<void>;
}): Promise<CanonicalChatProviderAdapter> {
  const { execution, run, context, extension } = input;
  if (execution.driverKind !== "matrix_bot" || execution.selection.instanceId !== MATRIX_BOT_INSTANCE_ID
    || execution.selection.model !== MATRIX_BOT_MODEL || context.capability !== "request_ai"
    || context.actorId !== execution.requestingActorId || context.scopeId !== execution.scopeId
    || context.resourceKind !== "chat" || !context.organizationId
    || !run.executionRoot || !["project", "worktree"].includes(run.executionRoot.kind)
    || !run.executionRootFingerprint || !/^[a-f0-9]{64}$/.test(run.executionRootFingerprint)) {
    throw new SharedChatRunPreparationError("unavailable");
  }
  const driverKind = await extension.resolvePolicyDriver(execution, run, context);
  if (driverKind !== "claude_code" && driverKind !== "codex") throw new SharedChatRunPreparationError("unavailable");
  // This preserves owner-only policy, readiness and explicit access-source selection.
  const decision = await input.ownerSource.prepare({
    scopeId: context.scopeId, chatId: context.resourceId, ownerId: context.ownerId,
    requestingActorId: execution.requestingActorId, driverKind,
  });
  const prepared = await extension.prepareAdapter(execution, run, context, decision);
  if (prepared.adapter.driverKind !== "matrix_bot" || prepared.modelId.length === 0 || prepared.modelId.length > 200
    || !decision.allowedModelIds.includes(prepared.modelId)) throw new SharedChatRunPreparationError("unavailable");
  await input.admit(decision, prepared.modelId);
  return prepared.adapter;
}
