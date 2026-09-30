import { type ChatAgentContext, chatContextRequestHash } from "./agent-context.js";
import { chatRequestHash, truthfulCancellationGranularity } from "./argument-digest.js";
import { randomUUID } from "node:crypto";
import { revalidateActionPolicy } from "./action-policy.js";
import {
  CanonicalCreateChatTurnRequestSchema, CanonicalChatMessageSchema, CanonicalChatTurnSchema,
  CanonicalChatRunSchema, CanonicalChatTurnAdmissionResponseSchema,
  ChatRunContextSchema,
  type CanonicalCreateChatTurnRequest, type CanonicalChatMessage, type CanonicalChatRun,
  type CanonicalChatTurnAdmissionResponse,
} from "@matrix-os/contracts";
import type { RequestPrincipal } from "../request-principal.js";
import type { ChatOwner } from "./records.js";
import type { ChatRepository } from "./repository.js";
import { ChatBusyError, ChatNotFoundError } from "./errors.js";
import { dispatchAdmissionKey } from "./dispatch-ownership.js";
import {
  validateChatProviderSelection,
  voiceProviderSelectionRequirements,
  type ChatProviderCatalogService,
} from "./provider-catalog.js";
import type { CanonicalChatProviderRegistry, CanonicalChatProviderAdapter } from "./provider-adapter.js";
import type { ChatExecutionRootResolver, ResolvedChatExecutionRoot } from "./execution-root.js";
import { CanonicalChatOrchestrationError, mapRepositoryError, safeError, requirementsFor } from "./orchestration-input.js";
import { loadChatResumeDecision } from "./resume-checkpoint.js";
import {
  admissionPolicyForTurn,
  type ActiveVoiceSessionPolicy,
  type VoiceSessionPolicyLookup,
} from "./voice-session-policy.js";

export interface TurnAdmissionOptions {
  repository: Pick<ChatRepository, "get" | "findTurnAdmission" | "getLatestAdapterStateForChat" | "admitTurn" | "finishRun" | "kysely">;
  catalog: Pick<ChatProviderCatalogService, "getCatalog">;
  adapters: CanonicalChatProviderRegistry;
  executionRoots?: ChatExecutionRootResolver;
  agentContext?: ChatAgentContext;
  /**
   * Optional live voice-session policy source. When a session owns the Chat
   * its memory/checkpoint/permission policy is stamped onto the admitted run
   * — spoken and typed turns alike — so canonical policy is never bypassed.
   */
  voiceSessionPolicy?: VoiceSessionPolicyLookup;
  now?: () => Date;
  assertOpen(): void;
  assertPersonalExecutionAllowed(owner: ChatOwner, chatId: string): Promise<void>;
  reconcileActiveRuns(owner: ChatOwner): Promise<unknown>;
  reservePendingDispatch(runId: string): void;
  releasePendingDispatch(runId: string): void;
  atCapacity(owner: ChatOwner): boolean;
  hasStoppingExecution(owner: ChatOwner, chatId: string, admissionKey?: string): boolean;
  startDispatch(owner: ChatOwner, message: CanonicalChatMessage, run: CanonicalChatRun,
    adapter: CanonicalChatProviderAdapter, root?: ResolvedChatExecutionRoot, resumeState?: unknown,
    promptOverride?: string, admissionKey?: string): void;
}

const id = (prefix: string) => `${prefix}${randomUUID().replaceAll("-", "")}`;

export interface TurnAdmissionExecutionHints {
  /**
   * Delivery awareness supplied by the caller (e.g. a voice session that knows
   * which assistant responses were never heard). Checkpoints produced by those
   * responses are ineligible for reuse.
   */
  deliveryContext?: { unheardResponses?: readonly string[] };
  /**
   * The admitting voice session's own frozen policy, supplied by the engine
   * for its spoken finals. Falls back to the ambient lookup for typed turns
   * on a session-owned Chat.
   */
  sessionPolicy?: ActiveVoiceSessionPolicy;
}

