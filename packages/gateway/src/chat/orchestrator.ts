import { createHash, randomUUID } from "node:crypto";
import {
  CanonicalChatMessageSchema,
  CanonicalChatRunActivitySchema,
  CanonicalChatRunAdmissionResponseSchema,
  CanonicalChatRunSteeringResponseSchema,
  CanonicalChatRunSchema,
  CanonicalChatSafeErrorSchema,
  CanonicalChatTurnAdmissionResponseSchema,
  CanonicalChatTurnSchema,
  CanonicalCreateChatTurnRequestSchema,
  CanonicalQueueChatTurnRequestSchema,
  CanonicalRetryChatTurnRequestSchema,
  CanonicalSubmitChatApprovalRequestSchema,
  CanonicalSteerChatRunRequestSchema,
  CanonicalSteerQueuedChatTurnRequestSchema,
  type CanonicalChatMessage,
  type CanonicalChatRun,
  type CanonicalChatRunActivity,
  type CanonicalChatRunAdmissionResponse,
  type CanonicalChatQueueAdmissionResponse,
  type CanonicalChatRunCancellationResponse,
  type CanonicalChatRunSteeringResponse,
  type CanonicalChatSafeError,
  type CanonicalChatTurnAdmissionResponse,
  type CanonicalCreateChatTurnRequest,
  type CanonicalQueueChatTurnRequest,
  type CanonicalRetryChatTurnRequest,
  type CanonicalSubmitChatApprovalRequest,
  type CanonicalSteerChatRunRequest,
  type CanonicalSteerQueuedChatTurnRequest,
  type CanonicalChatApprovalSubmissionResponse,
} from "@matrix-os/contracts";
import type { RequestPrincipal } from "../request-principal.js";
import type { AiGenerationInput } from "../ai-analytics.js";
import type {
  ChatExecutionRootProvenance,
  ChatExecutionRootResolver,
  ResolvedChatExecutionRoot,
} from "./execution-root.js";
import {
  validateChatProviderSelection,
  type ChatProviderCatalogService,
} from "./provider-catalog.js";
import {
  CanonicalProviderRunEventSchema,
  type CanonicalChatProviderAdapter,
  type CanonicalProviderRunEvent,
  type CanonicalProviderRunInput,
  CanonicalChatProviderRegistry,
} from "./provider-adapter.js";
import {
  ChatBusyError,
  ChatConflictError,
  ChatNotFoundError,
  ChatProviderInstanceLockedError,
  ChatRunNotAcknowledgeableError,
  ChatRunNotActiveError,
  type ChatRepository,
} from "./repository.js";
import type { ChatOwner } from "./records.js";
import {
  CanonicalQueueAdmissionError,
  enqueueCanonicalQueuedTurn,
} from "./queue-admission.js";

const MAX_ACTIVE_RUNS_GLOBAL = 64;
const MAX_ACTIVE_RUNS_PER_OWNER = 8;
const MAX_ASSISTANT_TEXT = 96 * 1024;
const STEER_FINALIZE_ATTEMPTS = 2;

export class CanonicalChatOrchestrationError extends Error {
  constructor(readonly safeError: CanonicalChatSafeError, readonly status: 400 | 404 | 409 | 503) {
    super(safeError.safeMessage);
    this.name = "CanonicalChatOrchestrationError";
  }
}

interface ActiveRun {
  controller: AbortController;
  adapter: CanonicalChatProviderAdapter;
  owner: ChatOwner;
  chatId: string;
  runId: string;
  instanceId: string;
  completion: Promise<void>;
}

function id(prefix: "cturn_" | "run_" | "msg_" | "activity_" | "steer_"): string {
  return `${prefix}${randomUUID().replaceAll("-", "")}`;
}

function analyticsProvider(model: string, driverKind: CanonicalChatRun["driverKind"]): string {
  const qualified = /^([a-z0-9_-]+)[:/]/i.exec(model)?.[1]?.toLowerCase();
  if (qualified === "openai-codex") return "openai";
  if (qualified) return qualified;
  if (driverKind === "codex") return "openai";
  if (driverKind === "claude_code" || driverKind === "kernel") return "anthropic";
  return "unknown";
}

async function finalizeAcceptedSteer<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= STEER_FINALIZE_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error: unknown) {
      if (error instanceof ChatNotFoundError
        || error instanceof ChatRunNotActiveError
        || error instanceof ChatConflictError) {
        throw error;
      }
      lastError = error;
      if (attempt < STEER_FINALIZE_ATTEMPTS) {
        console.warn(
          "[chat/orchestrator] Steering finalization failed; retrying:",
          error instanceof Error ? error.name : "UnknownError",
        );
      }
    }
  }
  throw lastError;
}

function mapSteerFinalizationError(error: unknown): never {
  if (error instanceof ChatNotFoundError
    || error instanceof ChatRunNotActiveError
    || error instanceof ChatConflictError) {
    return mapRepositoryError(error);
  }
  console.warn(
    "[chat/orchestrator] Accepted steering could not be finalized:",
    error instanceof Error ? error.name : "UnknownError",
  );
  throw new CanonicalChatOrchestrationError(
    safeError("run_unavailable", "The steering request is still resolving. Try again.", true, ["retry"]),
    503,
  );
}

function activityPersistenceId(runId: string, event: Record<string, unknown>): string {
  if (event.type !== "agent.activity" || typeof event.activityId !== "string") return id("activity_");
  const digest = createHash("sha256").update(`${runId}\0${event.activityId}`).digest("hex").slice(0, 32);
  return `activity_${digest}`;
}

