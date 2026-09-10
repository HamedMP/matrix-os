import { type ChatAgentContext } from "./agent-context.js";
import { randomUUID } from "node:crypto";
import {
  CanonicalCreateChatTurnRequestSchema, CanonicalChatMessageSchema, CanonicalChatTurnSchema,
  CanonicalChatRunSchema, CanonicalChatTurnAdmissionResponseSchema,
  type CanonicalCreateChatTurnRequest, type CanonicalChatMessage, type CanonicalChatRun,
  type CanonicalChatTurnAdmissionResponse,
} from "@matrix-os/contracts";
import type { RequestPrincipal } from "../request-principal.js";
import type { ChatOwner } from "./records.js";
import type { ChatRepository } from "./repository.js";
import { ChatNotFoundError } from "./errors.js";
import { validateChatProviderSelection, type ChatProviderCatalogService } from "./provider-catalog.js";
import type { CanonicalChatProviderRegistry, CanonicalChatProviderAdapter } from "./provider-adapter.js";
import type { ChatExecutionRootResolver, ResolvedChatExecutionRoot } from "./execution-root.js";
import { CanonicalChatOrchestrationError, mapRepositoryError, safeError, requirementsFor } from "./orchestration-input.js";
import { loadChatResumeState } from "./resume-checkpoint.js";

export interface TurnAdmissionOptions {
  repository: Pick<ChatRepository, "get" | "getLatestAdapterStateForChat" | "admitTurn" | "finishRun">;
  catalog: Pick<ChatProviderCatalogService, "getCatalog">;
  adapters: CanonicalChatProviderRegistry;
  executionRoots?: ChatExecutionRootResolver;
  agentContext?: ChatAgentContext;
  now?: () => Date;
  assertOpen(): void;
  assertPersonalExecutionAllowed(owner: ChatOwner, chatId: string): Promise<void>;
  reconcileActiveRuns(owner: ChatOwner): Promise<unknown>;
  reservePendingDispatch(runId: string): void;
  releasePendingDispatch(runId: string): void;
  atCapacity(owner: ChatOwner): boolean;
  startDispatch(owner: ChatOwner, message: CanonicalChatMessage, run: CanonicalChatRun,
    adapter: CanonicalChatProviderAdapter, root?: ResolvedChatExecutionRoot, resumeState?: unknown): void;
}

const id = (prefix: string) => `${prefix}${randomUUID().replaceAll("-", "")}`;

export async function admitCanonicalTurn(
  deps: TurnAdmissionOptions, principal: RequestPrincipal, owner: ChatOwner,
  chatId: string, inputValue: CanonicalCreateChatTurnRequest,
): Promise<CanonicalChatTurnAdmissionResponse> {
    deps.assertOpen();
    await deps.assertPersonalExecutionAllowed(owner, chatId);
    await deps.reconcileActiveRuns(owner);
    const input = CanonicalCreateChatTurnRequestSchema.parse(inputValue);
    const record = await deps.repository.get(owner, chatId);
    if (!record) return mapRepositoryError(new ChatNotFoundError(chatId));
    let prepared;
    try { prepared = await deps.agentContext?.prepare(owner, chatId, input); }
    catch (error: unknown) { return mapRepositoryError(error); }
    const effective = { ...input, ...prepared };
    const catalog = await deps.catalog.getCatalog(principal);
    const validated = validateChatProviderSelection({
      catalog,
      selection: effective.selection,
      ...(!prepared?.context?.agent && record.providerBinding ? { boundInstanceId: record.providerBinding.instanceId } : {}),
      requirements: requirementsFor({ ...effective, parts: prepared ? input.parts.filter((part) =>
        part.type !== "resource_reference" || !["agent", "chat"].includes(part.resource.kind)) : input.parts }),
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
    const resumeState = prepared?.context?.history ? undefined : await loadChatResumeState({
      repository: deps.repository, owner, chatId, adapter,
      instanceId: validated.instance.id,
      executionRootFingerprint: resolvedRoot?.fingerprint ?? null,
      mode: "follow_up",
    });
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
    deps.reservePendingDispatch(run.id);
    try {
      deps.assertOpen();
      admitted = await deps.repository.admitTurn(owner, {
        chatId,
        baseRevision: input.baseRevision,
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
        if (deps.atCapacity(owner)) {
          await deps.repository.finishRun(owner, {
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
        deps.startDispatch(
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
      deps.releasePendingDispatch(run.id);
    }
}
