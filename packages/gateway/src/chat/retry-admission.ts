import { chatContextRequestHash } from "./agent-context.js";
import { prepareChatSessionContext } from "./session-history.js";
import { randomUUID } from "node:crypto";
import { CanonicalRetryChatTurnRequestSchema, CanonicalChatRunSchema, CanonicalChatRunAdmissionResponseSchema,
  type CanonicalRetryChatTurnRequest, type CanonicalChatRunAdmissionResponse, type CanonicalChatRun } from "@matrix-os/contracts";
import type { RequestPrincipal } from "../request-principal.js";
import type { ChatOwner } from "./records.js";
import type { ChatRepository } from "./repository.js";
import type { ResolvedChatExecutionRoot } from "./execution-root.js";
import type { TurnAdmissionOptions } from "./turn-admission.js";
import { ChatBusyError } from "./errors.js";
import { dispatchAdmissionKey } from "./dispatch-ownership.js";
import { validateChatProviderSelection } from "./provider-catalog.js";
import { CanonicalChatOrchestrationError, mapRepositoryError, safeError, retryPromptFor } from "./orchestration-input.js";
import { loadChatResumeState } from "./resume-checkpoint.js";
import { retryAvailability } from "./retry-preflight.js";

interface RetryAdmissionOptions extends Omit<TurnAdmissionOptions, "repository"> {
  repository: TurnAdmissionOptions["repository"] & Pick<ChatRepository,
    "findRetryAdmission" | "getTurnRunContext" | "getAdapterState" | "hasRetryRequest" | "admitRetry">;
}
const id = (prefix: string) => `${prefix}${randomUUID().replaceAll("-", "")}`;

