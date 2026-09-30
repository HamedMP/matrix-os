import { importBlocks } from "./blocks.js";
import { object, string, type ImportConversation, type ImportProjection, type ImportSource } from "./types.js";
/** Claude UUIDs identify records; message IDs identify responses with multiple fragments. */
export function projectClaude(record: Record<string, unknown>, source: ImportSource): ImportProjection[] {
  const conversation: ImportConversation = { harness: "claude", sessionId: string(record.sessionId), agentId: string(record.agentId) };
  const base = { source, conversation };
  const type = string(record.type) ?? "unknown";
  if (record.isApiErrorMessage === true) return [{ ...base, kind: "notice", outcome: "failed", label: "Imported response failed" }];
  if (type !== "user" && type !== "assistant") {
    if (object(record.compactMetadata).trigger || record.isCompactSummary === true) {
      return [{ ...base, kind: "compaction", blocks: importBlocks(object(record.message).content ?? record.content) }];
    }
    return [{ ...base, kind: type === "system" || type === "attachment" || type === "file-history-snapshot" ? "bookkeeping" : "unknown", recordType: type }];
  }
  const message = object(record.message);
  const content = message.content;
  const messageKey = `${conversation.sessionId ?? "unknown"}:${conversation.agentId ?? "main"}:${type === "assistant" ? string(message.id) ?? source.recordId ?? source.offset : source.recordId ?? source.offset}`;
  const result: ImportProjection[] = [];
  const values = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
  // Validate the complete record before projecting individual blocks in source order.
  importBlocks(values);
  for (let blockIndex = 0; blockIndex < values.length; blockIndex++) {
    const block = object(values[blockIndex]);
    const at = { ...base, source: { ...source, blockIndex } };
    if (block.type === "tool_use") {
      result.push({ ...at, kind: "tool_call", callId: string(block.id) ?? `missing:${source.offset}:${blockIndex}`,
        name: string(block.name) ?? "Unknown tool", input: block.input, responseKey: messageKey });
    } else if (block.type === "tool_result") {
      result.push({ ...at, kind: "tool_result", callId: string(block.tool_use_id) ?? `missing:${source.offset}:${blockIndex}`,
        blocks: importBlocks(block.content), outcome: block.is_error === true ? "failed" : "success" });
    } else if (block.type === "thinking" || block.type === "redacted_thinking") {
      result.push({ ...at, kind: "thinking", text: string(block.thinking), responseKey: messageKey });
    } else {
      const blocks = importBlocks([values[blockIndex]]);
      if (record.isMeta === true || record.isCompactSummary === true) {
        result.push({ ...at, kind: record.isCompactSummary === true ? "compaction" : "context", blocks });
      } else if (blocks.length) result.push({ ...at, kind: "message", messageKey, role: type,
        origin: type === "assistant" ? "assistant" : conversation.agentId || record.isSidechain === true ? "agent_task" : "human",
        phase: message.stop_reason === "end_turn" ? "final" : "unknown", blocks });
    }
  }
  if (!result.length) result.push({ ...base, kind: "bookkeeping", recordType: type });
  return result;
}
