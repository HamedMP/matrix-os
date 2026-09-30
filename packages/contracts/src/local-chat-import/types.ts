import type { LocalChatSourceIssue } from "./jsonl.js";
export type ImportHarness = "codex" | "claude";
export interface ImportSource {
  line: number; offset: number; end: number; ordinal?: number; blockIndex?: number;
  timestamp?: string; recordId?: string; parentRecordId?: string;
}
export interface ImportConversation { harness: ImportHarness; sessionId?: string; agentId?: string }
export type ImportBlock = { kind: "text"; text: string }
  | { kind: "media"; mediaType?: string; encoding: "base64" | "local" | "url"; data: string }
  | { kind: "opaque"; type: string };
interface Base { source: ImportSource; conversation: ImportConversation }
export type ImportProjection = Base & (
  { kind: "metadata"; metadata: Record<string, unknown> }
  | { kind: "message"; messageKey: string; role: "user" | "assistant"; origin: "human" | "assistant" | "agent_task";
    phase: "unknown" | "commentary" | "final"; mode?: "append_fragment" | "replace_mirror"; blocks: ImportBlock[] }
  | { kind: "tool_call"; callId: string; name: string; input: unknown; responseKey?: string }
  | { kind: "tool_result"; callId: string; blocks: ImportBlock[]; outcome: "success" | "failed" | "cancelled" | "incomplete"; responseKey?: string }
  | { kind: "thinking"; text?: string; responseKey?: string }
  | { kind: "context" | "compaction" | "inter_agent"; blocks: ImportBlock[] }
  | { kind: "notice"; outcome: "interrupted" | "failed"; label: string }
  | { kind: "bookkeeping" | "unknown"; recordType: string }
  | { kind: "issue"; code: LocalChatSourceIssue["code"] }
);
export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function string(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
