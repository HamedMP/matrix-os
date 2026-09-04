import { z } from "zod/v4";
import {
  CanonicalChatMessageSchema,
  CanonicalChatRunActivitySchema,
  type CanonicalChatMessage,
  type CanonicalChatRunActivity,
  type CanonicalOwnerScope,
} from "#canonical-chat";
import {
  type CanonicalProviderDriverKind,
} from "#canonical-chat-provider";
import { CanonicalChatSummarySchema } from "#canonical-chat-surface";
import { canonicalSafeErrorText } from "#canonical-chat-primitives";
import type { AgentThreadEvent, AgentThreadSnapshot } from "#agent-thread-contracts";
import type {
  KernelConversationHistoryResponse,
  KernelConversationSummary,
} from "#kernel-conversations";

const LEGACY_SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const CanonicalToolOutputTextSchema = canonicalSafeErrorText(4_000, 16 * 1024);

type LegacyThreadStatus = AgentThreadSnapshot["thread"]["status"];
type LegacyThreadAttention = AgentThreadSnapshot["thread"]["attention"];

export const CanonicalChatCompatibilityProjectionSchema = z.object({
  source: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("hermes_conversation"),
      id: z.string().min(1).max(256).regex(LEGACY_SOURCE_ID),
    }).strict(),
    z.object({
      kind: z.literal("coding_agent_thread"),
      id: z.string().min(1).max(256).regex(LEGACY_SOURCE_ID),
    }).strict(),
  ]),
  chat: CanonicalChatSummarySchema,
  messages: z.array(CanonicalChatMessageSchema).max(200),
  activities: z.array(CanonicalChatRunActivitySchema).max(500),
}).strict().superRefine((projection, ctx) => {
  projection.messages.forEach((message, index) => {
    if (message.chatId !== projection.chat.id) {
      ctx.addIssue({ code: "custom", path: ["messages", index, "chatId"], message: "Chat mismatch" });
    }
  });
  projection.activities.forEach((activity, index) => {
    if (activity.chatId !== projection.chat.id) {
      ctx.addIssue({ code: "custom", path: ["activities", index, "chatId"], message: "Chat mismatch" });
    }
  });
});

export type CanonicalChatCompatibilityProjection = z.infer<
  typeof CanonicalChatCompatibilityProjectionSchema
>;

function isoFromEpoch(value: number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("Legacy timestamp is outside the supported range");
  return date.toISOString();
}

function nonBlank(value: string, fallback: string): string {
  return value.trim().length > 0 ? value : fallback;
}

function legacyMessageId(source: "hermes" | "thread", index: number): string {
  return `msg_legacy_${source}_${index + 1}`;
}

export function mapKernelConversationFromLegacyContracts(input: {
  chatId: string;
  ownerScope: CanonicalOwnerScope;
  instanceId: string;
  model: string;
  turnId?: string;
  summary: KernelConversationSummary;
  history: KernelConversationHistoryResponse;
}): CanonicalChatCompatibilityProjection {
  const { chatId, ownerScope, instanceId, summary, history } = input;
  if (summary.id !== history.id) throw new TypeError("Legacy conversation identity mismatch");
  if (summary.messageCount > 0 && input.turnId === undefined) {
    throw new TypeError("Imported conversation binding requires its first accepted Turn");
  }

  const messages = [...history.messages]
    .sort((left, right) => left.index - right.index)
    .map((message): CanonicalChatMessage => {
      const parts: CanonicalChatMessage["parts"] = message.content.trim().length > 0
        ? [{ type: "text", text: message.content }]
        : [{ type: "status", tone: "info", label: "Legacy message has no text" }];
      if (message.tool !== undefined) {
        parts.push({
          type: "tool_request",
          toolCallId: `legacy_tool_${message.index}`,
          name: message.tool,
          label: message.toolDisplay?.preview ?? message.tool,
        });
      }
      if (message.contentTruncated) {
        parts.push({ type: "status", tone: "warning", label: "Legacy content is truncated" });
      }
      return {
        id: legacyMessageId("hermes", message.index),
        chatId,
        seq: message.index + 1,
        role: message.role,
        state: "committed",
        parts,
        createdAt: isoFromEpoch(message.timestamp),
      };
    });
  const context = history.context ?? summary.context;

  return CanonicalChatCompatibilityProjectionSchema.parse({
    source: { kind: "hermes_conversation", id: summary.id },
    chat: {
      id: chatId,
      ownerScope,
      title: nonBlank(summary.preview.slice(0, 200), "Imported conversation"),
      lifecycle: "active",
      attention: "none",
      revision: 0,
      messageCount: summary.messageCount,
      ...(summary.preview.trim().length > 0
        ? { lastMessagePreview: summary.preview.slice(0, 280) }
        : {}),
      currentSelection: { instanceId, model: input.model },
      ...(summary.messageCount === 0 ? {} : {
        providerBinding: { driverKind: "hermes", instanceId, lockedAtTurnId: input.turnId },
      }),
      ...(context === undefined ? {} : {
        project: {
          projectId: context.projectId,
          name: context.projectName,
          kind: context.projectKind,
          ...(context.repositoryLabel === undefined ? {} : { repositoryLabel: context.repositoryLabel }),
          status: context.status,
        },
      }),
      createdAt: isoFromEpoch(summary.createdAt),
      updatedAt: isoFromEpoch(summary.updatedAt),
    },
    messages,
    activities: [],
  });
}

