import { z } from "zod/v4";
import {
  CanonicalChatIdSchema,
  CanonicalChatMessageSchema,
  CanonicalChatRunActivitySchema,
  CanonicalOwnerScopeSchema,
  CanonicalProviderInstanceIdSchema,
  type CanonicalChatMessage,
  type CanonicalChatRunActivity,
  type CanonicalOwnerScope,
} from "#canonical-chat";
import {
  CanonicalProviderDriverKindSchema,
  type CanonicalProviderDriverKind,
} from "#canonical-chat-provider";
import { CanonicalChatSummarySchema } from "#canonical-chat-surface";
import type {
  AgentThreadEvent,
  AgentThreadSnapshot,
  KernelConversationHistoryResponse,
  KernelConversationSummary,
} from "./index.js";

const LEGACY_SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;

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

export function mapKernelConversationToCanonicalChatProjection(input: {
  chatId: string;
  ownerScope: CanonicalOwnerScope;
  instanceId: string;
  model: string;
  summary: KernelConversationSummary;
  history: KernelConversationHistoryResponse;
}): CanonicalChatCompatibilityProjection {
  const chatId = CanonicalChatIdSchema.parse(input.chatId);
  const ownerScope = CanonicalOwnerScopeSchema.parse(input.ownerScope);
  const instanceId = CanonicalProviderInstanceIdSchema.parse(input.instanceId);
  if (input.summary.id !== input.history.id) throw new TypeError("Legacy conversation identity mismatch");

  const messages = [...input.history.messages]
    .sort((left, right) => left.index - right.index)
    .map((message, index): CanonicalChatMessage => {
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
        id: legacyMessageId("hermes", index),
        chatId,
        seq: message.index + 1,
        role: message.role,
        state: "committed",
        parts,
        createdAt: isoFromEpoch(message.timestamp),
      };
    });
  const context = input.history.context ?? input.summary.context;

  return CanonicalChatCompatibilityProjectionSchema.parse({
    source: { kind: "hermes_conversation", id: input.summary.id },
    chat: {
      id: chatId,
      ownerScope,
      title: nonBlank(input.summary.preview.slice(0, 160), "Imported conversation"),
      lifecycle: "active",
      attention: "none",
      revision: 0,
      messageCount: input.summary.messageCount,
      ...(input.summary.preview.trim().length > 0
        ? { lastMessagePreview: input.summary.preview.slice(0, 280) }
        : {}),
      currentSelection: { instanceId, model: input.model },
      ...(context === undefined ? {} : {
        project: {
          projectId: context.projectId,
          name: context.projectName,
          kind: context.projectKind,
          ...(context.repositoryLabel === undefined ? {} : { repositoryLabel: context.repositoryLabel }),
          status: context.status,
        },
      }),
      createdAt: isoFromEpoch(input.summary.createdAt),
      updatedAt: isoFromEpoch(input.summary.updatedAt),
    },
    messages,
    activities: [],
  });
}

type CanonicalRunStatus = Extract<
  CanonicalChatRunActivity,
  { type: "run.status" }
>["status"];

function canonicalRunStatus(status: AgentThreadSnapshot["thread"]["status"]): CanonicalRunStatus {
  if (status === "queued" || status === "starting") return "accepted";
  if (status === "waiting_for_approval") return "waiting_for_approval";
  if (status === "waiting_for_input") return "waiting_for_input";
  if (status === "failed" || status === "stale") return "failed";
  if (status === "aborted") return "aborted";
  if (status === "completed" || status === "archived") return "completed";
  return "running";
}

function canonicalAttention(attention: AgentThreadSnapshot["thread"]["attention"]):
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
  | { kind: "user"; event: Extract<AgentThreadEvent, { type: "user.message" }> }
  | { kind: "assistant"; legacyId: string };