export async function admitCanonicalTurn(
  deps: TurnAdmissionOptions, principal: RequestPrincipal, owner: ChatOwner,
  chatId: string, inputValue: CanonicalCreateChatTurnRequest,
  admissionHints: TurnAdmissionExecutionHints = {},
): Promise<CanonicalChatTurnAdmissionResponse> {
    deps.assertOpen();
    await deps.assertPersonalExecutionAllowed(owner, chatId);
    await deps.reconcileActiveRuns(owner);
    const input = CanonicalCreateChatTurnRequestSchema.parse(inputValue);
    // A live voice session owns this Chat's execution policy: its frozen
    // memory/checkpoint/permission mode applies before hashing so dedup and
    // the persisted record reflect exactly what will run.
    let sessionPolicy: ActiveVoiceSessionPolicy | undefined;
    try {
      sessionPolicy = admissionHints.sessionPolicy
        ?? deps.voiceSessionPolicy?.policyForChat(chatId);
    } catch (error: unknown) {
      // Fail closed — a lookup failure must not silently skip live policy.
      console.warn("[chat] voice session policy lookup failed:", error instanceof Error ? error.name : "UnknownError");
      throw new CanonicalChatOrchestrationError(
        safeError("service_unavailable", "Chat admission is temporarily unavailable.", true, ["retry"]),
        503,
      );
    }
    const admissionPolicy = admissionPolicyForTurn(input, sessionPolicy);
    const requestHash = chatRequestHash(
      { ...input, permissionMode: admissionPolicy.permissionMode },
      admissionPolicy.runPolicy,
    );
    try {
      const duplicate = await deps.repository.findTurnAdmission(owner, chatId, input.clientRequestId, requestHash);
      if (duplicate) return CanonicalChatTurnAdmissionResponseSchema.parse({ record: duplicate.chat,
        message: duplicate.message, turn: duplicate.turn, run: duplicate.run, admission: "already_accepted" });
    } catch (error: unknown) { return mapRepositoryError(error); }
    const admissionKey = dispatchAdmissionKey("turn", input.clientRequestId);
    if (deps.hasStoppingExecution(owner, chatId, admissionKey)) {
      return mapRepositoryError(new ChatBusyError(chatId));
    }
    const record = await deps.repository.get(owner, chatId);
    if (!record) return mapRepositoryError(new ChatNotFoundError(chatId));
    let prepared;
    try { prepared = await deps.agentContext?.prepare(owner, chatId, input); }
    catch (error: unknown) { return mapRepositoryError(error); }
    const effective = { ...input, ...prepared, permissionMode: admissionPolicy.permissionMode };
    const catalog = await deps.catalog.getCatalog(principal);
    const requirements = requirementsFor({
      ...effective,
      parts: prepared ? input.parts.filter((part) =>
        part.type !== "resource_reference" || !["agent", "chat"].includes(part.resource.kind)) : input.parts,
    });
    const validated = validateChatProviderSelection({
      catalog,
      selection: effective.selection,
      ...(!prepared?.context?.agent && record.providerBinding ? { boundInstanceId: record.providerBinding.instanceId } : {}),
      requirements: {
        ...requirements,
        ...(admissionPolicy.runPolicy?.source === "voice" || admissionPolicy.runPolicy?.voiceSessionId ? voiceProviderSelectionRequirements() : {}),
        ...(admissionPolicy.runPolicy?.executionPolicy ? { qualifiedPolicy: admissionPolicy.runPolicy.executionPolicy } : {}),
      },
    });
    if (!validated.ok) {
      throw new CanonicalChatOrchestrationError(validated.error, validated.error.code === "provider_instance_locked" ? 409 : 400);
    }
    const adapter = deps.adapters.get(validated.instance.driverKind);
    if (!adapter) {
      throw new CanonicalChatOrchestrationError(
        safeError("provider_unavailable", "The selected Provider cannot run yet.", false, ["select_provider"]),
        503,
      );
    }
    try {
      await revalidateActionPolicy(adapter, { driverKind: validated.instance.driverKind, selection: validated.selection, permissionMode: admissionPolicy.permissionMode }, admissionPolicy.runPolicy);
    } catch (error: unknown) {
      console.warn("[chat] action policy qualification failed", error instanceof Error ? error.name : "UnknownError");
      throw new CanonicalChatOrchestrationError(safeError("capability_mismatch", "The selected Provider cannot enforce this execution policy."), 400);
    }
    const rootRef = input.executionRoot
      ?? (record.projectId ? { kind: "project" as const, projectId: record.projectId } : undefined);
    if (input.executionRoot && record.projectId && input.executionRoot.projectId !== record.projectId) {
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
    const resumeDecision = prepared?.context?.agent ? undefined : await loadChatResumeDecision({
      repository: deps.repository, owner, chatId, adapter,
      instanceId: validated.instance.id,
      executionRootFingerprint: resolvedRoot?.fingerprint ?? null,
      mode: "follow_up",
      retainedHistorySupported: true,
      historyBoundarySeq: record.chat.messageCount,
      ...(admissionPolicy.runPolicy ? { runPolicy: admissionPolicy.runPolicy } : {}),
      ...(admissionHints.deliveryContext ? { deliveryContext: admissionHints.deliveryContext } : {}),
    });
    const resumeState = resumeDecision?.resumeState;
    if (resumeDecision?.retainedHistory) {
      // Retain canonical history the resumed session does not contain — or,
      // on a rebuild decision, give the provider the heard-safe projection.
      prepared = {
        ...prepared,
        context: ChatRunContextSchema.parse({
          ...prepared?.context,
          version: 1,
          requestHash: chatContextRequestHash(input),
          chats: prepared?.context?.chats ?? [],
          history: resumeDecision.retainedHistory,
        }),
      };
    } else if (resumeState !== undefined && prepared?.context?.history
      && resumeDecision?.mode === "resume") {
      // A clean-resume checkpoint already covers the prepared snapshot.
      const { history: _history, ...context } = prepared.context;
      prepared.context = context;
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
      ...(prepared?.context ? { context: prepared.context } : {}),
      permissionMode: admissionPolicy.permissionMode,
      ...(admissionPolicy.runPolicy ? { runPolicy: admissionPolicy.runPolicy } : {}),
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
        // Snapshots only promise what the loaded adapter can actually honour.
        cancellation: truthfulCancellationGranularity(validated.instance.supports.cancellation, adapter),
        ...(validated.instance.supports.approvalBinding
          ? { approvalBinding: validated.instance.supports.approvalBinding }
          : {}),
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
      admitted = await deps.repository.admitTurn(owner, {
        chatId,
        baseRevision: input.baseRevision,
        requestHash,
        message,
        turn,
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
          admitted.message,
          admitted.run,
          adapter,
          resolvedRoot,
          resumeState,
          undefined,
          admissionKey,
        );
      }
      return CanonicalChatTurnAdmissionResponseSchema.parse({
        record: admitted.chat,
        message: admitted.message,
        turn: admitted.turn,
        run: admitted.run,
        admission: admitted.alreadyAccepted ? "already_accepted" : "accepted",
      });
    } finally {
      deps.releasePendingDispatch(run.id);
    }
}