type CanonicalRunStatus = Extract<
  CanonicalChatRunActivity,
  { type: "run.status" }
>["status"];

function canonicalRunStatus(status: LegacyThreadStatus): CanonicalRunStatus {
  if (status === "queued" || status === "starting") return "accepted";
  if (status === "waiting_for_approval") return "waiting_for_approval";
  if (status === "waiting_for_input") return "waiting_for_input";
  if (status === "failed" || status === "stale") return "failed";
  if (status === "aborted") return "aborted";
  if (status === "completed" || status === "archived") return "completed";
  return "running";
}

function canonicalAttention(attention: LegacyThreadAttention):
  "none" | "approval_required" | "input_required" | "failed" {
  return attention === "completed" ? "none" : attention;
}

function isActiveStatus(status: ReturnType<typeof canonicalRunStatus>): status is
  "accepted" | "running" | "waiting_for_approval" | "waiting_for_input" {
  return status === "accepted"
    || status === "running"
    || status === "waiting_for_approval"
    || status === "waiting_for_input";
}

type OrderedLegacyMessage =
  | { kind: "user"; event: Extract<AgentThreadEvent, { type: "user.message" }>; context: LegacyTurnContext }
  | { kind: "assistant"; legacyId: string; context: LegacyTurnContext };

interface LegacyTurnContext {
  turnId: string;
  runId: string;
}

function messageStateFromLegacyStatus(
  status: "accepted" | "running" | "completed" | "failed" | "aborted",
): CanonicalChatMessage["state"] {
  if (status === "completed") return "committed";
  if (status === "failed" || status === "aborted") return "failed";
  return "pending";
}

function messageStateFromThreadStatus(status: LegacyThreadStatus): CanonicalChatMessage["state"] {
  if (status === "completed" || status === "archived") return "committed";
  if (status === "failed" || status === "aborted" || status === "stale") return "failed";
  return "pending";
}

