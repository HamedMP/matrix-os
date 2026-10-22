import { ROUTINE_DIRECT_DISPATCH, type RoutineDirectDispatch } from "./routine-direct-admission.js";
import { routineCreationContext } from "./routine-creation-policy.js";
import { prepareChatSessionContext } from "./session-history.js";
import { chatContextRequestHash, type ChatAgentContext } from "./agent-context.js";
import { randomUUID } from "node:crypto";
import {
  CanonicalCreateChatTurnRequestSchema, CanonicalChatMessageSchema, CanonicalChatTurnSchema,
  CanonicalChatRunSchema, CanonicalChatTurnAdmissionResponseSchema,
  type CanonicalCreateChatTurnRequest, type CanonicalChatMessage, type CanonicalChatRun,
  type CanonicalChatTurnAdmissionResponse,
  canonicalExecutionRootProjectId, type ProjectSetupMarkdownKind,
} from "@matrix-os/contracts";
import type { RequestPrincipal } from "../request-principal.js";
import type { ChatOwner } from "./records.js";
import type { ChatRepository } from "./repository.js";
import { ChatBusyError, ChatNotFoundError } from "./errors.js";
import { dispatchAdmissionKey } from "./dispatch-ownership.js";
import { validateChatProviderSelection, type ChatProviderCatalogService } from "./provider-catalog.js";
import type { CanonicalChatProviderRegistry, CanonicalChatProviderAdapter } from "./provider-adapter.js";
import type { ChatExecutionRootResolver, ResolvedChatExecutionRoot } from "./execution-root.js";
import { CanonicalChatOrchestrationError, mapRepositoryError, safeError, requirementsFor } from "./orchestration-input.js";
import { loadChatResumeState } from "./resume-checkpoint.js";
import { unsupportedAgentPermissionMode } from "./agent-permission.js";
import { supportsProjectSetupInterviewProvider } from "./project-setup-interview-context.js";
import { performance } from "node:perf_hooks";
import { chatSendTimingsEnabled, createChatSendTimer, type ChatSendTimer } from "./send-timing.js";
import type { GoogleModelHistoryReader } from "../google-data/runtime/model-history-reader.js";

export interface TurnAdmissionOptions {
  repository: Pick<ChatRepository, "get" | "getDetailPage" | "findTurnAdmission" | "getLatestAdapterStateForChat" | "admitTurn" | "finishRun">;
  catalog: Pick<ChatProviderCatalogService, "getCatalog">;
  adapters: CanonicalChatProviderRegistry;
  executionRoots?: ChatExecutionRootResolver;
  agentContext?: ChatAgentContext;
  modelHistory?: GoogleModelHistoryReader;
  now?: () => Date;
  assertOpen(): void;
  assertPersonalExecutionAllowed(owner: ChatOwner, chatId: string): Promise<void>;
  reconcileActiveRuns(owner: ChatOwner): Promise<unknown>;
  reservePendingDispatch(runId: string): void;
  releasePendingDispatch(runId: string): void;
  atCapacity(owner: ChatOwner, reservedRunId?: string): boolean;
  hasStoppingExecution(owner: ChatOwner, chatId: string, admissionKey?: string): boolean;
  beforePreviewDispatch?: (input: { actorId: string; chatId: string; turnId: string; runId: string;
    clientRequestId: string; body: CanonicalCreateChatTurnRequest; proof: string }) => Promise<void | (() => void)>;
  beforeRoutineCreationAdmission?: (input: import("./routine-creation-policy.js").RoutineCreationAdmission) => Promise<void>;
  beforeRoutineFullAccessDispatch?: (input: RoutineFullAccessTurnAdmission) => Promise<void | (() => void)>;
  startDispatch(owner: ChatOwner, message: CanonicalChatMessage, run: CanonicalChatRun,
    adapter: CanonicalChatProviderAdapter, root?: ResolvedChatExecutionRoot, resumeState?: unknown,
    promptOverride?: string, admissionKey?: string): Promise<void>;
}