function assistantMessageId(runId: string, providerMessageId?: string): string {
  if (!providerMessageId) return `msg_${runId.slice("run_".length)}_assistant`;
  const digest = createHash("sha256").update(`${runId}\0${providerMessageId}`).digest("hex").slice(0, 32);
  return `msg_${digest}`;
}

function safeError(
  code: CanonicalChatSafeError["code"],
  safeMessage: string,
  retryable = false,
  recoveryActions?: CanonicalChatSafeError["recoveryActions"],
): CanonicalChatSafeError {
  return CanonicalChatSafeErrorSchema.parse({
    code,
    safeMessage,
    retryable,
    ...(recoveryActions ? { recoveryActions } : {}),
  });
}

function promptFor(parts: CanonicalCreateChatTurnRequest["parts"]): string {
  const lines = parts.flatMap((part) => {
    if (part.type === "text") return [part.text];
    if (part.type === "invocation_reference") {
      return [`${part.invocation.invocation}${part.invocation.arguments ? ` ${part.invocation.arguments}` : ""}`];
    }
    if (part.type === "resource_reference") return [`@${part.resource.label}`];
    if (part.type === "attachment_reference" && !part.ownerReference) return [`@${part.label}`];
    return [];
  });
  const attachmentReferences = parts.flatMap((part) => (
    part.type === "attachment_reference" && part.ownerReference
      ? [`- ${JSON.stringify(part.label)}: ${shellQuotedOwnerReference(part.ownerReference)}`]
      : []
  ));
  if (attachmentReferences.length > 0) {
    lines.push(
      "",
      "Attached files (available on this Matrix computer):",
      ...attachmentReferences,
    );
  }
  const prompt = lines.join("\n").trim();
  if (!prompt) throw new CanonicalChatOrchestrationError(
    safeError("capability_mismatch", "The message does not contain supported input."),
    400,
  );
  return prompt;
}

function retryPromptFor(messages: CanonicalChatMessage[]): string {
  return messages.map((message) => promptFor(message.parts)).join("\n\n");
}

function shellQuotedOwnerReference(ownerReference: string): string {
  return `"$MATRIX_HOME"/'${ownerReference.replaceAll("'", "'\\''")}'`;
}

function requirementsFor(input: CanonicalCreateChatTurnRequest) {
  return {
    attachments: input.parts.flatMap((part) =>
      part.type === "attachment_reference" ? [part.kind] : []
    ),
    resources: input.parts.flatMap((part) =>
      part.type === "resource_reference" ? [part.resource.kind] : []
    ),
    interactionMode: input.interactionMode,
    permissionMode: input.permissionMode,
    worktree: input.executionRoot?.kind === "worktree",
  };
}

export function mapRepositoryError(error: unknown): never {
  if (error instanceof ChatNotFoundError) {
    throw new CanonicalChatOrchestrationError(safeError("chat_not_found", "Chat not found."), 404);
  }
  if (error instanceof ChatBusyError) {
    throw new CanonicalChatOrchestrationError(safeError("chat_busy", "This Chat already has an active Run."), 409);
  }
  if (error instanceof ChatProviderInstanceLockedError) {
    throw new CanonicalChatOrchestrationError(safeError(
      "provider_instance_locked",
      "This Chat is already bound to another Provider instance.",
      false,
      ["fork_chat", "start_new_chat"],
    ), 409);
  }
  if (error instanceof ChatRunNotAcknowledgeableError) {
    throw new CanonicalChatOrchestrationError(safeError(
      "run_unavailable",
      "Only a successful completed Run can be acknowledged.",
    ), 409);
  }
  if (error instanceof ChatRunNotActiveError) {
    throw new CanonicalChatOrchestrationError(
      safeError("run_unavailable", "The Run is no longer active."),
      409,
    );
  }
  if (error instanceof ChatConflictError) {
    throw new CanonicalChatOrchestrationError(safeError("chat_conflict", "Chat changed. Refresh and try again.", true, ["retry"]), 409);
  }
  throw error;
}

export class CanonicalChatOrchestrator {
  private readonly active = new Map<string, ActiveRun>();
  private readonly pendingDispatch = new Set<string>();
  private readonly queueDispatches = new Set<string>();
  private readonly reconciliation = new Map<string, Promise<number>>();
  private readonly shutdownDrainMs: number;
  private closing = false;

  constructor(private readonly options: {
    repository: Pick<ChatRepository,
      | "get"
      | "admitTurn"
      | "enqueueQueuedTurn"
      | "claimNextQueuedTurn"
      | "listQueuedChatIds"
      | "beginSteer"
      | "acceptSteer"
      | "failSteer"
      | "beginQueuedTurnSteer"
      | "acceptQueuedTurnSteer"
      | "failQueuedTurnSteer"
      | "markRunRunning"
      | "appendRunActivities"
      | "appendAssistantDelta"
      | "updateAdapterState"
      | "finishRun"
      | "getAdapterState"
      | "getPendingApproval"
      | "getLatestAdapterStateForChat"
      | "getTurnRunContext"
      | "admitRetry"
      | "listActiveRunContexts"
    >;
    catalog: Pick<ChatProviderCatalogService, "getCatalog">;
    adapters: CanonicalChatProviderRegistry;
    executionRoots?: ChatExecutionRootResolver;
    onAiGeneration?: (input: AiGenerationInput) => void;
    now?: () => Date;
    shutdownDrainMs?: number;
  }) {
    this.shutdownDrainMs = options.shutdownDrainMs ?? 10_000;
    if (!Number.isInteger(this.shutdownDrainMs) || this.shutdownDrainMs < 1 || this.shutdownDrainMs > 60_000) {
      throw new RangeError("Invalid canonical Chat shutdown drain timeout");
    }
  }

