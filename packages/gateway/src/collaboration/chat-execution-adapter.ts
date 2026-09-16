import { createHash, randomUUID } from "node:crypto";
import {
  CollaborationAiRequestAcceptedResponseSchema,
  CollaborationAiRequestSchema,
  CollaborationApprovalSchema,
  CollaborationCreateAiRequestSchema,
  CollaborationRevisionSchema,
  type CollaborationAiRequestAcceptedResponse,
  type CollaborationAiRequest,
} from "@matrix-os/contracts";
import { z } from "zod/v4";
import {
  CollaborationChatCommands,
  type CollaborationChatCommandResult,
} from "../chat/collaboration-commands.js";
import {
  type ChatRepository,
  type SharedQueuedTurn,
} from "../chat/repository.js";
import {
  CollaborationAuthorizationError,
  type AuthorizedCollaborationContext,
} from "./authority.js";

const ScopeEligibilitySchema = z.object({
  profileId: z.string().min(1).max(64),
  profileVersion: z.number().int().min(1),
  profileDigest: z.string().regex(/^[a-f0-9]{64}$/),
  adapterId: z.literal("claude-code"),
  harnessVersion: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/),
}).strict();

export interface CollaborationAiExecutionEligibility {
  profileId: string;
  profileVersion: number;
  profileDigest: string;
  adapterId: "claude-code";
  harnessVersion: string;
}

export class CollaborationChatExecutionAdapter {
  private readonly now: () => Date;
  private readonly createQueuedTurnId: () => string;

  constructor(private readonly options: {
    repository: Pick<ChatRepository,
      "enqueueSharedQueuedTurn" | "listSharedQueuedTurns" | "listSharedPendingApprovals">;
    commands: Pick<CollaborationChatCommands, "cancel" | "retry" | "decideApproval">;
    resolveParticipant(actorId: string): Promise<{ actorId: string; displayName: string }>;
    resolveEligibility(scopeId: string): Promise<unknown>;
    resolveResourceRevision(scopeId: string, chatId: string): Promise<number | null>;
    requestDispatch(scopeId: string, chatId: string): Promise<void>;
    onCommitted?(scopeId: string): Promise<void>;
    now?: () => Date;
    createQueuedTurnId?: () => string;
  }) {
    this.now = options.now ?? (() => new Date());
    this.createQueuedTurnId = options.createQueuedTurnId
      ?? (() => `qturn_${randomUUID().replaceAll("-", "")}`);
  }

  async capability(
    context: AuthorizedCollaborationContext,
    requests: readonly CollaborationAiRequest[],
  ) {
    requireChatContext(context, "read");
    const pending = await this.options.repository.listSharedPendingApprovals(
      ownerFor(context), context.resourceId, context.scopeId,
    );
    const approvals = pending.flatMap((approval) => {
      const request = requests.find((candidate) => candidate.id === approval.requestId
        && candidate.runId === approval.runId);
      if (!request) return [];
      return [CollaborationApprovalSchema.parse({
        approvalId: approval.approvalId,
        runId: approval.runId,
        requestId: request.id,
        title: approval.title,
        risk: approval.risk,
        allowedDecisions: approval.allowedDecisions,
        state: "pending",
      })];
    }).slice(0, 100);
    return {
      defaultSelection: {
        instanceId: "claude_shared",
        model: "claude-opus-4-6",
      },
      approvals,
    };
  }

  async list(context: AuthorizedCollaborationContext): Promise<CollaborationAiRequest[]> {
    requireChatContext(context, "read");
    const rows = await this.options.repository.listSharedQueuedTurns(ownerFor(context), context.resourceId);
    return Promise.all(rows.map((row) => this.project(row)));
  }

  async resourceRevision(context: AuthorizedCollaborationContext): Promise<string> {
    requireChatContext(context, "read");
    const revision = await this.options.resolveResourceRevision(context.scopeId, context.resourceId);
    if (revision === null) throw new CollaborationAuthorizationError("not_found", "Shared Chat access is required");
    return CollaborationRevisionSchema.parse(String(revision));
  }

