import { z } from "zod/v4";
import {
  AgentThreadEventSchema,
  ApprovalIdSchema,
  CorrelationIdSchema,
  RequestIdSchema,
  SafeDisplayStringSchema,
  UserInputQuestionSchema,
  type AgentThreadEvent,
} from "@matrix-os/contracts";

const MAX_CODEX_JSON_LINE_BYTES = 64 * 1024;
const MAX_ASSISTANT_DELTA_CHARS = 4_000;
const MAX_FILE_CHANGES = 200;

const CodexItemIdSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/)
  .refine((value) => !value.includes(".."));
const CodexProviderThreadIdSchema = z.string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,511}$/);
const CodexTextSchema = z.string().max(64 * 1024);
const CodexStatusSchema = z.enum(["in_progress", "completed", "failed", "declined"]);

const AgentMessageItemSchema = z.object({
  id: CodexItemIdSchema,
  type: z.literal("agent_message"),
  text: CodexTextSchema,
}).passthrough();
const CommandItemSchema = z.object({
  id: CodexItemIdSchema,
  type: z.literal("command_execution"),
  command: CodexTextSchema,
  aggregated_output: CodexTextSchema,
  exit_code: z.number().int().nullable(),
  status: CodexStatusSchema,
}).passthrough();
const FileChangeItemSchema = z.object({
  id: CodexItemIdSchema,
  type: z.literal("file_change"),
  changes: z.array(z.object({
    path: z.string().min(1).max(4096),
    kind: z.enum(["add", "delete", "update"]),
  }).passthrough()).max(MAX_FILE_CHANGES),
  status: z.enum(["in_progress", "completed", "failed"]),
}).passthrough();
const McpToolItemSchema = z.object({
  id: CodexItemIdSchema,
  type: z.literal("mcp_tool_call"),
  status: z.enum(["in_progress", "completed", "failed"]),
  result: z.unknown().nullable().optional(),
  error: z.unknown().nullable().optional(),
}).passthrough();
const CollabToolItemSchema = z.object({
  id: CodexItemIdSchema,
  type: z.literal("collab_tool_call"),
  status: z.enum(["in_progress", "completed", "failed"]),
}).passthrough();
const WebSearchItemSchema = z.object({
  id: CodexItemIdSchema,
  type: z.literal("web_search"),
}).passthrough();
const TodoListItemSchema = z.object({
  id: CodexItemIdSchema,
  type: z.literal("todo_list"),
}).passthrough();
const IgnoredItemSchema = z.object({
  id: CodexItemIdSchema,
  type: z.enum(["reasoning", "error"]),
}).passthrough();

const CodexItemSchema = z.discriminatedUnion("type", [
  AgentMessageItemSchema,
  CommandItemSchema,
  FileChangeItemSchema,
  McpToolItemSchema,
  CollabToolItemSchema,
  WebSearchItemSchema,
  TodoListItemSchema,
  IgnoredItemSchema,
]);

const CodexExecEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("thread.started"), thread_id: CodexProviderThreadIdSchema }).passthrough(),
  z.object({ type: z.literal("turn.started") }).passthrough(),
  z.object({ type: z.literal("turn.completed") }).passthrough(),
  z.object({ type: z.literal("turn.failed") }).passthrough(),
  z.object({ type: z.literal("item.started"), item: CodexItemSchema }).passthrough(),
  z.object({ type: z.literal("item.updated"), item: CodexItemSchema }).passthrough(),
  z.object({ type: z.literal("item.completed"), item: CodexItemSchema }).passthrough(),
  z.object({ type: z.literal("error") }).passthrough(),
]);
const MatrixCodexRecordSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("matrix.codex.approval.requested"),
    approvalId: ApprovalIdSchema,
    correlationId: CorrelationIdSchema,
    title: SafeDisplayStringSchema,
    safeDescription: SafeDisplayStringSchema,
    actionKind: z.enum(["command", "file_change", "provider"]),
    risk: z.enum(["medium", "high"]),
    allowedDecisions: z.array(z.enum(["approve", "approve_for_session", "decline", "cancel"]))
      .min(1).max(4),
  }).strict(),
  z.object({
    type: z.literal("matrix.codex.user_input.requested"),
    requestId: RequestIdSchema,
    correlationId: CorrelationIdSchema,
    title: SafeDisplayStringSchema,
    safeDescription: SafeDisplayStringSchema,
    questions: z.array(UserInputQuestionSchema).min(1).max(8),
    autoResolutionMs: z.number().int().min(60_000).max(240_000).optional(),
  }).strict(),
  z.object({
    type: z.literal("matrix.codex.assistant.delta"),
    delta: CodexTextSchema,
  }).strict(),
]);