  get activeCount(): number {
    return this.active.size;
  }

  private atCapacity(owner: ChatOwner): boolean {
    if (this.active.size >= MAX_ACTIVE_RUNS_GLOBAL) return true;
    let ownerActive = 0;
    for (const entry of this.active.values()) {
      if (entry.owner.type === owner.type && entry.owner.ownerId === owner.ownerId) ownerActive += 1;
    }
    return ownerActive >= MAX_ACTIVE_RUNS_PER_OWNER;
  }

  private assertOpen(): void {
    if (this.closing) {
      throw new CanonicalChatOrchestrationError(
        safeError("run_unavailable", "Chat execution is shutting down.", true, ["retry"]),
        503,
      );
    }
  }

  private reservePendingDispatch(runId: string): void {
    if (!this.pendingDispatch.has(runId) && this.pendingDispatch.size >= MAX_ACTIVE_RUNS_GLOBAL) {
      throw new CanonicalChatOrchestrationError(
        safeError("run_unavailable", "Chat execution is temporarily busy.", true, ["retry"]),
        503,
      );
    }
    this.pendingDispatch.add(runId);
  }

  async admitTurn(
    principal: RequestPrincipal,
    owner: ChatOwner,
    chatId: string,
    inputValue: CanonicalCreateChatTurnRequest,
  ): Promise<CanonicalChatTurnAdmissionResponse> {
    this.assertOpen();
    await this.reconcileActiveRuns(owner);
    const input = CanonicalCreateChatTurnRequestSchema.parse(inputValue);
    const record = await this.options.repository.get(owner, chatId);
    if (!record) return mapRepositoryError(new ChatNotFoundError(chatId));
    const catalog = await this.options.catalog.getCatalog(principal);
    const validated = validateChatProviderSelection({
      catalog,
      selection: input.selection,
      ...(record.providerBinding ? { boundInstanceId: record.providerBinding.instanceId } : {}),
      requirements: requirementsFor(input),
    });
    if (!validated.ok) {
      throw new CanonicalChatOrchestrationError(validated.error, validated.error.code === "provider_instance_locked" ? 409 : 400);
    }
    const adapter = this.options.adapters.get(validated.instance.driverKind);
    if (!adapter) {
      throw new CanonicalChatOrchestrationError(
        safeError("provider_unavailable", "The selected Provider cannot run yet.", false, ["select_provider"]),
        503,
      );
    }
    const previousState = await this.options.repository.getLatestAdapterStateForChat(owner, {
      chatId,
      driverKind: validated.instance.driverKind,
      instanceId: validated.instance.id,
    });
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
      if (!this.options.executionRoots) {
        throw new CanonicalChatOrchestrationError(
          safeError("project_unavailable", "The Project workspace is unavailable.", true, ["retry"]),
          503,
        );
      }
      try {
        resolvedRoot = await this.options.executionRoots.resolve(owner, rootRef);
      } catch (error: unknown) {
        console.warn("[chat/orchestrator] Execution root resolution failed:", error instanceof Error ? error.name : "UnknownError");
        throw new CanonicalChatOrchestrationError(
          safeError("project_unavailable", "The Project workspace is unavailable.", true, ["retry"]),
          503,
        );
      }
    }
    const resumeState = previousState?.schemaVersion === adapter.stateSchemaVersion
      && (previousState.executionRootFingerprint ?? null) === (resolvedRoot?.fingerprint ?? null)
      ? adapter.parseState(previousState.state)
      : undefined;
    const adapterState = resumeState === undefined ? undefined : {
      schemaVersion: adapter.stateSchemaVersion,
      state: adapter.serializeState(resumeState),
    };