export const PROJECT_SETUP_DRAFTING = Symbol("project-setup-drafting");

export interface CanonicalTurnProvenance {
  [PROJECT_SETUP_DRAFTING]?: { revision: number; mode?: never } | {
    revision: number; mode: "interview"; prompt: string;
    withheldMarkdown: ProjectSetupMarkdownKind[];
  };
  [ROUTINE_DIRECT_DISPATCH]?: RoutineDirectDispatch;
  routineCreationProof?: string;
  previewTurnProof?: string;
  routineFullAccessProof?: string;
}

/** Process-private admission port. The proof never reaches provider input or persisted records. */
export interface RoutineFullAccessTurnAdmission {
  principal: RequestPrincipal;
  owner: ChatOwner;
  chatId: string;
  run: CanonicalChatRun;
  body: CanonicalCreateChatTurnRequest;
  proof: string;
}

const id = (prefix: string) => `${prefix}${randomUUID().replaceAll("-", "")}`;

export async function admitCanonicalTurn(
  deps: TurnAdmissionOptions, principal: RequestPrincipal, owner: ChatOwner,
  chatId: string, inputValue: CanonicalCreateChatTurnRequest,
  provenance?: CanonicalTurnProvenance,
): Promise<CanonicalChatTurnAdmissionResponse> {
  if (!chatSendTimingsEnabled()) return admitTimedTurn(deps, principal, owner, chatId, inputValue, provenance, undefined);
  const timer = createChatSendTimer(String(inputValue.clientRequestId));
  const startedAt = performance.now();
  try {
    return await admitTimedTurn(deps, principal, owner, chatId, inputValue, provenance, timer);
  } finally {
    timer.mark("admission_total", startedAt);
  }
}

