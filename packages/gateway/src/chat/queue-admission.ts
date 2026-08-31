import { randomUUID } from "node:crypto";
import {
  CanonicalChatQueueAdmissionResponseSchema,
  CanonicalChatSafeErrorSchema,
  CanonicalQueueChatTurnRequestSchema,
  type CanonicalChatQueueAdmissionResponse,
  type CanonicalChatSafeError,
  type CanonicalQueueChatTurnRequest,
} from "@matrix-os/contracts";
import type { RequestPrincipal } from "../request-principal.js";
import type { ChatExecutionRootResolver } from "./execution-root.js";
import {
  validateChatProviderSelection,
  type ChatProviderCatalogService,
} from "./provider-catalog.js";
import type { CanonicalChatProviderRegistry } from "./provider-adapter.js";
import type { ChatOwner } from "./records.js";
import type { ChatRepository } from "./repository.js";

export class CanonicalQueueAdmissionError extends Error {
  constructor(readonly safeError: CanonicalChatSafeError, readonly status: 400 | 404 | 409 | 503) {
    super(safeError.safeMessage);
    this.name = "CanonicalQueueAdmissionError";
  }
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

function requirementsFor(input: CanonicalQueueChatTurnRequest) {
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

export async function enqueueCanonicalQueuedTurn(options: {
  principal: RequestPrincipal;
  owner: ChatOwner;
  chatId: string;
  input: CanonicalQueueChatTurnRequest;
  repository: Pick<ChatRepository, "get" | "enqueueQueuedTurn">;
  catalog: Pick<ChatProviderCatalogService, "getCatalog">;
  adapters: Pick<CanonicalChatProviderRegistry, "get">;
  executionRoots?: ChatExecutionRootResolver;
  now: () => Date;
}): Promise<CanonicalChatQueueAdmissionResponse> {
  const input = CanonicalQueueChatTurnRequestSchema.parse(options.input);
  const record = await options.repository.get(options.owner, options.chatId);
  if (!record) {
    throw new CanonicalQueueAdmissionError(
      safeError("chat_not_found", "Chat not found."),
      404,
    );
  }
  if (!record.activeRun) {
    throw new CanonicalQueueAdmissionError(
      safeError("chat_conflict", "Queue next is available only while a Run is active.", true, ["retry"]),
      409,
    );
  }
  const catalog = await options.catalog.getCatalog(options.principal);
  const validated = validateChatProviderSelection({
    catalog,
    selection: input.selection,
    ...(record.providerBinding ? { boundInstanceId: record.providerBinding.instanceId } : {}),
    requirements: requirementsFor(input),
  });
  if (!validated.ok) {
    throw new CanonicalQueueAdmissionError(
      validated.error,
      validated.error.code === "provider_instance_locked" ? 409 : 400,
    );
  }
  if (!options.adapters.get(validated.instance.driverKind)) {
    throw new CanonicalQueueAdmissionError(
      safeError("provider_unavailable", "The selected Provider cannot run yet.", false, ["select_provider"]),
      503,
    );
  }
  const rootRef = input.executionRoot
    ?? (record.projectId ? { kind: "project" as const, projectId: record.projectId } : undefined);
  if (input.executionRoot && record.projectId && input.executionRoot.projectId !== record.projectId) {
    throw new CanonicalQueueAdmissionError(
      safeError("project_unavailable", "The selected workspace does not belong to this Chat's Project."),
      400,
    );
  }
  if (validated.instance.workspaceRequirement === "project_required" && rootRef === undefined) {
    throw new CanonicalQueueAdmissionError(
      safeError("project_required", "This Provider requires a Project.", false, ["return_to_project"]),
      400,
    );
  }
  let resolvedRoot: Awaited<ReturnType<ChatExecutionRootResolver["resolve"]>> | undefined;
  if (rootRef !== undefined) {
    if (!options.executionRoots) {
      throw new CanonicalQueueAdmissionError(
        safeError("project_unavailable", "The Project workspace is unavailable.", true, ["retry"]),
        503,
      );
    }
    try {
      resolvedRoot = await options.executionRoots.resolve(options.owner, rootRef);
    } catch (error: unknown) {
      console.warn(
        "[chat/queue] Execution root resolution failed:",
        error instanceof Error ? error.name : "UnknownError",
      );
      throw new CanonicalQueueAdmissionError(
        safeError("project_unavailable", "The Project workspace is unavailable.", true, ["retry"]),
        503,
      );
    }
  }
  const enqueued = await options.repository.enqueueQueuedTurn(options.owner, {
    chatId: options.chatId,
    baseRevision: input.baseRevision,
    queuedTurnId: `qturn_${randomUUID().replaceAll("-", "")}`,
    clientRequestId: input.clientRequestId,
    parts: input.parts,
    driverKind: validated.instance.driverKind,
    selection: validated.selection,
    interactionMode: input.interactionMode,
    permissionMode: input.permissionMode,
    ...(resolvedRoot ? {
      executionRoot: resolvedRoot.ref,
      executionRootFingerprint: resolvedRoot.fingerprint,
    } : {}),
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
    createdAt: options.now().toISOString(),
  });
  return CanonicalChatQueueAdmissionResponseSchema.parse({
    queuedTurn: enqueued.queuedTurn,
    queueDepth: enqueued.queueDepth,
  });
}