    const timestamp = (this.options.now ?? (() => new Date()))().toISOString();
    const turnId = id("cturn_");
    const message = CanonicalChatMessageSchema.parse({
      id: id("msg_"),
      chatId,
      seq: record.chat.messageCount + 1,
      role: "user",
      state: "committed",
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
      interactionMode: input.interactionMode,
      permissionMode: input.permissionMode,
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
    this.reservePendingDispatch(run.id);
    try {
      this.assertOpen();
      admitted = await this.options.repository.admitTurn(owner, {
        chatId,
        baseRevision: input.baseRevision,
        message,
        turn,
        run,
        ...(adapterState ? { adapterState } : {}),
      });
    } catch (error: unknown) {
      this.pendingDispatch.delete(run.id);
      return mapRepositoryError(error);
    }

    try {
      if (!admitted.alreadyAccepted) {
        if (this.atCapacity(owner)) {
          await this.options.repository.finishRun(owner, {
            chatId,
            runId: admitted.run.id,
            outcome: "failed",
            completedAt: timestamp,
          });
          throw new CanonicalChatOrchestrationError(
            safeError("run_unavailable", "Chat execution is temporarily busy.", true, ["retry"]),
            503,
          );
        }
        this.startDispatch(
          owner,
          admitted.message,
          admitted.run,
          adapter,
          resolvedRoot,
          resumeState,
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
      this.pendingDispatch.delete(run.id);
    }
  }

  async enqueueQueuedTurn(
    principal: RequestPrincipal,
    owner: ChatOwner,
    chatId: string,
    inputValue: CanonicalQueueChatTurnRequest,
  ): Promise<CanonicalChatQueueAdmissionResponse> {
    this.assertOpen();
    try {
      return await enqueueCanonicalQueuedTurn({
        principal,
        owner,
        chatId,
        input: CanonicalQueueChatTurnRequestSchema.parse(inputValue),
        repository: this.options.repository,
        catalog: this.options.catalog,
        adapters: this.options.adapters,
        ...(this.options.executionRoots ? { executionRoots: this.options.executionRoots } : {}),
        now: this.options.now ?? (() => new Date()),
      });
    } catch (error: unknown) {
      if (error instanceof CanonicalQueueAdmissionError) {
        throw new CanonicalChatOrchestrationError(error.safeError, error.status);
      }
      return mapRepositoryError(error);
    }
  }

  async retryTurn(
    principal: RequestPrincipal,
    owner: ChatOwner,
    chatId: string,
    turnId: string,
    inputValue: CanonicalRetryChatTurnRequest,
  ): Promise<CanonicalChatRunAdmissionResponse> {
    this.assertOpen();
    await this.reconcileActiveRuns(owner);
    const input = CanonicalRetryChatTurnRequestSchema.parse(inputValue);
    const context = await this.options.repository.getTurnRunContext(owner, chatId, turnId);
    if (!context) {
      throw new CanonicalChatOrchestrationError(safeError("run_not_found", "Run not found."), 404);
    }
    const catalog = await this.options.catalog.getCatalog(principal);
    const validated = validateChatProviderSelection({
      catalog,
      selection: context.latestRun.selection,
      boundInstanceId: context.latestRun.instanceId,
      requirements: {
        interactionMode: context.latestRun.interactionMode,
        permissionMode: context.latestRun.permissionMode,
        worktree: context.latestRun.executionRoot?.kind === "worktree",
      },
    });
    if (!validated.ok) throw new CanonicalChatOrchestrationError(validated.error, 400);
    const adapter = this.options.adapters.get(context.latestRun.driverKind);
    if (!adapter) {
      throw new CanonicalChatOrchestrationError(
        safeError("provider_unavailable", "The selected Provider cannot run yet.", false, ["select_provider"]),
        503,
      );
    }
    let resolvedRoot: ResolvedChatExecutionRoot | undefined;
    if (context.latestRun.executionRoot) {
      if (!this.options.executionRoots) {
        throw new CanonicalChatOrchestrationError(
          safeError("project_unavailable", "The Project workspace is unavailable.", true, ["retry"]),
          503,
        );
      }
      try {
        resolvedRoot = await this.options.executionRoots.resolve(owner, context.latestRun.executionRoot);
      } catch (error: unknown) {
        console.warn("[chat/orchestrator] Retry root resolution failed:", error instanceof Error ? error.name : "UnknownError");
        throw new CanonicalChatOrchestrationError(
          safeError("project_unavailable", "The Project workspace is unavailable.", true, ["retry"]),
          503,
        );
      }
    }
    const previousState = await this.options.repository.getLatestAdapterStateForChat(owner, {
      chatId,
      driverKind: context.latestRun.driverKind,
      instanceId: context.latestRun.instanceId,
    });
    const resumeState = previousState?.schemaVersion === adapter.stateSchemaVersion
      && (previousState.executionRootFingerprint ?? null) === (resolvedRoot?.fingerprint ?? null)
      ? adapter.parseState(previousState.state)
      : undefined;
    const adapterState = resumeState === undefined ? undefined : {
      schemaVersion: adapter.stateSchemaVersion,
      state: adapter.serializeState(resumeState),
    };
    const timestamp = (this.options.now ?? (() => new Date()))().toISOString();
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
    this.reservePendingDispatch(run.id);
    try {
      this.assertOpen();
      admitted = await this.options.repository.admitRetry(owner, {
        chatId,
        turnId,
        clientRequestId: input.clientRequestId,
        baseRevision: input.baseRevision,
        run,
        ...(adapterState ? { adapterState } : {}),
      });
    } catch (error: unknown) {
      this.pendingDispatch.delete(run.id);
      return mapRepositoryError(error);
    }
    try {
      if (!admitted.alreadyAccepted) {
        if (this.atCapacity(owner)) {
          await this.options.repository.finishRun(owner, {
            chatId,
            runId: admitted.run.id,
            outcome: "failed",
            completedAt: timestamp,
          });
          throw new CanonicalChatOrchestrationError(
            safeError("run_unavailable", "Chat execution is temporarily busy.", true, ["retry"]),
            503,
          );
        }
        this.startDispatch(
          owner,
          context.message,
          admitted.run,
          adapter,
          resolvedRoot,
          resumeState,
          retryPromptFor(context.userMessages),
        );
      }
      return CanonicalChatRunAdmissionResponseSchema.parse({
        record: admitted.chat,
        turn: admitted.turn,
        run: admitted.run,
        admission: admitted.alreadyAccepted ? "already_accepted" : "accepted",
      });
    } finally {
      this.pendingDispatch.delete(run.id);
    }
  }

  private startDispatch(
    owner: ChatOwner,
    message: CanonicalChatMessage,
    run: CanonicalChatRun,
    adapter: CanonicalChatProviderAdapter,
    resolvedRoot?: ResolvedChatExecutionRoot,
    resumeState?: unknown,
    promptOverride?: string,
  ): void {
    const controller = new AbortController();
    const completion = this.dispatch(owner, message, run, adapter, controller, resolvedRoot, resumeState, promptOverride)
      .catch((error: unknown) => {
        console.error("[chat/orchestrator] Run dispatch failed:", error instanceof Error ? error.name : "UnknownError");
      })
      .finally(async () => {
        this.active.delete(run.id);
        if (this.closing) return;
        try {
          await this.dispatchNextQueued(owner, run.chatId);
        } catch (error: unknown) {
          console.error(
            "[chat/orchestrator] Queued Run dispatch failed:",
            error instanceof Error ? error.name : "UnknownError",
          );
        }
      });
    this.active.set(run.id, {
      controller,
      adapter,
      owner,
      chatId: run.chatId,
      runId: run.id,
      instanceId: run.instanceId,
      completion,
    });
  }

  private async dispatchNextQueued(owner: ChatOwner, chatId: string): Promise<void> {
    if (this.closing || this.atCapacity(owner)) return;
    for (const entry of this.active.values()) {
      if (entry.chatId === chatId && entry.owner.type === owner.type
        && entry.owner.ownerId === owner.ownerId) return;
    }
    const key = `${owner.type}:${owner.ownerId}:${chatId}`;
    if (this.queueDispatches.has(key) || this.queueDispatches.size >= MAX_ACTIVE_RUNS_GLOBAL) return;
    this.queueDispatches.add(key);
    try {
      for (let offset = 0; offset < 20 && !this.closing && !this.atCapacity(owner); offset += 1) {
        const timestamp = (this.options.now ?? (() => new Date()))().toISOString();
        const claimed = await this.options.repository.claimNextQueuedTurn(owner, {
          chatId,
          turnId: id("cturn_"),
          runId: id("run_"),
          messageId: id("msg_"),
          claimedAt: timestamp,
        });
        if (!claimed) return;
        const adapter = this.options.adapters.get(claimed.run.driverKind);
        let resolvedRoot: ResolvedChatExecutionRoot | undefined;
        let resumeState: unknown;
        try {
          if (!adapter) throw new Error("Queued Provider adapter unavailable");
          if (claimed.run.executionRoot) {
            if (!this.options.executionRoots) throw new Error("Queued execution root resolver unavailable");
            resolvedRoot = await this.options.executionRoots.resolve(owner, claimed.run.executionRoot);
            if (resolvedRoot.fingerprint !== claimed.run.executionRootFingerprint) {
              throw new Error("Queued execution root provenance changed");
            }
          }
          const previousState = await this.options.repository.getLatestAdapterStateForChat(owner, {
            chatId,
            driverKind: claimed.run.driverKind,
            instanceId: claimed.run.instanceId,
          });
          resumeState = previousState?.schemaVersion === adapter.stateSchemaVersion
            && (previousState.executionRootFingerprint ?? null) === (resolvedRoot?.fingerprint ?? null)
            ? adapter.parseState(previousState.state)
            : undefined;
        } catch (error: unknown) {
          console.warn(
            "[chat/orchestrator] Queued Run preparation failed:",
            error instanceof Error ? error.name : "UnknownError",
          );
          await this.options.repository.finishRun(owner, {
            chatId,
            runId: claimed.run.id,
            outcome: "failed",
            completedAt: timestamp,
          });
          continue;
        }
        this.startDispatch(
          owner,
          claimed.message,
          claimed.run,
          adapter,
          resolvedRoot,
          resumeState,
        );
        return;
      }
    } finally {
      this.queueDispatches.delete(key);
    }
  }

  private async dispatch(
    owner: ChatOwner,
    message: CanonicalChatMessage,
    run: CanonicalChatRun,
    adapter: CanonicalChatProviderAdapter,
    controller: AbortController,
    resolvedRoot?: ResolvedChatExecutionRoot,
    resumeState?: unknown,
    promptOverride?: string,
  ): Promise<void> {
    const startedAt = (this.options.now ?? (() => new Date()))().toISOString();
    try {
      if (resolvedRoot && this.options.executionRoots) {
        const provenance: ChatExecutionRootProvenance = {
          ref: resolvedRoot.ref!,
          fingerprint: resolvedRoot.fingerprint,
        };
        resolvedRoot = await this.options.executionRoots.revalidate(owner, provenance);
      }
      await this.options.repository.markRunRunning(owner, { chatId: run.chatId, runId: run.id, startedAt });
      await this.persistActivities(owner, run, [{ type: "run.status", status: "running" }, {
        type: "turn.status",
        turnId: run.turnId,
        status: "running",
      }], startedAt);

      const input: CanonicalProviderRunInput = {
        owner,
        chatId: run.chatId,
        turnId: run.turnId,
        runId: run.id,
        prompt: promptOverride ?? promptFor(message.parts),
        parts: message.parts,
        selection: run.selection,
        interactionMode: run.interactionMode,
        permissionMode: run.permissionMode,
        ...(resolvedRoot ? { executionRoot: resolvedRoot.primaryWorkspaceRoot } : {}),
        ...(resolvedRoot ? { projectSlug: resolvedRoot.projectSlug } : {}),
        ...(resolvedRoot?.ref.kind === "worktree" ? { worktreeId: resolvedRoot.ref.worktreeId } : {}),
        ...(resumeState === undefined ? {} : { resumeState }),
        signal: controller.signal,
      };
      let text = "";
      let terminal: Extract<CanonicalProviderRunEvent, { type: "run.completed" }> | undefined;
      const events = resumeState !== undefined && adapter.resume
        ? adapter.resume({ ...input, resumeState })
        : adapter.start(input);
      for await (const rawEvent of events) {
        if (controller.signal.aborted) {
          throw new Error("Provider emitted an event after cancellation");
        }
        const event = CanonicalProviderRunEventSchema.parse(rawEvent);
        if (terminal) throw new Error("Provider emitted an event after completion");
        if (event.type === "state.updated") {
          const state = adapter.serializeState(adapter.parseState(event.state));
          await this.options.repository.updateAdapterState(owner, {
            chatId: run.chatId,
            runId: run.id,
            driverKind: run.driverKind,
            instanceId: run.instanceId,
            schemaVersion: adapter.stateSchemaVersion,
            state,
          });
        } else if (event.type === "assistant.delta") {
          if (Buffer.byteLength(text + event.delta, "utf8") > MAX_ASSISTANT_TEXT) {
            throw new Error("Provider assistant output exceeded the canonical limit");
          }
          text += event.delta;
          const messageId = assistantMessageId(run.id, event.messageId);
          await this.options.repository.appendAssistantDelta(owner, {
            chatId: run.chatId,
            runId: run.id,
            messageId,
            delta: event.delta,
            createdAt: (this.options.now ?? (() => new Date()))().toISOString(),
          });
        } else if (event.type === "run.completed") {
          terminal = event;
        } else {
          await this.persistActivities(owner, run, [event]);
        }
      }
      if (!terminal) throw new Error("Provider completed without a terminal event");
      const completedAt = (this.options.now ?? (() => new Date()))().toISOString();
      const terminalActivities: Array<Record<string, unknown>> = [
        ...(terminal.error ? [{ type: "run.error", error: terminal.error }] : []),
        { type: "run.status", status: terminal.outcome },
      ];
      try {
        await this.persistActivities(owner, run, terminalActivities, completedAt);
      } catch (activityError: unknown) {
        if (!(activityError instanceof ChatConflictError)) throw activityError;
        console.warn(
          "[chat/orchestrator] Terminal Run activity exceeded the persisted limit; committing the terminal outcome:",
          activityError.name,
        );
      }
      await this.options.repository.finishRun(owner, {
        chatId: run.chatId,
        runId: run.id,
        outcome: terminal.outcome,
        completedAt,
      });
      try {
        this.options.onAiGeneration?.({
          traceId: run.id,
          distinctId: owner.ownerId,
          provider: terminal.provider ?? analyticsProvider(run.selection.model, run.driverKind),
          harness: run.driverKind,
          model: run.selection.model,
          latencyMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
          tokensIn: terminal.tokenUsage?.inputTokens,
          tokensOut: terminal.tokenUsage?.outputTokens,
          cachedInputTokens: terminal.tokenUsage?.cachedInputTokens,
          reasoningOutputTokens: terminal.tokenUsage?.reasoningOutputTokens,
          responseCharacterCount: text.length,
          productEvent: "gateway_chat_response_completed",
          ...(terminal.outcome === "failed" ? { error: new Error("CanonicalProviderRunError") } : {}),
        });
      } catch (analyticsError: unknown) {
        console.warn(
          "[chat/orchestrator] AI generation capture failed:",
          analyticsError instanceof Error ? analyticsError.name : "UnknownError",
        );
      }
    } catch (error: unknown) {
      if (error instanceof ChatRunNotActiveError) return;
      const wasAborted = controller.signal.aborted;
      if (!wasAborted) controller.abort();
      if (!wasAborted) {
        console.warn(
          "[chat/orchestrator] Provider Run failed:",
          error instanceof Error ? error.name : "UnknownError",
        );
      }
      const outcome = wasAborted ? "aborted" as const : "failed" as const;
      const completedAt = (this.options.now ?? (() => new Date()))().toISOString();
      const canonicalError = safeError(
        outcome === "aborted" ? "run_unavailable" : "run_failed",
        outcome === "aborted" ? "The Run was cancelled." : "The Run failed.",
        outcome !== "aborted",
        outcome === "aborted" ? undefined : ["retry"],
      );
      try {
        try {
          await this.persistActivities(owner, run, [{ type: "run.error", error: canonicalError }], completedAt);
        } catch (activityError: unknown) {
          console.warn(
            "[chat/orchestrator] Terminal Run activity could not be persisted:",
            activityError instanceof Error ? activityError.name : "UnknownError",
          );
        }
        await this.options.repository.finishRun(owner, {
          chatId: run.chatId,
          runId: run.id,
          outcome,
          completedAt,
        });
      } catch (finishError: unknown) {
        if (!(finishError instanceof ChatRunNotActiveError)) throw finishError;
      }
    }
  }

  private async persistActivities(
    owner: ChatOwner,
    run: CanonicalChatRun,
    events: Array<Record<string, unknown>>,
    occurredAt = (this.options.now ?? (() => new Date()))().toISOString(),
  ): Promise<void> {
    const activities = events.map((event) => CanonicalChatRunActivitySchema.parse({
      ...event,
      id: activityPersistenceId(run.id, event),
      chatId: run.chatId,
      runId: run.id,
      occurredAt,
    })) as CanonicalChatRunActivity[];
    await this.options.repository.appendRunActivities(owner, run.chatId, run.id, activities);
  }

  async cancelRun(
    owner: ChatOwner,
    chatId: string,
    runId: string,
  ): Promise<CanonicalChatRunCancellationResponse> {
    const active = this.active.get(runId);
    let providerCancellation: Promise<void> | undefined;
    if (active && active.chatId === chatId && active.owner.type === owner.type
      && active.owner.ownerId === owner.ownerId) {
      active.controller.abort();
      providerCancellation = (async () => {
        const state = await this.options.repository.getAdapterState(owner, {
          runId,
          driverKind: active.adapter.driverKind,
          instanceId: active.instanceId,
        });
        await active.adapter.cancel?.({
          owner,
          chatId,
          runId,
          ...(state ? { state: active.adapter.parseState(state.state) } : {}),
        });
      })().catch((error: unknown) => {
        console.warn("[chat/orchestrator] Provider cancel callback failed:", error instanceof Error ? error.name : "UnknownError");
      });
    }
    try {
      const finished = await this.options.repository.finishRun(owner, {
        chatId,
        runId,
        outcome: "aborted",
        completedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      });
      if (providerCancellation) {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            providerCancellation,
            new Promise<void>((resolve) => {
              timeout = setTimeout(resolve, this.shutdownDrainMs);
              timeout.unref?.();
            }),
          ]);
        } finally {
          if (timeout) clearTimeout(timeout);
        }
      }
      return {
        run: finished.run,
        cancellation: finished.transitioned ? "aborted" : "already_terminal",
      };
    } catch (error: unknown) {
      return mapRepositoryError(error);
    }
  }

