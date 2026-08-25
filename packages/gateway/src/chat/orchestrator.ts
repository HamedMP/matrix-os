import { randomUUID } from "node:crypto";
import {
  CanonicalChatMessageSchema,
  CanonicalChatRunActivitySchema,
  CanonicalChatRunAdmissionResponseSchema,
  CanonicalChatRunSchema,
  CanonicalChatSafeErrorSchema,
  CanonicalChatTurnAdmissionResponseSchema,
  CanonicalChatTurnSchema,
  CanonicalCreateChatTurnRequestSchema,
  CanonicalRetryChatTurnRequestSchema,
  type CanonicalChatMessage,
  type CanonicalChatRun,
  type CanonicalChatRunActivity,
  type CanonicalChatRunAdmissionResponse,
  type CanonicalChatRunCancellationResponse,
  type CanonicalChatSafeError,
  type CanonicalChatTurnAdmissionResponse,
  type CanonicalCreateChatTurnRequest,
  type CanonicalRetryChatTurnRequest,
} from "@matrix-os/contracts";
import type { RequestPrincipal } from "../request-principal.js";
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
  ChatRunNotActiveError,
  type ChatRepository,
} from "./repository.js";
import type { ChatOwner } from "./records.js";

const MAX_ACTIVE_RUNS_GLOBAL = 64;
const MAX_ACTIVE_RUNS_PER_OWNER = 8;
const MAX_ASSISTANT_TEXT = 96 * 1024;

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

function id(prefix: "cturn_" | "run_" | "msg_" | "activity_"): string {
  return `${prefix}${randomUUID().replaceAll("-", "")}`;
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
    if (part.type === "attachment_reference") return [`@${part.label}`];
    return [];
  });
  const prompt = lines.join("\n").trim();
  if (!prompt) throw new CanonicalChatOrchestrationError(
    safeError("capability_mismatch", "The message does not contain supported input."),
    400,
  );
  return prompt;
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

function mapRepositoryError(error: unknown): never {
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
  if (error instanceof ChatConflictError) {
    throw new CanonicalChatOrchestrationError(safeError("chat_conflict", "Chat changed. Refresh and try again.", true, ["retry"]), 409);
  }
  throw error;
}

export class CanonicalChatOrchestrator {
  private readonly active = new Map<string, ActiveRun>();
  private readonly reconciliation = new Map<string, Promise<number>>();
  private readonly shutdownDrainMs: number;