function activityFromEvent(input: {
  event: AgentThreadEvent;
  index: number;
  chatId: string;
  runId: string;
  turnId: string;
}): CanonicalChatRunActivity | null {
  const base = {
    id: `legacy_activity_${input.index + 1}`,
    chatId: input.chatId,
    runId: input.runId,
    occurredAt: input.event.occurredAt,
  };
  const event = input.event;
  if (event.type === "turn.accepted") {
    return { ...base, type: "turn.status", turnId: input.turnId, status: "accepted" };
  }
  if (event.type === "turn.status") {
    return { ...base, type: "turn.status", turnId: input.turnId, status: event.status };
  }
  if (event.type === "thread.status") {
    return { ...base, type: "run.status", status: canonicalRunStatus(event.status) };
  }
  if (event.type === "tool.started") {
    return { ...base, type: "tool.progress", toolCallId: event.toolCallId, label: event.displayName, status: "running" };
  }
  if (event.type === "tool.completed") {
    return {
      ...base,
      type: "tool.progress",
      toolCallId: event.toolCallId,
      label: "Tool completed",
      status: event.outcome === "success" ? "completed" : event.outcome,
    };
  }
  if (event.type === "tool.output") {
    const safeText = CanonicalToolOutputTextSchema.safeParse(event.text);
    return {
      ...base,
      type: "tool.output",
      toolCallId: event.toolCallId,
      text: safeText.success ? safeText.data : "Tool output is unavailable.",
      truncated: safeText.success ? (event.truncated ?? false) : true,
    };
  }
  if (event.type === "approval.requested") {
    return {
      ...base,
      type: "approval.requested",
      approvalId: event.approval.approvalId,
      title: event.approval.title,
      risk: event.approval.risk,
      allowedDecisions: event.approval.allowedDecisions,
    };
  }
  if (event.type === "approval.resolved") {
    return { ...base, type: "approval.resolved", approvalId: event.approvalId, decision: event.decision };
  }
  if (event.type === "user_input.requested") {
    return { ...base, type: "input.requested", requestId: event.request.requestId, title: event.request.title };
  }
  if (event.type === "user_input.answered") {
    return { ...base, type: "input.resolved", requestId: event.requestId };
  }
  if (event.type === "file.changed") {
    return {
      ...base,
      type: "resource.changed",
      resourceId: `legacy_file_${input.index + 1}`,
      resourceKind: "file",
      changeKind: event.changeKind,
    };
  }
  if (event.type === "review.ready") {
    return { ...base, type: "review.ready", reviewId: event.reviewId, summary: event.summary };
  }
  if (event.type === "terminal.bound") {
    if (!event.terminalSessionCreatedAt) return null;
    return {
      ...base,
      type: "terminal.bound",
      terminalSessionId: event.terminalSessionId,
      terminalSessionCreatedAt: event.terminalSessionCreatedAt,
    };
  }
  if (event.type === "thread.error") {
    const recoveryActions = event.error.recoveryActions?.flatMap((action) => {
      if (action === "retry" || action === "open_setup_terminal") return [action];
      if (action === "select_runtime") return ["select_provider" as const];
      if (action === "start_new_session") return ["start_new_chat" as const];
      return [];
    });
    return {
      ...base,
      type: "run.error",
      error: {
        code: "run_failed",
        safeMessage: event.error.safeMessage,
        retryable: event.error.retryable,
        ...(recoveryActions?.length ? { recoveryActions } : {}),
      },
    };
  }
  if (event.type === "thread.completed") {
    return { ...base, type: "run.status", status: event.outcome };
  }
  return null;
}