  async steerRun(
    owner: ChatOwner,
    chatId: string,
    runId: string,
    inputValue: CanonicalSteerChatRunRequest,
  ): Promise<CanonicalChatRunSteeringResponse> {
    this.assertOpen();
    const input = CanonicalSteerChatRunRequestSchema.parse(inputValue);
    const active = this.active.get(runId);
    if (!active || active.chatId !== chatId || active.owner.type !== owner.type
      || active.owner.ownerId !== owner.ownerId || !active.adapter.steer) {
      throw new CanonicalChatOrchestrationError(
        safeError("capability_mismatch", "This Run cannot be steered."),
        409,
      );
    }
    const timestamp = (this.options.now ?? (() => new Date()))().toISOString();
    let begun;
    try {
      begun = await this.options.repository.beginSteer(owner, {
        chatId,
        runId,
        expectedTurnId: input.expectedTurnId,
        steerId: id("steer_"),
        messageId: id("msg_"),
        clientRequestId: input.clientRequestId,
        parts: input.parts,
        createdAt: timestamp,
      });
    } catch (error: unknown) {
      return mapRepositoryError(error);
    }
    if (begun.status === "accepted") {
      return CanonicalChatRunSteeringResponseSchema.parse({
        runId,
        turnId: input.expectedTurnId,
        message: begun.message,
        steering: "already_accepted",
      });
    }
    if (begun.alreadyRequested || begun.status === "failed") {
      throw new CanonicalChatOrchestrationError(
        safeError("run_unavailable", "The steering request is still resolving. Try again.", true, ["retry"]),
        409,
      );
    }
    const state = await this.options.repository.getAdapterState(owner, {
      runId,
      driverKind: active.adapter.driverKind,
      instanceId: active.instanceId,
    });
    try {
      await active.adapter.steer({
        owner,
        chatId,
        runId,
        turnId: input.expectedTurnId,
        clientRequestId: input.clientRequestId,
        prompt: promptFor(input.parts),
        parts: input.parts,
        ...(state ? { state: active.adapter.parseState(state.state) } : {}),
      });
    } catch (error: unknown) {
      console.warn(
        "[chat/orchestrator] Provider steering callback failed:",
        error instanceof Error ? error.name : "UnknownError",
      );
      try {
        await this.options.repository.failSteer(owner, {
          chatId,
          runId,
          clientRequestId: input.clientRequestId,
          acceptedAt: (this.options.now ?? (() => new Date()))().toISOString(),
        });
      } catch (finishError: unknown) {
        console.warn(
          "[chat/orchestrator] Steering failure could not be persisted:",
          finishError instanceof Error ? finishError.name : "UnknownError",
        );
      }
      throw new CanonicalChatOrchestrationError(
        safeError("run_unavailable", "The Run could not be steered. Try again.", true, ["retry"]),
        503,
      );
    }
    let message;
    try {
      message = await finalizeAcceptedSteer(() => this.options.repository.acceptSteer(owner, {
        chatId,
        runId,
        clientRequestId: input.clientRequestId,
        acceptedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      }));
    } catch (error: unknown) {
      return mapSteerFinalizationError(error);
    }
    return CanonicalChatRunSteeringResponseSchema.parse({
      runId,
      turnId: input.expectedTurnId,
      message,
      steering: "accepted",
    });
  }