export interface CodexEventContext {
  threadId: string;
  now: () => Date;
  nextEventId: () => string;
}

export interface CodexEventParseResult {
  events: AgentThreadEvent[];
  providerThreadId?: string;
  outcome?: "completed" | "failed";
}

function event(context: CodexEventContext, input: Record<string, unknown>): AgentThreadEvent {
  return AgentThreadEventSchema.parse({
    ...input,
    eventId: context.nextEventId(),
    threadId: context.threadId,
    occurredAt: context.now().toISOString(),
  });
}

function assistantEvents(
  context: CodexEventContext,
  item: z.infer<typeof AgentMessageItemSchema>,
): AgentThreadEvent[] {
  if (item.text.trim().length === 0) return [];
  const codePoints = Array.from(item.text);
  const events: AgentThreadEvent[] = [];
  for (let offset = 0; offset < codePoints.length; offset += MAX_ASSISTANT_DELTA_CHARS) {
    events.push(event(context, {
      type: "assistant.text.delta",
      messageId: item.id,
      delta: codePoints.slice(offset, offset + MAX_ASSISTANT_DELTA_CHARS).join(""),
    }));
  }
  events.push(event(context, { type: "assistant.text.completed", messageId: item.id }));
  return events;
}

function appServerRecordEvents(
  context: CodexEventContext,
  record: z.infer<typeof MatrixCodexRecordSchema>,
): AgentThreadEvent[] {
  if (record.type === "matrix.codex.approval.requested") {
    return [event(context, {
      type: "approval.requested",
      approval: {
        approvalId: record.approvalId,
        threadId: context.threadId,
        title: record.title,
        safeDescription: record.safeDescription,
        actionKind: record.actionKind,
        risk: record.risk,
        allowedDecisions: record.allowedDecisions,
        correlationId: record.correlationId,
      },
    })];
  }
  if (record.type === "matrix.codex.user_input.requested") {
    return [event(context, {
      type: "user_input.requested",
      request: {
        requestId: record.requestId,
        threadId: context.threadId,
        title: record.title,
        safeDescription: record.safeDescription,
        required: true,
        questions: record.questions,
        ...(record.autoResolutionMs ? { autoResolutionMs: record.autoResolutionMs } : {}),
        correlationId: record.correlationId,
      },
    })];
  }
  const codePoints = Array.from(record.delta);
  const events: AgentThreadEvent[] = [];
  for (let offset = 0; offset < codePoints.length; offset += MAX_ASSISTANT_DELTA_CHARS) {
    events.push(event(context, {
      type: "assistant.text.delta",
      messageId: "codex_app_server",
      delta: codePoints.slice(offset, offset + MAX_ASSISTANT_DELTA_CHARS).join(""),
    }));
  }
  return events;
}

function toolStarted(
  context: CodexEventContext,
  itemId: string,
  displayName: string,
  kind: string,
): AgentThreadEvent {
  return event(context, {
    type: "tool.started",
    toolCallId: itemId,
    displayName,
    kind,
  });
}

function toolCompleted(
  context: CodexEventContext,
  itemId: string,
  outcome: "success" | "failed" | "cancelled",
): AgentThreadEvent {
  return event(context, {
    type: "tool.completed",
    toolCallId: itemId,
    outcome,
  });
}

function commandOutcome(status: z.infer<typeof CodexStatusSchema>): "success" | "failed" | "cancelled" {
  if (status === "completed") return "success";
  if (status === "declined") return "cancelled";
  return "failed";
}