export function mapAgentThreadFromLegacyContracts(input: {
  chatId: string;
  ownerScope: CanonicalOwnerScope;
  instanceId: string;
  model: string;
  driverKind: CanonicalProviderDriverKind;
  turnId: string;
  runId: string;
  snapshot: AgentThreadSnapshot;
}): CanonicalChatCompatibilityProjection {
  const { chatId, ownerScope, instanceId, driverKind, snapshot } = input;
  if (snapshot.events.hasMore || snapshot.events.nextCursor !== undefined) {
    throw new TypeError("Complete legacy thread history is required");
  }
  const events = snapshot.events.items;
  const ordered: OrderedLegacyMessage[] = [];
  const assistant = new Map<string, {
    chunks: string[];
    occurredAt: string;
    context: LegacyTurnContext;
  }>();
  const legacyTurns = new Map<string, LegacyTurnContext>();
  const messageStateByRun = new Map<string, CanonicalChatMessage["state"]>();
  const fallbackContext = { turnId: input.turnId, runId: input.runId };
  let currentContext = fallbackContext;
  let firstLegacyContext: LegacyTurnContext | undefined;
  const eventContexts: LegacyTurnContext[] = [];

  const contextForLegacyTurn = (legacyTurnId: string): LegacyTurnContext => {
    const existing = legacyTurns.get(legacyTurnId);
    if (existing !== undefined) return existing;
    const ordinal = legacyTurns.size + 1;
    const context = { turnId: `cturn_legacy_${ordinal}`, runId: `run_legacy_${ordinal}` };
    legacyTurns.set(legacyTurnId, context);
    firstLegacyContext ??= context;
    return context;
  };

  events.forEach((event) => {
    if (event.type === "turn.accepted" || event.type === "turn.status") {
      currentContext = contextForLegacyTurn(event.turnId);
    } else if (event.type === "user.message" && event.turnId !== undefined) {
      currentContext = contextForLegacyTurn(event.turnId);
    }
    if (event.type === "turn.accepted") {
      messageStateByRun.set(currentContext.runId, "pending");
    } else if (event.type === "turn.status") {
      messageStateByRun.set(currentContext.runId, messageStateFromLegacyStatus(event.status));
    } else if (event.type === "thread.status") {
      messageStateByRun.set(currentContext.runId, messageStateFromThreadStatus(event.status));
    } else if (event.type === "thread.completed") {
      messageStateByRun.set(currentContext.runId, messageStateFromLegacyStatus(event.outcome));
    } else if (event.type === "thread.error") {
      messageStateByRun.set(currentContext.runId, "failed");
    }
    eventContexts.push(currentContext);
    if (event.type === "user.message") ordered.push({ kind: "user", event, context: currentContext });
    if (event.type === "assistant.text.delta") {
      const existing = assistant.get(event.messageId);
      if (existing === undefined) {
        assistant.set(event.messageId, {
          chunks: [event.delta],
          occurredAt: event.occurredAt,
          context: currentContext,
        });
        ordered.push({ kind: "assistant", legacyId: event.messageId, context: currentContext });
      } else {
        existing.chunks.push(event.delta);
      }
    }
  });
  const currentThreadMessageState = messageStateFromThreadStatus(snapshot.thread.status);
  if (currentThreadMessageState !== "pending") {
    messageStateByRun.set(currentContext.runId, currentThreadMessageState);
  }

  const messages = ordered.map((entry, index): CanonicalChatMessage => {
    if (entry.kind === "user") {
      const attachments: CanonicalChatMessage["parts"] = (entry.event.attachments ?? []).map((attachment) => ({
        type: "attachment_reference",
        attachmentId: attachment.id,
        kind: attachment.kind === "log_excerpt" ? "structured_ref" : attachment.kind,
        label: attachment.label,
        ...(attachment.mimeType === undefined ? {} : { mimeType: attachment.mimeType }),
        ...(attachment.sizeBytes === undefined ? {} : { sizeBytes: attachment.sizeBytes }),
      }));
      return {
        id: legacyMessageId("thread", index),
        chatId,
        seq: index + 1,
        role: "user",
        state: "committed",
        turnId: entry.context.turnId,
        parts: [{ type: "text", text: entry.event.text }, ...attachments],
        createdAt: entry.event.occurredAt,
      };
    }
    const value = assistant.get(entry.legacyId)!;
    return {
      id: legacyMessageId("thread", index),
      chatId,
      seq: index + 1,
      role: "assistant",
      state: messageStateByRun.get(entry.context.runId) ?? "pending",
      turnId: entry.context.turnId,
      runId: entry.context.runId,
      parts: [{ type: "text", text: value.chunks.join("") }],
      createdAt: value.occurredAt,
    };
  });
  const activities = events
    .map((event, index) => activityFromEvent({
      event,
      index,
      chatId,
      runId: eventContexts[index]!.runId,
      turnId: eventContexts[index]!.turnId,
    }))
    .filter((activity): activity is CanonicalChatRunActivity => activity !== null);
  const status = canonicalRunStatus(snapshot.thread.status);
  const bindingContext = firstLegacyContext
    ?? (events.some((event) => event.type === "user.message") ? fallbackContext : undefined);

  return CanonicalChatCompatibilityProjectionSchema.parse({
    source: { kind: "coding_agent_thread", id: snapshot.thread.id },
    chat: {
      id: chatId,
      ownerScope,
      title: snapshot.thread.title,
      lifecycle: snapshot.thread.status === "archived" ? "archived" : "active",
      attention: canonicalAttention(snapshot.thread.attention),
      revision: 0,
      messageCount: messages.length,
      ...(messages.length === 0 ? {} : { lastMessagePreview: snapshot.thread.title }),
      currentSelection: { instanceId, model: input.model },
      ...(bindingContext === undefined ? {} : {
        providerBinding: { driverKind, instanceId, lockedAtTurnId: bindingContext.turnId },
      }),
      ...(bindingContext !== undefined && isActiveStatus(status) ? {
        activeRun: { runId: currentContext.runId, turnId: currentContext.turnId, status },
      } : {}),
      createdAt: snapshot.thread.createdAt,
      updatedAt: snapshot.thread.updatedAt,
    },
    messages,
    activities,
  });
}