  async steerQueuedTurn(
    owner: ChatOwner,
    chatId: string,
    runId: string,
    queuedTurnId: string,
    inputValue: CanonicalSteerQueuedChatTurnRequest,
  ): Promise<CanonicalChatRunSteeringResponse> {
    this.assertOpen();
    const input = CanonicalSteerQueuedChatTurnRequestSchema.parse(inputValue);
    const active = this.active.get(runId);
    if (!active || active.chatId !== chatId || active.owner.type !== owner.type
      || active.owner.ownerId !== owner.ownerId || !active.adapter.steer) {
      throw new CanonicalChatOrchestrationError(
        safeError("capability_mismatch", "This Run cannot be steered."),
        409,
      );
    }
    const timestamp = (this.options.now ?? (() => new Date()))().toISOString();
    let begun;
    try {
      begun = await this.options.repository.beginQueuedTurnSteer(owner, {
        chatId,
        runId,
        expectedTurnId: input.expectedTurnId,
        queuedTurnId,
        steerId: id("steer_"),
        messageId: id("msg_"),
        clientRequestId: input.clientRequestId,
        baseRevision: input.baseRevision,
        createdAt: timestamp,
      });
    } catch (error: unknown) {
      return mapRepositoryError(error);
    }
    if (begun.status === "accepted") {
      return CanonicalChatRunSteeringResponseSchema.parse({
        runId,
        turnId: input.expectedTurnId,
        message: begun.message,
        steering: "already_accepted",
      });
    }
    if (begun.alreadyRequested || begun.status === "failed") {
      throw new CanonicalChatOrchestrationError(
        safeError("run_unavailable", "The steering request is still resolving. Try again.", true, ["retry"]),
        409,
      );
    }
    const state = await this.options.repository.getAdapterState(owner, {
      runId,
      driverKind: active.adapter.driverKind,
      instanceId: active.instanceId,
    });
    try {
      await active.adapter.steer({
        owner,
        chatId,
        runId,
        turnId: input.expectedTurnId,
        clientRequestId: input.clientRequestId,
        prompt: promptFor(begun.parts),
        parts: begun.parts,
        ...(state ? { state: active.adapter.parseState(state.state) } : {}),
      });
    } catch (error: unknown) {
      console.warn(
        "[chat/orchestrator] Provider queued steering callback failed:",
        error instanceof Error ? error.name : "UnknownError",
      );
      try {
        await this.options.repository.failQueuedTurnSteer(owner, {
          chatId,
          runId,
          queuedTurnId,
          clientRequestId: input.clientRequestId,
          acceptedAt: (this.options.now ?? (() => new Date()))().toISOString(),
        });
      } catch (finishError: unknown) {
        console.warn(
          "[chat/orchestrator] Queued steering failure could not be persisted:",
          finishError instanceof Error ? finishError.name : "UnknownError",
        );
      }
      throw new CanonicalChatOrchestrationError(
        safeError("run_unavailable", "The Run could not be steered. Try again.", true, ["retry"]),
        503,
      );
    }
    let message;
    try {
      message = await finalizeAcceptedSteer(() => this.options.repository.acceptQueuedTurnSteer(owner, {
        chatId,
        runId,
        queuedTurnId,
        clientRequestId: input.clientRequestId,
        acceptedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      }));
    } catch (error: unknown) {
      return mapSteerFinalizationError(error);
    }
    return CanonicalChatRunSteeringResponseSchema.parse({
      runId,
      turnId: input.expectedTurnId,
      message,
      steering: "accepted",
    });
  }