  async submit(
    context: AuthorizedCollaborationContext,
    inputValue: unknown,
  ): Promise<CollaborationAiRequestAcceptedResponse> {
    requireChatContext(context, "request_ai");
    const input = CollaborationCreateAiRequestSchema.parse(inputValue);
    const eligibility = ScopeEligibilitySchema.parse(await this.options.resolveEligibility(context.scopeId));
    const queued = await this.options.repository.enqueueSharedQueuedTurn(ownerFor(context), {
      chatId: context.resourceId,
      scopeId: context.scopeId,
      queuedTurnId: this.createQueuedTurnId(),
      clientRequestId: input.clientRequestId,
      requestingActorId: context.actorId,
      acceptedAuthEpoch: context.authEpoch,
      payloadHash: digest(input),
      expectedRevision: Number(input.expectedRevision),
      parts: [{ type: "text", text: input.text }],
      driverKind: "claude_code",
      selection: input.selection,
      interactionMode: "default",
      permissionMode: "supervised",
      capabilitySnapshot: {
        revision: `${eligibility.profileId}-${eligibility.profileVersion}`,
        rootChat: true,
        attachments: [],
        resources: [],
        tools: [],
        approvals: false,
        userInput: false,
        resume: false,
        cancellation: true,
        steering: "none",
        worktrees: "none",
        interactionModes: ["default"],
        permissionModes: ["supervised"],
      },
      acceptedAt: this.now().toISOString(),
    });
    await this.notify(context.scopeId);
    if (!queued.alreadyAccepted) this.kickDispatch(context.scopeId, context.resourceId);
    return CollaborationAiRequestAcceptedResponseSchema.parse({
      request: await this.project(queued),
      resourceRevision: String(queued.resourceRevision),
    });
  }

  async cancel(
    context: AuthorizedCollaborationContext,
    requestId: string,
    input: { clientRequestId: string; expectedRevision: string },
  ): Promise<CollaborationChatCommandResult> {
    requireChatContext(context, "control_execution");
    const result = await this.options.commands.cancel({
      scopeId: context.scopeId,
      actorId: context.actorId,
      requestId,
      clientRequestId: input.clientRequestId,
      expectedRevision: Number(input.expectedRevision),
      payloadHash: digest(input),
    });
    await this.notify(context.scopeId);
    return result;
  }

  async retry(
    context: AuthorizedCollaborationContext,
    requestId: string,
    input: { clientRequestId: string; expectedRevision: string },
  ): Promise<CollaborationChatCommandResult> {
    requireChatContext(context, "control_execution");
    const result = await this.options.commands.retry({
      scopeId: context.scopeId,
      actorId: context.actorId,
      requestId,
      newRequestId: this.createQueuedTurnId(),
      clientRequestId: input.clientRequestId,
      expectedRevision: Number(input.expectedRevision),
      payloadHash: digest(input),
    });
    await this.notify(context.scopeId);
    this.kickDispatch(context.scopeId, context.resourceId);
    return result;
  }

  async decideApproval(
    context: AuthorizedCollaborationContext,
    approvalId: string,
    input: {
      clientRequestId: string;
      expectedRevision: string;
      runId: string;
      decision: "approve" | "approve_for_session" | "decline" | "cancel";
    },
  ): Promise<CollaborationChatCommandResult> {
    requireChatContext(context, "control_execution");
    const result = await this.options.commands.decideApproval({
      scopeId: context.scopeId,
      actorId: context.actorId,
      approvalId,
      runId: input.runId,
      decision: input.decision,
      clientRequestId: input.clientRequestId,
      expectedRevision: Number(input.expectedRevision),
      payloadHash: digest(input),
    });
    await this.notify(context.scopeId);
    return result;
  }

  private async project(row: SharedQueuedTurn): Promise<CollaborationAiRequest> {
    const text = row.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
    return CollaborationAiRequestSchema.parse({
      id: row.id,
      chatId: row.chatId,
      acceptedSequence: String(row.acceptedSequence),
      actor: await this.options.resolveParticipant(row.requestingActorId),
      state: row.state,
      text,
      selection: row.selection,
      ...(row.retryOfRequestId ? { retryOfRequestId: row.retryOfRequestId } : {}),
      ...(row.runId ? { runId: row.runId } : {}),
      acceptedAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  private async notify(scopeId: string): Promise<void> {
    await this.options.onCommitted?.(scopeId);
  }

  private kickDispatch(scopeId: string, chatId: string): void {
    void this.options.requestDispatch(scopeId, chatId).catch((error: unknown) => {
      console.warn("[collaboration] shared Chat dispatch wake-up failed",
        error instanceof Error ? error.name : "UnknownError");
    });
  }
}

function requireChatContext(
  context: AuthorizedCollaborationContext,
  capability: "read" | "request_ai" | "control_execution",
): void {
  if (context.resourceKind !== "chat" || context.capability !== capability) {
    throw new CollaborationAuthorizationError("forbidden", "Shared Chat access is required");
  }
}

function ownerFor(context: AuthorizedCollaborationContext) {
  return { type: "personal" as const, ownerId: context.ownerId };
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function parseCollaborationAiEligibility(value: unknown): CollaborationAiExecutionEligibility {
  return ScopeEligibilitySchema.parse(value);
}