async function admitTimedTurn(
  deps: TurnAdmissionOptions, principal: RequestPrincipal, owner: ChatOwner,
  chatId: string, inputValue: CanonicalCreateChatTurnRequest,
  provenance: CanonicalTurnProvenance | undefined,
  timer: ChatSendTimer | undefined,
): Promise<CanonicalChatTurnAdmissionResponse> {
    let phaseStartedAt = timer ? performance.now() : 0;
    deps.assertOpen();
    await deps.assertPersonalExecutionAllowed(owner, chatId);
    const input = CanonicalCreateChatTurnRequestSchema.parse(inputValue);
    const setup = provenance?.[PROJECT_SETUP_DRAFTING];
    const interview = setup?.mode === "interview" ? setup : undefined;
    if (interview && (owner.type !== "personal" || principal.userId !== owner.ownerId
      || input.executionRoot?.kind !== "project" || input.permissionMode !== "supervised"
      || input.routineCreation || input.parts.some(part => part.type !== "text")
      || !interview.prompt.trim() || Buffer.byteLength(interview.prompt) > 60 * 1024)) {
      throw new CanonicalChatOrchestrationError(safeError("authorization_failed", "Project setup is unavailable."), 400);
    }
    if (input.routineCreation && (owner.type !== "personal" || principal.userId !== owner.ownerId)) {
      throw new CanonicalChatOrchestrationError(safeError("authorization_failed", "Persistent task selection is unavailable."), 400);
    }
    if (!input.routineCreation) await deps.reconcileActiveRuns(owner);
    const requestHash = chatContextRequestHash(input);
    try {
      const duplicate = await deps.repository.findTurnAdmission(owner, chatId, input.clientRequestId, requestHash);
      if (duplicate) return CanonicalChatTurnAdmissionResponseSchema.parse({ record: duplicate.chat,
        message: duplicate.message, turn: duplicate.turn, run: duplicate.run, admission: "already_accepted" });
    } catch (error: unknown) { return mapRepositoryError(error); }
    // The owner-scoped receipt can be read again. New work still needs a fresh browser proof.
    if (input.routineCreation) {
      if (!deps.beforeRoutineCreationAdmission) throw new CanonicalChatOrchestrationError(safeError("authorization_failed", "Persistent task selection is unavailable."), 400);
      await deps.beforeRoutineCreationAdmission({ principal, owner, chatId, body: input, proof: provenance?.routineCreationProof, path: "turns" });
      await deps.reconcileActiveRuns(owner);
    }
    const admissionKey = dispatchAdmissionKey("turn", input.clientRequestId);
    if (deps.hasStoppingExecution(owner, chatId, admissionKey)) {
      return mapRepositoryError(new ChatBusyError(chatId));
    }
    const record = await deps.repository.get(owner, chatId);
    if (!record || (interview && (!record.projectId || record.chat.collaboration))) return mapRepositoryError(new ChatNotFoundError(chatId));
    let prepared;
    try { prepared = interview ? undefined : await deps.agentContext?.prepare(owner, chatId, input); }
    catch (error: unknown) { return mapRepositoryError(error); }
    const effective = { ...input, ...prepared };
    timer?.mark("admission_pre_catalog", phaseStartedAt);
    const catalogStartedAt = timer ? performance.now() : 0;
    const catalog = timer
      ? await timer.run(() => deps.catalog.getCatalog(principal, effective.selection))
      : await deps.catalog.getCatalog(principal, effective.selection);
    if (timer) {
      timer.mark("catalog_admission", catalogStartedAt);
      phaseStartedAt = performance.now();
    }
    const requirements = requirementsFor({ ...effective, parts: prepared ? input.parts.filter((part) =>
      part.type !== "resource_reference" || !["agent", "chat"].includes(part.resource.kind)) : input.parts });
    const validated = validateChatProviderSelection({
      catalog,
      selection: effective.selection,
      ...(!interview && !prepared?.context?.agent && record.providerBinding ? { boundInstanceId: record.providerBinding.instanceId } : {}),
      requirements,
    });
    if (!validated.ok) {
      const agentModeError = validated.error.code === "capability_mismatch"
        ? unsupportedAgentPermissionMode(catalog, effective.selection, requirements, Boolean(prepared?.context?.agent))
        : null;
      throw new CanonicalChatOrchestrationError(agentModeError ?? validated.error, validated.error.code === "provider_instance_locked" ? 409 : 400);
    }
    const adapter = deps.adapters.get(validated.instance.driverKind);
    if (interview && (!supportsProjectSetupInterviewProvider(validated.instance.driverKind)
      || input.interactionMode !== (validated.instance.driverKind === "matrix_pi" ? "default" : "review"))) {
      throw new CanonicalChatOrchestrationError(safeError("provider_unavailable", "This Provider is unavailable for project setup.", false, ["select_provider"]), 400);
    }
    if (!adapter) {
      throw new CanonicalChatOrchestrationError(
        safeError("provider_unavailable", "The selected Provider cannot run yet.", false, ["select_provider"]),
        503,
      );
    }
    // Bot workspaces are assigned by bot admission on the server; a client never supplies one,
    // so no ordinary Chat can mount a bot's private files.
    if (input.executionRoot?.kind === "bot_workspace") {
      throw new CanonicalChatOrchestrationError(
        safeError("project_unavailable", "The selected workspace does not belong to this Chat's Project."),
        400,
      );
    }
    const rootRef = input.executionRoot
      ?? (record.projectId ? { kind: "project" as const, projectId: record.projectId } : undefined);
    if (input.executionRoot && record.projectId
      && canonicalExecutionRootProjectId(input.executionRoot) !== record.projectId) {
      throw new CanonicalChatOrchestrationError(
        safeError("project_unavailable", "The selected workspace does not belong to this Chat's Project."),
        400,
      );
    }
    if (validated.instance.workspaceRequirement === "project_required" && rootRef === undefined) {
      throw new CanonicalChatOrchestrationError(
        safeError("project_required", "This Provider requires a Project.", false, ["return_to_project"]),
        400,
      );
    }
    let resolvedRoot: Awaited<ReturnType<ChatExecutionRootResolver["resolve"]>> | undefined;
    if (rootRef !== undefined) {
      if (!deps.executionRoots) {
        throw new CanonicalChatOrchestrationError(
          safeError("project_unavailable", "The Project workspace is unavailable.", true, ["retry"]),
          503,
        );
      }
      try {
        resolvedRoot = await deps.executionRoots.resolve(owner, rootRef);
      } catch (error: unknown) {
        console.warn("[chat/orchestrator] Execution root resolution failed:", error instanceof Error ? error.name : "UnknownError");
        throw new CanonicalChatOrchestrationError(
          safeError("project_unavailable", "The Project workspace is unavailable.", true, ["retry"]),
          503,
        );
      }
    }
    await deps.modelHistory?.assertRun({ owner, chatId, adapter });
    const resumeState = prepared?.context?.agent || setup ? undefined : await loadChatResumeState({
      repository: deps.repository, owner, chatId, adapter,
      modelHistory: deps.modelHistory,
      instanceId: validated.instance.id,
      selection: validated.selection, interactionMode: effective.interactionMode, permissionMode: effective.permissionMode,
      context: prepared?.context,
      executionRootFingerprint: resolvedRoot?.fingerprint ?? null,
      mode: "follow_up",
    });
    let sessionContext: CanonicalChatRun["context"];
    try {
      sessionContext = interview ? undefined : await prepareChatSessionContext({
        repository: deps.repository, owner, chatId, throughSeq: record.chat.messageCount,
        modelHistory: deps.modelHistory, adapter,
        requestHash, instanceId: validated.instance.id, resumeState, context: routineCreationContext(input, prepared?.context),
      });
    } catch (error: unknown) { return mapRepositoryError(error); }
    if (setup) {
      sessionContext = { version: 1, requestHash, chats: [], ...sessionContext,
        projectSetupDraft: { revision: setup.revision,
          ...(interview ? { mode: "interview", withheldMarkdown: interview.withheldMarkdown } : {}) } };
    }
    const adapterState = resumeState === undefined ? undefined : {
      schemaVersion: adapter.stateSchemaVersion,
      state: adapter.serializeState(resumeState),
    };

    const timestamp = (deps.now ?? (() => new Date()))().toISOString();
    const turnId = id("cturn_");
    const message = CanonicalChatMessageSchema.parse({
      id: id("msg_"),
      chatId,
      seq: record.chat.messageCount + 1,
      role: "user",
      state: "committed",
      actorId: principal.userId,
      purpose: "ai_request",
      turnId,
      parts: input.parts,
      createdAt: timestamp,
    });
    const turn = CanonicalChatTurnSchema.parse({
      id: turnId,
      chatId,
      clientRequestId: input.clientRequestId,
      baseMessageSeq: record.chat.messageCount,
      inputMessageId: message.id,
      status: "accepted",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const run = CanonicalChatRunSchema.parse({
      id: id("run_"),
      chatId,
      turnId,
      attempt: 1,
      driverKind: validated.instance.driverKind,
      instanceId: validated.instance.id,
      selection: validated.selection,
      interactionMode: effective.interactionMode,
      ...(sessionContext ? { context: sessionContext } : {}),
      permissionMode: effective.permissionMode,
      ...(resolvedRoot ? {
        executionRoot: resolvedRoot.ref,
        executionRootFingerprint: resolvedRoot.fingerprint,
      } : {}),
      status: "accepted",
      historyBoundarySeq: turn.baseMessageSeq,
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
      timer?.mark("admission_post_catalog", phaseStartedAt);
      const repositoryStartedAt = timer ? performance.now() : 0;
      admitted = await deps.repository.admitTurn(owner, {
        chatId,
        baseRevision: input.baseRevision,
        requestHash,
        message,
        turn,
        run,
        ...(adapterState ? { adapterState } : {}),
      });
      timer?.mark("repository_admission", repositoryStartedAt);
      timer?.linkRun(admitted.run.id, admitted.run.driverKind);
    } catch (error: unknown) {
      deps.releasePendingDispatch(run.id);
      return mapRepositoryError(error);
    }

    let previewCleanup: void | (() => void) = undefined;
    let routineCleanup: void | (() => void) = undefined;
    const disposePendingAuthorities = () => {
      try {
        previewCleanup?.();
      } catch (error: unknown) {
        console.warn("[chat] Preview Drive admission cleanup failed", error instanceof Error ? error.name : "UnknownError");
      }
      try {
        routineCleanup?.();
      } catch (error: unknown) {
        console.warn("[chat] Routine Full Access admission cleanup failed", error instanceof Error ? error.name : "UnknownError");
      }
    };
    let dispatched = false;
    try {
      if (!admitted.alreadyAccepted) {
        const stopping = deps.hasStoppingExecution(owner, chatId);
        if (stopping || deps.atCapacity(owner, run.id)) {
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
        if (adapter.driverKind === "claude_code" && input.permissionMode === "supervised"
          && input.interactionMode === "default" && provenance?.previewTurnProof
          && deps.beforePreviewDispatch) {
          try {
            previewCleanup = await deps.beforePreviewDispatch({ actorId: principal.userId, chatId, turnId: admitted.turn.id,
              runId: admitted.run.id, clientRequestId: input.clientRequestId, body: input,
              proof: provenance.previewTurnProof });
          } catch (error: unknown) {
            // The Chat turn remains valid, but the personal integration stays unavailable.
            console.warn("[chat] Preview Drive turn redemption failed", error instanceof Error ? error.name : "UnknownError");
          }
        }
        if (input.permissionMode === "full_access" && input.interactionMode === "default"
          && provenance?.routineFullAccessProof && deps.beforeRoutineFullAccessDispatch) {
          try {
            routineCleanup = await deps.beforeRoutineFullAccessDispatch({ principal, owner, chatId, run: admitted.run,
              body: input, proof: provenance.routineFullAccessProof });
          } catch (error: unknown) {
            console.warn("[chat] Routine Full Access origin unavailable", error instanceof Error ? error.name : "UnknownError");
          }
        }
        // Redemption yields to other admissions and shutdown. Keep this final
        // check synchronous with startDispatch's active registration.
        try {
          deps.assertOpen();
          if (deps.hasStoppingExecution(owner, chatId)) return mapRepositoryError(new ChatBusyError(chatId));
          if (deps.atCapacity(owner, run.id)) {
            throw new CanonicalChatOrchestrationError(
              safeError("run_unavailable", "Chat execution is temporarily busy.", true, ["retry"]),
              503,
            );
          }
        } catch (error: unknown) {
          await deps.repository.finishRun(owner, {
            chatId, runId: admitted.run.id, outcome: "failed",
            completedAt: (deps.now ?? (() => new Date()))().toISOString(),
          });
          throw error;
        }
        const completion = deps.startDispatch(
          owner,
          admitted.message,
          admitted.run,
          adapter,
          resolvedRoot,
          resumeState,
          interview?.prompt,
          admissionKey,
        );
        // Startup may fail before a provider issues the capability. Disposal
        // only removes this exact pending entry; issued capabilities own cleanup.
        if (previewCleanup || routineCleanup) void completion.then(disposePendingAuthorities, disposePendingAuthorities);
        dispatched = true;
      }
      return CanonicalChatTurnAdmissionResponseSchema.parse({
        record: admitted.chat,
        message: admitted.message,
        turn: admitted.turn,
        run: admitted.run,
        admission: admitted.alreadyAccepted ? "already_accepted" : "accepted",
      });
    } finally {
      try {
        if (!dispatched) disposePendingAuthorities();
      } finally {
        deps.releasePendingDispatch(run.id);
      }
    }
}
