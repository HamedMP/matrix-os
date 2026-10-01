import { importedChatAssetContentPath, type CanonicalChatMessage } from "@matrix-os/contracts";
import { filePreviewContentUrl } from "@matrix-os/ui";
import type {
  ConversationAttachmentPresentation, ConversationMessagePresentation, ConversationMessageContentPresentation,
  ConversationNoticePresentation, ConversationRequestPresentation, ConversationWorkPresentation,
} from "../../components/conversation/presentation";
const MAX_MESSAGE_PART_PROJECTIONS = 64;
export interface HistoricalToolContext {
  request?: Extract<CanonicalChatMessage["parts"][number], { type: "tool_request" }>;
  outcome?: Extract<CanonicalChatMessage["parts"][number], { type: "tool_result" }>["outcome"];
}
function setBounded<K, V>(map: Map<K, V>, key: K, value: V, limit: number): boolean {
  if (!map.has(key) && map.size >= limit) return false;
  map.set(key, value); return true;
}
export function messageText(message: CanonicalChatMessage): string {
  let output = "";
  let previousWasText = false;
  for (const part of message.parts) {
    if (part.type !== "text" && part.type !== "summary") continue;
    if (output && !(previousWasText && part.type === "text")) output += "\n\n";
    output += part.text;
    previousWasText = part.type === "text";
  }
  return output;
}

export function hasDisplayableMessageContent(message: CanonicalChatMessage): boolean {
  return messageText(message).length > 0
    || message.parts.some((part) => part.type === "attachment_reference" || part.type === "import_reference");
}