  constructor(private readonly options: {
    repository: Pick<ChatRepository,
      | "get"
      | "admitTurn"
      | "markRunRunning"
      | "appendRunActivities"
      | "updateAdapterState"
      | "finishRun"
      | "getAdapterState"
      | "getLatestAdapterStateForChat"
      | "getTurnRunContext"
      | "admitRetry"
      | "listActiveRunContexts"
    >;
    catalog: Pick<ChatProviderCatalogService, "getCatalog">;
    adapters: CanonicalChatProviderRegistry;
    executionRoots?: ChatExecutionRootResolver;
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

  async admitTurn(
    principal: RequestPrincipal,
    owner: ChatOwner,
    chatId: string,
    inputValue: CanonicalCreateChatTurnRequest,
  ): Promise<CanonicalChatTurnAdmissionResponse> {
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
    const resumeState = previousState?.schemaVersion === adapter.stateSchemaVersion
      ? adapter.parseState(previousState.state)
      : undefined;
    const rootRef = input.executionRoot
      ?? (record.projectId ? { kind: "project" as const, projectId: record.projectId } : undefined);
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
        worktrees: validated.instance.supports.worktrees,
        interactionModes: validated.instance.supports.interactionModes,
        permissionModes: validated.instance.supports.permissionModes,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    let admitted;
    try {
      admitted = await this.options.repository.admitTurn(owner, {
        chatId,
        baseRevision: input.baseRevision,
        message,
        turn,
        run,
      });
    } catch (error: unknown) {
      return mapRepositoryError(error);
    }

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
      if (resumeState !== undefined) {
        await this.options.repository.updateAdapterState(owner, {
          chatId,
          runId: admitted.run.id,
          driverKind: admitted.run.driverKind,
          instanceId: admitted.run.instanceId,
          schemaVersion: adapter.stateSchemaVersion,
          state: adapter.serializeState(resumeState),
        });
      }
      this.startDispatch(
        owner,
        admitted.message,
        admitted.run,
        adapter,
        admitted.chat.chat.messageCount + 1,
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
  }

  async retryTurn(
    principal: RequestPrincipal,
    owner: ChatOwner,
    chatId: string,
    turnId: string,
    inputValue: CanonicalRetryChatTurnRequest,
  ): Promise<CanonicalChatRunAdmissionResponse> {
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
      ? adapter.parseState(previousState.state)
      : undefined;
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
        worktrees: validated.instance.supports.worktrees,
        interactionModes: validated.instance.supports.interactionModes,
        permissionModes: validated.instance.supports.permissionModes,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    let admitted;
    try {
      admitted = await this.options.repository.admitRetry(owner, {
        chatId,
        turnId,
        clientRequestId: input.clientRequestId,
        baseRevision: input.baseRevision,
        run,
      });
    } catch (error: unknown) {
      return mapRepositoryError(error);
    }
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
        admitted.chat.chat.messageCount + 1,
        resolvedRoot,
        resumeState,
      );
    }
    return CanonicalChatRunAdmissionResponseSchema.parse({
      record: admitted.chat,
      turn: admitted.turn,
      run: admitted.run,
      admission: admitted.alreadyAccepted ? "already_accepted" : "accepted",
    });
  }

  private startDispatch(
    owner: ChatOwner,
    message: CanonicalChatMessage,
    run: CanonicalChatRun,
    adapter: CanonicalChatProviderAdapter,
    outputSeq: number,
    resolvedRoot?: ResolvedChatExecutionRoot,
    resumeState?: unknown,
  ): void {
    const controller = new AbortController();
    const completion = this.dispatch(owner, message, run, adapter, outputSeq, controller, resolvedRoot, resumeState)
      .catch((error: unknown) => {
        console.error("[chat/orchestrator] Run dispatch failed:", error instanceof Error ? error.name : "UnknownError");
      })
      .finally(() => this.active.delete(run.id));
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

  private async dispatch(
    owner: ChatOwner,
    message: CanonicalChatMessage,
    run: CanonicalChatRun,
    adapter: CanonicalChatProviderAdapter,
    outputSeq: number,
    controller: AbortController,
    resolvedRoot?: ResolvedChatExecutionRoot,
    resumeState?: unknown,
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
        prompt: promptFor(message.parts),
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
          await this.persistActivities(owner, run, [{
            type: "assistant.delta",
            messageId: `msg_${run.id.slice("run_".length)}_assistant`,
            delta: event.delta,
          }]);
        } else if (event.type === "run.completed") {
          terminal = event;
        } else {
          await this.persistActivities(owner, run, [event]);
        }
      }
      if (!terminal) throw new Error("Provider completed without a terminal event");
      const completedAt = (this.options.now ?? (() => new Date()))().toISOString();
      if (terminal.error) {
        await this.persistActivities(owner, run, [{ type: "run.error", error: terminal.error }], completedAt);
      }
      await this.persistActivities(owner, run, [{ type: "run.status", status: terminal.outcome }], completedAt);
      const output = text ? CanonicalChatMessageSchema.parse({
        id: `msg_${run.id.slice("run_".length)}_assistant`,
        chatId: run.chatId,
        seq: outputSeq,
        role: "assistant",
        state: terminal.outcome === "completed" ? "committed" : "failed",
        turnId: run.turnId,
        runId: run.id,
        parts: [{ type: "text", text }],
        createdAt: completedAt,
      }) : undefined;
      await this.options.repository.finishRun(owner, {
        chatId: run.chatId,
        runId: run.id,
        outcome: terminal.outcome,
        completedAt,
        ...(output ? { output } : {}),
      });
    } catch (error: unknown) {
      if (error instanceof ChatRunNotActiveError) return;
      const outcome = controller.signal.aborted ? "aborted" as const : "failed" as const;
      const completedAt = (this.options.now ?? (() => new Date()))().toISOString();
      const canonicalError = safeError(
        outcome === "aborted" ? "run_unavailable" : "run_failed",
        outcome === "aborted" ? "The Run was cancelled." : "The Run failed.",
        outcome !== "aborted",
        outcome === "aborted" ? undefined : ["retry"],
      );
      try {
        await this.persistActivities(owner, run, [{ type: "run.error", error: canonicalError }], completedAt);
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
      id: id("activity_"),
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
    if (active && active.chatId === chatId && active.owner.type === owner.type
      && active.owner.ownerId === owner.ownerId) {
      active.controller.abort();
      try {
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
      } catch (error: unknown) {
        console.warn("[chat/orchestrator] Provider cancel callback failed:", error instanceof Error ? error.name : "UnknownError");
      }
    }
    try {
      const finished = await this.options.repository.finishRun(owner, {
        chatId,
        runId,
        outcome: "aborted",
        completedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      });
      return {
        run: finished.run,
        cancellation: finished.transitioned ? "aborted" : "already_terminal",
      };
    } catch (error: unknown) {
      return mapRepositoryError(error);
    }
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
      if (this.active.has(context.latestRun.id)) continue;
      const completedAt = (this.options.now ?? (() => new Date()))().toISOString();
      const error = safeError(
        "run_unavailable",
        "The Run was interrupted when Matrix restarted.",
        true,
        ["retry"],
      );
      try {
        await this.persistActivities(owner, context.latestRun, [{ type: "run.error", error }], completedAt);
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
    return reconciled;
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.active.values()].map((entry) => entry.completion));
  }

  async close(): Promise<void> {
    const active = [...this.active.values()];
    await Promise.allSettled(active.map((entry) => this.cancelRun(entry.owner, entry.chatId, entry.runId)));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.drain(),
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
