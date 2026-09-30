import { importBlocks, firstText, isInjectedContext } from "#local-chat-import/blocks";
import { object, string, type ImportBlock, type ImportConversation, type ImportProjection, type ImportSource } from "#local-chat-import/types";
interface Mirror { paired?: boolean; at: number; key: string; role: string; representation: string; itemId?: string; turnId?: string; firstDigest: string; digest: string }
async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
const BOOKKEEPING = new Set(["world_state", "turn_context", "token_usage_record", "state", "reasoning"]);
/** Bounded local mirror evidence, never a global repeated-text deduplicator. */
export class CodexReconstruction {
  private conversation: ImportConversation = { harness: "codex" };
  private mirrors: Mirror[] = [];
  private turnId?: string;
  private inheritedUntil?: number;
  private child = false;

  async project(record: Record<string, unknown>, source: ImportSource): Promise<ImportProjection[]> {
    let item = object(record.payload);
    const recordType = string(record.type) ?? string(record.record_type) ?? "unknown";
    const base = () => ({ source, conversation: { ...this.conversation } });
    if (recordType === "session_meta" || (!record.type && typeof record.id === "string")) {
      if (recordType !== "session_meta") item = record;
      this.conversation.sessionId = string(item.id) ?? string(item.session_id);
      this.child = Boolean(object(item.source).subagent);
      const spawn = object(object(object(item.source).subagent).thread_spawn);
      this.conversation.agentId = this.child ? string(spawn.agent_path) ?? this.conversation.sessionId : undefined;
      this.inheritedUntil = typeof item.subagent_history_start_ordinal === "number" ? item.subagent_history_start_ordinal : undefined;
      return [{ ...base(), kind: "metadata", metadata: item }];
    }
    if (recordType === "turn_context") {
      this.mirrors = []; this.turnId = string(item.turn_id);
    }
    if (recordType === "compacted") return [{ ...base(), kind: "compaction", blocks: importBlocks(string(item.message)) }];
    if (BOOKKEEPING.has(recordType)) return [{ ...base(), kind: "bookkeeping", recordType }];
    let representation = "model";
    if (recordType === "event_msg") {
      const nextTurn = string(item.turn_id);
      if (nextTurn && this.turnId && nextTurn !== this.turnId) this.mirrors = [];
      this.turnId = nextTurn ?? this.turnId;
      if (["turn_started", "turn.started", "task_started", "turn_complete", "turn.completed", "task_complete"].includes(String(item.type))) {
        this.mirrors = []; this.turnId = nextTurn;
      }
      if (item.type === "turn_aborted" || item.type === "turn.aborted") {
        return [{ ...base(), kind: "notice", outcome: "interrupted", label: "Imported turn interrupted" }];
      }
      if (item.type === "turn_failed" || item.type === "turn.failed" || item.type === "error") {
        return [{ ...base(), kind: "notice", outcome: "failed", label: "Imported turn failed" }];
      }
      if (item.type !== "item_completed" && item.type !== "item.completed") {
        return [{ ...base(), kind: "bookkeeping", recordType: string(item.type) ?? recordType }];
      }
      item = object(item.item);
      representation = "event";
    } else if (recordType !== "response_item") item = record;
    const type = string(item.type) ?? "unknown";
    if (type === "agent_message" && (item.author || item.recipient)) {
      return [{ ...base(), kind: "inter_agent", blocks: importBlocks(item.content) }];
    }
    if (type === "reasoning") return [{ ...base(), kind: "thinking" }];
    if (type === "message" || type === "UserMessage" || type === "AgentMessage" || type === "agent_message") {
      const role = type === "UserMessage" ? "user" : type === "AgentMessage" || type === "agent_message" ? "assistant" : item.role;
      const blocks = importBlocks(item.content ?? string(item.text));
      if (role !== "user" && role !== "assistant") return [{ ...base(), kind: "context", blocks }];
      if (role === "assistant") this.mirrors = this.mirrors.filter(entry => entry.role !== "user");
      if (role === "user" && (isInjectedContext(firstText(blocks))
        || (this.inheritedUntil !== undefined && source.ordinal !== undefined && source.ordinal < this.inheritedUntil))) {
        return [{ ...base(), kind: "context", blocks }];
      }
      if (!blocks.length) return [{ ...base(), kind: "bookkeeping", recordType: type }];
      const firstDigest = await digest(firstText(blocks) ?? "");
      const allDigest = await digest(JSON.stringify(blocks));
      const itemId = string(item.id);
      this.mirrors = this.mirrors.filter((entry) => source.line - entry.at <= 8);
      const mirror = this.mirrors.slice().reverse().find((entry) => entry.role === role
        && (!entry.turnId || !this.turnId || entry.turnId === this.turnId)
        && ((itemId && entry.itemId === itemId && entry.digest === allDigest)
          || (!entry.paired && entry.representation !== representation && Boolean(firstText(blocks))
            && Boolean(entry.turnId || this.turnId) && (source.line - entry.at === 1 || (entry.turnId && entry.turnId === this.turnId))
            && entry.firstDigest === firstDigest
            && (role === "user" || entry.digest === allDigest))));
      if (mirror) mirror.paired = true;
      if (mirror && (mirror.digest === allDigest || representation === "event")) return [];
      const key = mirror?.key ?? `${this.conversation.sessionId ?? "unknown"}:${itemId ?? source.offset}`;
      this.mirrors.push({ paired: Boolean(mirror), at: source.line, key, role, representation, itemId, turnId: this.turnId, firstDigest, digest: allDigest });
      if (this.mirrors.length > 32) this.mirrors.shift();
      return [{ ...base(), kind: "message", messageKey: key, role,
        mode: mirror ? "replace_mirror" : "append_fragment",
        origin: role === "assistant" ? "assistant" : this.child ? "agent_task" : "human",
        phase: item.phase === "commentary" ? "commentary" : item.phase === "final" || item.phase === "final_answer" ? "final" : "unknown", blocks }];
    }
    this.mirrors = this.mirrors.filter(entry => entry.role !== "user");
    const callId = string(item.call_id) ?? string(item.id) ?? `missing:${source.offset}`;
    if (type === "function_call" || type === "custom_tool_call") {
      return [{ ...base(), kind: "tool_call", callId, name: string(item.name) ?? "Unknown tool", input: item.arguments ?? item.input }];
    }
    if (type === "function_call_output" || type === "custom_tool_call_output") {
      return [{ ...base(), kind: "tool_result", callId, blocks: importBlocks(item.output), outcome: "success" }];
    }
    if (type === "CommandExecution" || type === "command_execution") {
      const result: ImportProjection[] = [{ ...base(), kind: "tool_call", callId, name: "Command", input: item.command }];
      const output = item.aggregated_output ?? item.output;
      if (output !== undefined) result.push({ ...base(), kind: "tool_result", callId, blocks: importBlocks(output),
        outcome: item.status === "failed" || (typeof item.exit_code === "number" && item.exit_code !== 0) ? "failed"
          : item.status === "in_progress" ? "incomplete" : "success" });
      return result;
    }
    return [{ ...base(), kind: "unknown", recordType: type }];
  }
}