  async submitApproval(
    owner: ChatOwner,
    chatId: string,
    runId: string,
    approvalId: string,
    inputValue: CanonicalSubmitChatApprovalRequest,
  ): Promise<CanonicalChatApprovalSubmissionResponse> {
    const input = CanonicalSubmitChatApprovalRequestSchema.parse(inputValue);
    const active = this.active.get(runId);
    if (!active || active.chatId !== chatId || active.owner.type !== owner.type
      || active.owner.ownerId !== owner.ownerId || !active.adapter.submitApproval) {
      throw new CanonicalChatOrchestrationError(
        safeError("capability_mismatch", "This approval is no longer available."),
        409,
      );
    }
    const pending = await this.options.repository.getPendingApproval(owner, { chatId, runId, approvalId });
    if (!pending || !pending.allowedDecisions.includes(input.decision)) {
      throw new CanonicalChatOrchestrationError(
        safeError("capability_mismatch", "This approval decision is no longer available."),
        409,
      );
    }
    const state = await this.options.repository.getAdapterState(owner, {
      runId,
      driverKind: active.adapter.driverKind,
      instanceId: active.instanceId,
    });
    try {
      await active.adapter.submitApproval({
        owner,
        chatId,
        runId,
        approvalId,
        decision: input.decision,
        clientRequestId: input.clientRequestId,
        ...(state ? { state: active.adapter.parseState(state.state) } : {}),
      });
    } catch (error: unknown) {
      console.warn(
        "[chat/orchestrator] Provider approval callback failed:",
        error instanceof Error ? error.name : "UnknownError",
      );
      throw new CanonicalChatOrchestrationError(
        safeError("run_unavailable", "The approval could not be submitted. Try again.", true, ["retry"]),
        503,
      );
    }
    return { approvalId, decision: input.decision, submission: "accepted" };
  }