function activityFromEvent(input: {
  event: AgentThreadEvent;
  index: number;
  chatId: string;
  runId: string;
}): CanonicalChatRunActivity | null {
  const base = {
    id: `legacy_activity_${input.index + 1}`,
    chatId: input.chatId,
    runId: input.runId,
    occurredAt: input.event.occurredAt,
  };
  const event = input.event;
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
  if (event.type === "approval.requested") {
    return {
      ...base,
      type: "approval.requested",
      approvalId: event.approval.approvalId,
      title: event.approval.title,
      risk: event.approval.risk,
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
  if (event.type === "thread.completed") {
    return { ...base, type: "run.status", status: event.outcome };
  }
  return null;
}

export function mapAgentThreadToCanonicalChatProjection(input: {
  chatId: string;
  ownerScope: CanonicalOwnerScope;
  instanceId: string;
  model: string;
  driverKind: CanonicalProviderDriverKind;
  turnId: string;
  runId: string;
  snapshot: AgentThreadSnapshot;
}): CanonicalChatCompatibilityProjection {
  const chatId = CanonicalChatIdSchema.parse(input.chatId);
  const ownerScope = CanonicalOwnerScopeSchema.parse(input.ownerScope);
  const instanceId = CanonicalProviderInstanceIdSchema.parse(input.instanceId);
  const driverKind = CanonicalProviderDriverKindSchema.parse(input.driverKind);
  const ordered: OrderedLegacyMessage[] = [];
  const assistant = new Map<string, { chunks: string[]; completed: boolean; occurredAt: string }>();

  input.snapshot.events.items.forEach((event) => {
    if (event.type === "user.message") ordered.push({ kind: "user", event });
    if (event.type === "assistant.text.delta") {
      const existing = assistant.get(event.messageId);
      if (existing === undefined) {
        assistant.set(event.messageId, { chunks: [event.delta], completed: false, occurredAt: event.occurredAt });
        ordered.push({ kind: "assistant", legacyId: event.messageId });
      } else {
        existing.chunks.push(event.delta);
      }
    }
    if (event.type === "assistant.text.completed") {
      const existing = assistant.get(event.messageId);
      if (existing !== undefined) existing.completed = true;
    }
  });

  const messages = ordered.map((entry, index): CanonicalChatMessage => {
    if (entry.kind === "user") {
      return {
        id: legacyMessageId("thread", index),
        chatId,
        seq: index + 1,
        role: "user",
        state: "committed",
        turnId: input.turnId,
        parts: [{ type: "text", text: entry.event.text }],
        createdAt: entry.event.occurredAt,
      };
    }
    const value = assistant.get(entry.legacyId)!;
    return {
      id: legacyMessageId("thread", index),
      chatId,
      seq: index + 1,
      role: "assistant",
      state: value.completed ? "committed" : "pending",
      turnId: input.turnId,
      runId: input.runId,
      parts: [{ type: "text", text: value.chunks.join("") }],
      createdAt: value.occurredAt,
    };
  });
  const activities = input.snapshot.events.items
    .map((event, index) => activityFromEvent({ event, index, chatId, runId: input.runId }))
    .filter((activity): activity is CanonicalChatRunActivity => activity !== null);
  const status = canonicalRunStatus(input.snapshot.thread.status);

  return CanonicalChatCompatibilityProjectionSchema.parse({
    source: { kind: "coding_agent_thread", id: input.snapshot.thread.id },
    chat: {
      id: chatId,
      ownerScope,
      title: input.snapshot.thread.title,
      lifecycle: input.snapshot.thread.status === "archived" ? "archived" : "active",
      attention: canonicalAttention(input.snapshot.thread.attention),
      revision: 0,
      messageCount: messages.length,
      ...(messages.length === 0 ? {} : { lastMessagePreview: input.snapshot.thread.title }),
      currentSelection: { instanceId, model: input.model },
      providerBinding: { driverKind, instanceId, lockedAtTurnId: input.turnId },
      ...(isActiveStatus(status) ? { activeRun: { runId: input.runId, turnId: input.turnId, status } } : {}),
      createdAt: input.snapshot.thread.createdAt,
      updatedAt: input.snapshot.thread.updatedAt,
    },
    messages,
    activities,
  });
}