export async function admitCanonicalRetry(deps: RetryAdmissionOptions, principal: RequestPrincipal,
  owner: ChatOwner, chatId: string, turnId: string, inputValue: CanonicalRetryChatTurnRequest,
): Promise<CanonicalChatRunAdmissionResponse> {
    deps.assertOpen();
    await deps.assertPersonalExecutionAllowed(owner, chatId);
    await deps.reconcileActiveRuns(owner);
    const input = CanonicalRetryChatTurnRequestSchema.parse(inputValue);
    try {
      const duplicate = await deps.repository.findRetryAdmission(owner, chatId, turnId, input.clientRequestId);
      if (duplicate) return CanonicalChatRunAdmissionResponseSchema.parse({ record: duplicate.chat,
        turn: duplicate.turn, run: duplicate.run, admission: "already_accepted" });
    } catch (error: unknown) { return mapRepositoryError(error); }
    const admissionKey = dispatchAdmissionKey("retry", input.clientRequestId, turnId);
    if (deps.hasStoppingExecution(owner, chatId, admissionKey)) {
      return mapRepositoryError(new ChatBusyError(chatId));
    }
    const context = await deps.repository.getTurnRunContext(owner, chatId, turnId);
    if (!context) {
      throw new CanonicalChatOrchestrationError(safeError("run_not_found", "Run not found."), 404);
    }
    try { await deps.agentContext?.revalidate(owner, chatId, context.latestRun.context); }
    catch (error: unknown) { return mapRepositoryError(error); }
    const catalog = await deps.catalog.getCatalog(principal, context.latestRun.selection);
    const validated = validateChatProviderSelection({
      catalog,
      selection: context.latestRun.selection,
      boundInstanceId: context.latestRun.instanceId,
      requirements: {
        resources: context.latestRun.context?.drives?.length ? ["organization_drive"] : [],
        interactionMode: context.latestRun.interactionMode,
        permissionMode: context.latestRun.permissionMode,
        worktree: context.latestRun.executionRoot?.kind === "worktree",
      },
    });
    if (!validated.ok) throw new CanonicalChatOrchestrationError(validated.error, 400);
    const adapter = deps.adapters.get(context.latestRun.driverKind);
    if (!adapter) {
      throw new CanonicalChatOrchestrationError(
        safeError("provider_unavailable", "The selected Provider cannot run yet.", false, ["select_provider"]),
        503,
      );
    }
    let resolvedRoot: ResolvedChatExecutionRoot | undefined;
    if (context.latestRun.executionRoot) {
      if (!deps.executionRoots) {
        throw new CanonicalChatOrchestrationError(
          safeError("project_unavailable", "The Project workspace is unavailable.", true, ["retry"]),
          503,
        );
      }
      try {
        resolvedRoot = await deps.executionRoots.resolve(owner, context.latestRun.executionRoot);
      } catch (error: unknown) {
        console.warn("[chat/orchestrator] Retry root resolution failed:", error instanceof Error ? error.name : "UnknownError");
        throw new CanonicalChatOrchestrationError(
          safeError("project_unavailable", "The Project workspace is unavailable.", true, ["retry"]),
          503,
        );
      }
    }
    const resumeState = context.latestRun.context?.agent ? undefined : await loadChatResumeState({
      repository: deps.repository, owner, chatId, adapter,
      instanceId: context.latestRun.instanceId,
      executionRootFingerprint: resolvedRoot?.fingerprint ?? null,
      mode: "retry",
    });
    let sessionContext: CanonicalChatRun["context"];
    try {
      sessionContext = await prepareChatSessionContext({
        repository: deps.repository, owner, chatId, throughSeq: context.turn.baseMessageSeq,
        requestHash: context.latestRun.context?.requestHash ?? chatContextRequestHash({
          parts: context.message.parts, selection: context.latestRun.selection,
          interactionMode: context.latestRun.interactionMode, permissionMode: context.latestRun.permissionMode,
          executionRoot: context.latestRun.executionRoot,
        }),
        instanceId: context.latestRun.instanceId, resumeState, context: context.latestRun.context,
      });
    } catch (error: unknown) { return mapRepositoryError(error); }
    const availability = await retryAvailability(adapter, owner, resumeState, () => deps.repository.getAdapterState(owner, {
      runId: context.latestRun.id, driverKind: context.latestRun.driverKind, instanceId: context.latestRun.instanceId,
    }), () => deps.repository.hasRetryRequest(owner, { chatId, turnId, clientRequestId: input.clientRequestId }));
    if (availability !== "ready") {
      throw new CanonicalChatOrchestrationError(availability === "busy"
        ? safeError("chat_busy", "The previous Run is still active. Wait for it to finish.", true, ["retry"])
        : safeError("run_unavailable", "The previous Run could not be checked. Try again shortly.", true, ["retry"]),
      availability === "busy" ? 409 : 503);
    }
    const adapterState = resumeState === undefined ? undefined : {
      schemaVersion: adapter.stateSchemaVersion,
      state: adapter.serializeState(resumeState),
    };
    const timestamp = (deps.now ?? (() => new Date()))().toISOString();
    const run = CanonicalChatRunSchema.parse({
      id: id("run_"),
      chatId,
      turnId,
      attempt: context.latestRun.attempt + 1,
      driverKind: validated.instance.driverKind,
      instanceId: validated.instance.id,
      selection: validated.selection,
      interactionMode: context.latestRun.interactionMode,
      permissionMode: context.latestRun.permissionMode,
      ...(sessionContext ? { context: sessionContext } : {}),
      ...(resolvedRoot ? {
        executionRoot: resolvedRoot.ref,
        executionRootFingerprint: resolvedRoot.fingerprint,
      } : {}),
      status: "accepted",
      historyBoundarySeq: context.turn.baseMessageSeq,
      capabilitySnapshot: {
        revision: validated.instance.catalogRevision,
        rootChat: validated.instance.supports.rootChat,
        attachments: validated.instance.supports.attachments,
        resources: validated.instance.supports.resources,
        tools: validated.instance.supports.tools,
        approvals: validated.instance.supports.approvals,
        userInput: validated.instance.supports.userInput,
        resume: validated.instance.supports.resume,
        cancellation: validated.instance.supports.cancellation,
        steering: validated.instance.supports.steering ?? "none",
        worktrees: validated.instance.supports.worktrees,
        interactionModes: validated.instance.supports.interactionModes,
        permissionModes: validated.instance.supports.permissionModes,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    let admitted;
    deps.reservePendingDispatch(run.id);
    try {
      deps.assertOpen();
      admitted = await deps.repository.admitRetry(owner, {
        chatId,
        turnId,
        clientRequestId: input.clientRequestId,
        baseRevision: input.baseRevision,
        run,
        ...(adapterState ? { adapterState } : {}),
      });
    } catch (error: unknown) {
      deps.releasePendingDispatch(run.id);
      return mapRepositoryError(error);
    }
    try {
      if (!admitted.alreadyAccepted) {
        const stopping = deps.hasStoppingExecution(owner, chatId);
        if (stopping || deps.atCapacity(owner)) {
          await deps.repository.finishRun(owner, {
            chatId,
            runId: admitted.run.id,
            outcome: "failed",
            completedAt: timestamp,
          });
          if (stopping) return mapRepositoryError(new ChatBusyError(chatId));
          throw new CanonicalChatOrchestrationError(
            safeError("run_unavailable", "Chat execution is temporarily busy.", true, ["retry"]),
            503,
          );
        }
        deps.startDispatch(
          owner,
          context.message,
          admitted.run,
          adapter,
          resolvedRoot,
          resumeState,
          retryPromptFor(context.userMessages),
          admissionKey,
        );
      }
      return CanonicalChatRunAdmissionResponseSchema.parse({
        record: admitted.chat,
        turn: admitted.turn,
        run: admitted.run,
        admission: admitted.alreadyAccepted ? "already_accepted" : "accepted",
      });
    } finally {
      deps.releasePendingDispatch(run.id);
    }
}