  async reconcileActiveRuns(owner: ChatOwner): Promise<number> {
    const key = `${owner.type}:${owner.ownerId}`;
    const existing = this.reconciliation.get(key);
    if (existing) return existing;
    if (this.reconciliation.size >= 64) {
      const oldest = this.reconciliation.keys().next().value;
      if (oldest) this.reconciliation.delete(oldest);
    }
    const reconciliation = this.reconcileOwnerActiveRuns(owner).catch((error: unknown) => {
      this.reconciliation.delete(key);
      throw error;
    });
    this.reconciliation.set(key, reconciliation);
    return reconciliation;
  }

  private async reconcileOwnerActiveRuns(owner: ChatOwner): Promise<number> {
    const contexts = await this.options.repository.listActiveRunContexts(owner, MAX_ACTIVE_RUNS_GLOBAL);
    let reconciled = 0;
    for (const context of contexts) {
      if (this.active.has(context.latestRun.id) || this.pendingDispatch.has(context.latestRun.id)) continue;
      const completedAt = (this.options.now ?? (() => new Date()))().toISOString();
      const error = safeError(
        "run_unavailable",
        "The Run was interrupted when Matrix restarted.",
        true,
        ["retry"],
      );
      try {
        try {
          await this.persistActivities(owner, context.latestRun, [{ type: "run.error", error }], completedAt);
        } catch (activityError: unknown) {
          console.warn(
            "[chat/orchestrator] Reconciliation activity could not be persisted:",
            activityError instanceof Error ? activityError.name : "UnknownError",
          );
        }
        const finished = await this.options.repository.finishRun(owner, {
          chatId: context.latestRun.chatId,
          runId: context.latestRun.id,
          outcome: "failed",
          completedAt,
        });
        if (finished.transitioned) reconciled += 1;
      } catch (reconcileError: unknown) {
        if (!(reconcileError instanceof ChatRunNotActiveError)) throw reconcileError;
      }
    }
    const queuedChatIds = await this.options.repository.listQueuedChatIds(owner, 20);
    for (const chatId of queuedChatIds) {
      await this.dispatchNextQueued(owner, chatId);
    }
    return reconciled;
  }

  async drain(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.allSettled([...this.active.values()].map((entry) => entry.completion));
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    const active = [...this.active.values()];
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled(active.map((entry) => this.cancelRun(entry.owner, entry.chatId, entry.runId)))
          .then(() => this.drain()),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, this.shutdownDrainMs);
          timeout.unref?.();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      this.active.clear();
    }
  }
}