export function messagePresentation(
  message: CanonicalChatMessage,
  phase: "commentary" | "final",
): ConversationMessagePresentation {
  const markdown = messageText(message);
  const references: ConversationAttachmentPresentation[] = [];
  for (const [partIndex, part] of message.parts.entries()) {
    if (part.type === "import_reference") {
      references.push({ id: `${message.id}:import:${partIndex}`, kind: "file", label: part.label });
    } else if (part.type === "attachment_reference") {
      references.push({ id: part.attachmentId, kind: "file", label: part.label });
    } else if (part.type === "resource_reference") {
      references.push({ id: part.resource.id, kind: "resource", label: part.resource.label });
    } else if (part.type === "invocation_reference") {
      references.push({ id: part.invocation.descriptorId, kind: "invocation", label: part.invocation.invocation });
    }
  }
  const content = messageContent(message, markdown);
  return {
    kind: "message",
    id: message.id,
    role: message.role === "user" ? "user" : "assistant",
    phase,
    markdown,
    copyText: markdown,
    timestamp: Date.parse(message.createdAt),
    ...(content.length > 0 ? { content } : {}),
    ...(references.length > 0 ? { references } : {}),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function messageContent(
  message: CanonicalChatMessage,
  markdown: string,
): ConversationMessageContentPresentation[] {
  const matches: Array<{
    start: number;
    end: number;
    segment: ConversationMessageContentPresentation;
  }> = [];
  const unmatched: ConversationMessageContentPresentation[] = [];
  const images: ConversationMessageContentPresentation[] = [];
  for (const [partIndex, part] of message.parts.entries()) {
    if (part.type === "import_reference") {
      const occurrenceId = `${message.id}:import:${partIndex}`;
      const importAsset = { chatId: message.chatId, assetId: part.assetId, label: part.label };
      if (part.kind === "image") images.push({ kind: "image", id: occurrenceId, label: part.label, src: importedChatAssetContentPath(importAsset), importAsset });
      else unmatched.push({ kind: "reference", id: occurrenceId, referenceKind: "file", label: part.label, importAsset });
    } else if (part.type === "invocation_reference") {
      const token = part.invocation.invocation;
      const start = markdown.indexOf(token);
      const segment = {
        kind: "reference" as const,
        id: part.invocation.descriptorId,
        referenceKind: "invocation" as const,
        label: token,
      };
      if (start >= 0) matches.push({ start, end: start + token.length, segment });
      else unmatched.push(segment);
    } else if (part.type === "resource_reference") {
      const pattern = new RegExp(`\\[${escapeRegExp(part.resource.label)}\\]\\([^)]*\\)`);
      const found = pattern.exec(markdown);
      const segment = {
        kind: "reference" as const,
        id: part.resource.id,
        referenceKind: "resource" as const,
        label: part.resource.label,
      };
      if (found?.index !== undefined) {
        matches.push({ start: found.index, end: found.index + found[0].length, segment });
      } else unmatched.push(segment);
    } else if (part.type === "attachment_reference") {
      if (part.kind === "image" && part.ownerReference) {
        const resource = part.resource ?? { kind: "home" as const, path: part.ownerReference };
        images.push({
          kind: "image",
          id: part.attachmentId,
          label: part.label,
          src: filePreviewContentUrl(resource),
          path: part.ownerReference,
        });
      } else {
        unmatched.push({
          kind: "reference",
          id: part.attachmentId,
          referenceKind: "file",
          label: part.label,
          ...(part.ownerReference ? { path: part.ownerReference } : {}),
        });
      }
    }
  }
  matches.sort((left, right) => left.start - right.start || left.end - right.end);
  const content: ConversationMessageContentPresentation[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start < cursor) continue;
    if (match.start > cursor) content.push({ kind: "text", text: markdown.slice(cursor, match.start) });
    content.push(match.segment);
    cursor = match.end;
  }
  if (cursor < markdown.length) content.push({ kind: "text", text: markdown.slice(cursor) });
  return [...content, ...unmatched, ...images];
}

export function promotedAssistantArtifacts(
  messages: CanonicalChatMessage[],
  finalMessage: CanonicalChatMessage,
): ConversationMessageContentPresentation[] {
  return messages
    .filter((message) => message.id !== finalMessage.id)
    .flatMap((message) => messageContent(message, messageText(message)))
    .filter((segment) => segment.kind === "image"
      || (segment.kind === "reference" && segment.referenceKind === "file"));
}

export function withoutAttachmentReferences(message: CanonicalChatMessage): CanonicalChatMessage {
  return {
    ...message,
    parts: message.parts.filter((part) => part.type !== "attachment_reference"),
  };
}

export function messageWork(message: CanonicalChatMessage, context?: ReadonlyMap<string, HistoricalToolContext>): ConversationWorkPresentation[] {
  const toolRequests = new Map<string, Extract<CanonicalChatMessage["parts"][number], { type: "tool_request" }>>();
  const toolResults = new Map<string, Extract<CanonicalChatMessage["parts"][number], { type: "tool_result" }>[]>();
  const historical = message.parts.some(part => part.type === "import_provenance");
  const toolOrder: string[] = [];
  const approvals = new Map<string, Extract<CanonicalChatMessage["parts"][number], { type: "approval_request" }>>();
  const approvalResults = new Map<string, Extract<CanonicalChatMessage["parts"][number], { type: "approval_result" }>>();
  const approvalOrder: string[] = [];
  const notices: ConversationNoticePresentation[] = [];
  const timestamp = Date.parse(message.createdAt);

  for (const part of message.parts) {
    if (part.type === "tool_request") {
      const isNew = !toolRequests.has(part.toolCallId);
      if (setBounded(toolRequests, part.toolCallId, part, MAX_MESSAGE_PART_PROJECTIONS) && isNew) {
        toolOrder.push(part.toolCallId);
      }
    } else if (part.type === "tool_result") {
      const isNew = !toolRequests.has(part.toolCallId) && !toolResults.has(part.toolCallId);
      if (setBounded(toolResults, part.toolCallId, [...(toolResults.get(part.toolCallId) ?? []), part], MAX_MESSAGE_PART_PROJECTIONS) && isNew) {
        toolOrder.push(part.toolCallId);
      }
    } else if (part.type === "approval_request") {
      const isNew = !approvals.has(part.approvalId);
      if (setBounded(approvals, part.approvalId, part, MAX_MESSAGE_PART_PROJECTIONS) && isNew) {
        approvalOrder.push(part.approvalId);
      }
    } else if (part.type === "approval_result") {
      setBounded(approvalResults, part.approvalId, part, MAX_MESSAGE_PART_PROJECTIONS);
    } else if (part.type === "status") {
      notices.push({
        kind: "notice",
        id: `${message.id}:status:${notices.length}`,
        phase: "commentary",
        tone: part.tone === "error" ? "failed" : part.tone,
        label: part.label,
        markdown: part.detail ?? "",
        timestamp,
      });
    }
  }

  const tools: ConversationWorkPresentation[] = toolOrder.length > 0
    ? [{
        kind: "activity-group",
        id: `${message.id}:tools`,
        activities: toolOrder.flatMap((toolCallId) => {
          const linked = historical ? context?.get(toolCallId) : undefined;
          const request = toolRequests.get(toolCallId) ?? linked?.request;
          const results = toolResults.get(toolCallId) ?? [];
          const entries = results.length ? results : [undefined];
          return entries.map((result, index) => {
            const outcome = result?.outcome ?? linked?.outcome;
            const state = outcome === "failed" ? "failed" as const
              : outcome === "cancelled" ? "stopped" as const
              : outcome ? "completed" as const : historical ? "partial" as const : "running" as const;
            const detail = [request?.inputPreview, result?.text].filter(Boolean).join("\n\n");
            return {
              id: `${message.id}:${toolCallId}${results.length > 1 ? `:result:${index}` : ""}`,
              kind: "tool" as const, state,
              label: `${request?.label ?? "Tool result"}${historical && !result && !linked?.outcome ? " (incomplete)" : ""}`,
              ...(detail ? { detail, preview: request?.inputPreview ?? result?.text, previewKind: "text" as const } : {}),
            };
          });
        }),
      }]
    : [];
  const requests: ConversationRequestPresentation[] = approvalOrder.map((approvalId) => {
    const request = approvals.get(approvalId)!;
    const resolved = approvalResults.get(approvalId);
    return {
      kind: "request",
      id: `${message.id}:approval:${approvalId}`,
      phase: "commentary",
      requestKind: "approval",
      requestId: approvalId,
      state: resolved ? "resolved" : "waiting",
      label: request.title,
      detail: request.description,
      risk: request.risk,
      timestamp,
      ...(resolved ? {} : {
        actions: request.allowedDecisions.map((decision) => ({
          kind: "approval" as const,
          requestId: approvalId,
          decision,
          label: decision === "approve_for_session"
            ? "Approve for session"
            : decision === "approve" ? "Approve" : decision === "decline" ? "Decline" : "Cancel",
        })),
      }),
    };
  });
  return [...tools, ...requests, ...notices];
}

