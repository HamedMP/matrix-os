import { AgentThreadEventSchema, type AgentThreadEvent } from "@matrix-os/contracts";
import { safeDisplayPath } from "../chat/safe-activity-projection.js";
import { logCodingAgentWarning } from "./diagnostics.js";
const MAX_DELTA_CHARS = 3_500;
const MAX_TEXT_CHARS = 24_000;
const MAX_SESSION_ID_CHARS = 64;

// SAFE_REFERENCE in the contracts allows [A-Za-z0-9_.:-]; pi tool-call ids
// contain "|", so normalize defensively and fall back to a synthetic id.
function safeReferenceId(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const cleaned = raw.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 128);
  if (!/^[A-Za-z0-9]/.test(cleaned) || cleaned.includes("..")) return fallback;
  return cleaned;
}

// tool.started displayName/kind must satisfy SafeDisplayStringSchema, which
// rejects path/secret-shaped text. Tool names are provider identifiers, so
// restrict to a conservative charset and drop anything risky.
function safeToolName(raw: unknown): string {
  if (typeof raw !== "string") return "tool";
  const cleaned = raw.trim().replace(/[^A-Za-z0-9 _-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  if (cleaned.length === 0) return "tool";
  if (/stack trace|\/home\/|\/tmp\/|\/var\/|\.ssh\/|id_rsa|bearer\s|sk-/i.test(cleaned)) return "tool";
  return cleaned;
}

// Contracts require non-blank text per event. Chunk long text preserving
// order; fold whitespace-only chunks into the previous one so every emitted
// chunk parses, keeping each chunk <= 4000 chars / 16KB.
function chunkDisplayText(text: string): string[] {
  const out: string[] = [];
  for (let index = 0; index < text.length; index += MAX_DELTA_CHARS) {
    const chunk = text.slice(index, index + MAX_DELTA_CHARS);
    if (chunk.trim().length === 0) {
      const last = out.at(-1);
      if (last !== undefined && last.length + chunk.length <= 4_000) {
        out[out.length - 1] = last + chunk;
      }
      continue;
    }
    out.push(chunk);
  }
  return out;
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

interface PiRunCollectorOptions {
  threadId: string;
  scope: string;
  messageIdentity: { next: number };
  homePath: string;
  executionRoot: string;
  now: () => Date;
  nextEventId: () => string;
  maxEvents: number;
  streaming: boolean;
}

export interface PiCollectedRun {
  events: AgentThreadEvent[];
  sessionId: string | null;
}

// Aggregating reducer: pi streams fine-grained deltas, but the provider
// contract delivers events as one batch at turn end, so deltas are
// accumulated per message and re-chunked within contract bounds. This also
// keeps chatty runs under the 500-event provider cap.
export function createPiRunCollector(options: PiRunCollectorOptions) {
  const events: AgentThreadEvent[] = [];
  let sessionId: string | null = null;
  let dropped = 0;
  let assistantText = "";
  let assistantMessageId: string | null = null;
  let assistantEmittedChars = 0;
  let fallbackToolCounter = 0;
  // Each tracked tool needs at least a started + completed event. Reserving
  // half the run budget keeps both the event stream and the in-memory tool
  // registries bounded even if a provider emits starts without matching ends.
  const maxTrackedTools = Math.max(1, Math.floor(options.maxEvents / 2));
  const toolOutputs = new Map<string, string>();
  const toolTruncated = new Set<string>();

  function emit(event: AgentThreadEvent): void {
    if (events.length >= options.maxEvents) {
      dropped += 1;
      return;
    }
    events.push(AgentThreadEventSchema.parse(event));
  }

  function baseEvent() {
    return {
      eventId: options.nextEventId(),
      threadId: options.threadId,
      occurredAt: options.now().toISOString(),
    };
  }

  function emitPendingAssistantText(): void {
    if (!assistantMessageId || assistantEmittedChars >= assistantText.length) return;
    const pending = assistantText.slice(assistantEmittedChars);
    for (const chunk of chunkDisplayText(pending)) {
      emit({ ...baseEvent(), type: "assistant.text.delta", messageId: assistantMessageId, delta: chunk });
    }
    assistantEmittedChars = assistantText.length;
  }

  function flushAssistantText(): void {
    const text = assistantText;
    const messageId = assistantMessageId;
    if (!messageId) return;
    const bounded = truncateText(text, MAX_TEXT_CHARS);
    assistantText = bounded.text;
    if (options.streaming) {
      emitPendingAssistantText();
    } else {
      for (const chunk of chunkDisplayText(bounded.text)) {
        emit({ ...baseEvent(), type: "assistant.text.delta", messageId, delta: chunk });
      }
    }
    if (bounded.truncated) {
      emit({ ...baseEvent(), type: "assistant.text.delta", messageId, delta: "…" });
    }
    if (bounded.text.trim().length > 0) {
      emit({ ...baseEvent(), type: "assistant.text.completed", messageId });
    }
    assistantText = "";
    assistantMessageId = null;
    assistantEmittedChars = 0;
  }

  function flushTool(
    toolCallId: string,
    resultText: string | undefined,
    outcome: "success" | "failed" | "cancelled",
  ): void {
    if (!toolOutputs.has(toolCallId)) return;
    const accumulated = toolOutputs.get(toolCallId) ?? "";
    toolOutputs.delete(toolCallId);
    const truncatedByCap = toolTruncated.delete(toolCallId);
    const raw = resultText !== undefined && resultText.length > 0 ? resultText : accumulated;
    const bounded = truncateText(raw, MAX_TEXT_CHARS);
    const chunks = chunkDisplayText(bounded.text);
    chunks.forEach((chunk, index) => {
      emit({
        ...baseEvent(),
        type: "tool.output",
        toolCallId,
        text: chunk,
        ...(index === chunks.length - 1 && (bounded.truncated || truncatedByCap) ? { truncated: true } : {}),
      });
    });
    if (chunks.length === 0 && truncatedByCap) {
      emit({ ...baseEvent(), type: "tool.output", toolCallId, text: "…", truncated: true });
    }
    emit({
      ...baseEvent(),
      type: "tool.completed",
      toolCallId,
      outcome,
    });
  }

  function contentText(content: unknown): string {
    if (!Array.isArray(content)) return "";
    return content
      .map((part) =>
        part && typeof part === "object" && "text" in part && typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : ""
      )
      .join("");
  }

  function feedEvent(event: Record<string, unknown>): void {
    switch (event.type) {
      case "session": {
        if (typeof event.id === "string" && event.id.length > 0 && event.id.length <= MAX_SESSION_ID_CHARS) {
          sessionId = event.id;
        }
        return;
      }
      case "message_update": {
        const update = event.assistantMessageEvent;
        if (!update || typeof update !== "object") return;
        const kind = (update as Record<string, unknown>).type;
        if (kind === "text_start") {
          flushAssistantText();
          assistantMessageId = `msg_${options.scope}_${++options.messageIdentity.next}`;
          assistantText = "";
          assistantEmittedChars = 0;
          return;
        }
        if (kind === "text_delta") {
          if (!assistantMessageId) {
            assistantMessageId = `msg_${options.scope}_${++options.messageIdentity.next}`;
          }
          const delta = (update as Record<string, unknown>).delta;
          if (typeof delta === "string" && assistantText.length < MAX_TEXT_CHARS) {
            assistantText += delta.slice(0, MAX_TEXT_CHARS - assistantText.length);
            if (options.streaming) emitPendingAssistantText();
          }
          return;
        }
        if (kind === "text_end") {
          const content = (update as Record<string, unknown>).content;
          if (typeof content === "string" && content.length > 0) {
            assistantText = content;
          }
          flushAssistantText();
          return;
        }
        // toolcall_start/delta/end and thinking_* carry no execution signal
        // the normalized stream needs; tool_execution_* events drive tools.
        return;
      }
      case "message_end": {
        const message = event.message;
        const role = message && typeof message === "object"
          ? (message as Record<string, unknown>).role
          : undefined;
        if (role === "assistant") {
          if (assistantText.trim().length === 0 && message && typeof message === "object") {
            const text = contentText((message as Record<string, unknown>).content);
            if (text.length > 0 && assistantMessageId) {
              assistantText = text;
            }
          }
          flushAssistantText();
        }
        return;
      }
      case "tool_execution_start": {
        flushAssistantText();
        const toolCallId = safeReferenceId(event.toolCallId, `tool_${options.scope}_${++fallbackToolCounter}`);
        const toolName = safeToolName(event.toolName);
        const normalizedToolName = toolName.toLowerCase();
        const args = event.args && typeof event.args === "object" && !Array.isArray(event.args)
          ? event.args as Record<string, unknown>
          : {};
        const readPath = normalizedToolName === "read"
          ? safeDisplayPath(args.path, {
              homePath: options.homePath,
              executionRoot: options.executionRoot,
            })
          : undefined;
        if (!toolOutputs.has(toolCallId) && toolOutputs.size >= maxTrackedTools) {
          dropped += 1;
          return;
        }
        toolOutputs.set(toolCallId, "");
        emit({
          ...baseEvent(),
          type: "tool.started",
          toolCallId,
          displayName: normalizedToolName === "read" ? "Read file" : toolName,
          kind: normalizedToolName === "read" ? "dynamic_tool" : toolName,
          ...(readPath ? { preview: readPath, previewKind: "path" as const } : {}),
        });
        return;
      }
      case "tool_execution_update": {
        const toolCallId = safeReferenceId(event.toolCallId, `tool_${options.scope}_${fallbackToolCounter}`);
        if (!toolOutputs.has(toolCallId)) return;
        const partial = event.partialResult;
        const text = partial && typeof partial === "object"
          ? contentText((partial as Record<string, unknown>).content)
          : "";
        if (text.length > 0) {
          if (text.length <= MAX_TEXT_CHARS) {
            toolOutputs.set(toolCallId, text);
          } else {
            toolOutputs.set(toolCallId, text.slice(0, MAX_TEXT_CHARS));
            toolTruncated.add(toolCallId);
          }
        }
        return;
      }
      case "tool_execution_end": {
        const toolCallId = safeReferenceId(event.toolCallId, `tool_${options.scope}_${fallbackToolCounter}`);
        const result = event.result;
        const resultText = result && typeof result === "object"
          ? contentText((result as Record<string, unknown>).content)
          : "";
        flushTool(toolCallId, resultText, event.isError === true ? "failed" : "success");
        return;
      }
      default:
        // agent_start/end, turn_start/end, agent_settled, queue_update,
        // compaction_*, auto_retry_*: lifecycle is store-owned; ignore.
        return;
    }
  }

  return {
    feedLine(line: string): void {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch (err: unknown) {
        if (err instanceof SyntaxError) {
          logCodingAgentWarning("pi provider skipped a non-JSON stdout line", err);
          return;
        }
        throw err;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      feedEvent(parsed as Record<string, unknown>);
    },
    drain(): AgentThreadEvent[] {
      return events.splice(0, events.length);
    },
    finish(): PiCollectedRun {
      flushAssistantText();
      // Any tool still open at stream end (e.g. SIGTERM mid-execution) is
      // completed as cancelled so chips never render as running forever.
      for (const toolCallId of [...toolOutputs.keys()]) {
        flushTool(toolCallId, undefined, "cancelled");
      }
      if (dropped > 0) {
        logCodingAgentWarning("pi provider dropped events beyond the run cap", new Error(`dropped=${dropped}`));
      }
      return { events, sessionId };
    },
  };
}