function safeFileChangeEvent(
  context: CodexEventContext,
  change: z.infer<typeof FileChangeItemSchema>["changes"][number],
): AgentThreadEvent | null {
  const parsed = AgentThreadEventSchema.safeParse({
    type: "file.changed",
    eventId: context.nextEventId(),
    threadId: context.threadId,
    occurredAt: context.now().toISOString(),
    path: change.path,
    changeKind: change.kind === "add" ? "created" : change.kind === "delete" ? "deleted" : "updated",
  });
  return parsed.success ? parsed.data : null;
}

function startedItemEvents(
  context: CodexEventContext,
  item: z.infer<typeof CodexItemSchema>,
): AgentThreadEvent[] {
  if (item.type === "command_execution") return [toolStarted(context, item.id, "Run command", "command")];
  if (item.type === "mcp_tool_call") return [toolStarted(context, item.id, "Use tool", "tool")];
  if (item.type === "collab_tool_call") return [toolStarted(context, item.id, "Coordinate agents", "agent")];
  if (item.type === "web_search") return [toolStarted(context, item.id, "Search web", "search")];
  if (item.type === "todo_list") return [toolStarted(context, item.id, "Update plan", "plan")];
  return [];
}

function completedItemEvents(
  context: CodexEventContext,
  item: z.infer<typeof CodexItemSchema>,
): AgentThreadEvent[] {
  if (item.type === "agent_message") return assistantEvents(context, item);
  if (item.type === "command_execution") {
    return [
      ...(item.aggregated_output.length > 0
        ? [event(context, {
            type: "tool.output",
            toolCallId: item.id,
            text: "Command produced output.",
            truncated: true,
          })]
        : []),
      toolCompleted(context, item.id, commandOutcome(item.status)),
    ];
  }
  if (item.type === "file_change") {
    const changes = item.changes
      .map((change) => safeFileChangeEvent(context, change))
      .filter((change): change is AgentThreadEvent => change !== null);
    return [
      toolStarted(context, item.id, "Update files", "file_change"),
      ...changes,
      toolCompleted(context, item.id, item.status === "completed" ? "success" : "failed"),
    ];
  }
  if (item.type === "mcp_tool_call") {
    return [
      ...((item.result !== null && item.result !== undefined) || (item.error !== null && item.error !== undefined)
        ? [event(context, {
            type: "tool.output",
            toolCallId: item.id,
            text: "Tool returned a result.",
            truncated: true,
          })]
        : []),
      toolCompleted(context, item.id, item.status === "completed" ? "success" : "failed"),
    ];
  }
  if (item.type === "collab_tool_call") {
    return [toolCompleted(context, item.id, item.status === "completed" ? "success" : "failed")];
  }
  if (item.type === "web_search" || item.type === "todo_list") {
    return [toolCompleted(context, item.id, "success")];
  }
  return [];
}

export function parseCodexExecJsonLine(
  line: string,
  context: CodexEventContext,
): CodexEventParseResult {
  if (Buffer.byteLength(line, "utf-8") > MAX_CODEX_JSON_LINE_BYTES) return { events: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) {
      console.warn("[coding-agents] Codex event JSON parsing failed");
    }
    return { events: [] };
  }
  const appServerRecord = MatrixCodexRecordSchema.safeParse(raw);
  if (appServerRecord.success) {
    return { events: appServerRecordEvents(context, appServerRecord.data) };
  }
  const parsed = CodexExecEventSchema.safeParse(raw);
  if (!parsed.success) return { events: [] };

  const codexEvent = parsed.data;
  if (codexEvent.type === "thread.started") {
    return { events: [], providerThreadId: codexEvent.thread_id };
  }
  if (codexEvent.type === "turn.started") {
    return { events: [event(context, { type: "thread.status", status: "running" })] };
  }
  if (codexEvent.type === "turn.completed") return { events: [], outcome: "completed" };
  if (codexEvent.type === "turn.failed") return { events: [], outcome: "failed" };
  if (codexEvent.type === "item.started") {
    return { events: startedItemEvents(context, codexEvent.item) };
  }
  if (codexEvent.type === "item.completed") {
    return { events: completedItemEvents(context, codexEvent.item) };
  }
  return { events: [] };
}
