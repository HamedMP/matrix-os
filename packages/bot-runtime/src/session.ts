import { estimateContextTokens, type AgentMessage } from "@earendil-works/pi-agent-core";

export const SESSION_MAX_BYTES = 512 * 1024;
/** Compact before the hard cap so one more turn always fits. */
export const SESSION_COMPACT_AT_BYTES = 384 * 1024;
const COMPACT_AT_CONTEXT_RATIO = 0.8;
const KEEP_RECENT_USER_TURNS = 4;
const ROLES = new Set(["system", "user", "assistant", "toolResult"]);
const encoder = new TextEncoder();

export class BotSessionError extends Error {
  constructor(readonly code: "invalid" | "too_large") {
    super(`Bot session is ${code === "invalid" ? "invalid" : "too large"}`);
    this.name = "BotSessionError";
  }
}

export function encodedSessionBytes(messages: readonly unknown[]): number {
  return encoder.encode(JSON.stringify(messages)).byteLength;
}

/** Stored sessions are opaque JSON to the gateway; the runtime checks their shape on load. */
export function decodeSession(records: readonly Record<string, unknown>[]): AgentMessage[] {
  if (encodedSessionBytes(records) > SESSION_MAX_BYTES) throw new BotSessionError("too_large");
  for (const record of records) {
    if (typeof record.role !== "string" || !ROLES.has(record.role)) throw new BotSessionError("invalid");
    if (typeof record.timestamp !== "number" || !Number.isFinite(record.timestamp)) throw new BotSessionError("invalid");
  }
  return structuredClone(records) as unknown as AgentMessage[];
}

export function encodeSession(messages: readonly AgentMessage[]): Record<string, unknown>[] {
  const records = JSON.parse(JSON.stringify(messages)) as Record<string, unknown>[];
  if (encodedSessionBytes(records) > SESSION_MAX_BYTES) throw new BotSessionError("too_large");
  return records;
}

export function needsCompaction(messages: readonly AgentMessage[], contextWindow: number): boolean {
  if (encodedSessionBytes(messages) > SESSION_COMPACT_AT_BYTES) return true;
  return estimateContextTokens([...messages]).tokens > contextWindow * COMPACT_AT_CONTEXT_RATIO;
}

export interface CompactionPlan {
  /** Leading system messages carry the prompt and tool set; they are kept verbatim. */
  head: AgentMessage[];
  older: AgentMessage[];
  recent: AgentMessage[];
}

/**
 * Cuts at a user message so every assistant tool call stays with its results.
 * Returns undefined when there is nothing old enough to summarize.
 */
export function planCompaction(messages: readonly AgentMessage[], keepRecentUserTurns = KEEP_RECENT_USER_TURNS): CompactionPlan | undefined {
  let headEnd = 0;
  while (headEnd < messages.length && messages[headEnd]!.role === "system") headEnd += 1;
  const userIndexes: number[] = [];
  for (let index = headEnd; index < messages.length; index += 1) {
    if (messages[index]!.role === "user") userIndexes.push(index);
  }
  if (userIndexes.length <= keepRecentUserTurns) return undefined;
  const cut = userIndexes[userIndexes.length - keepRecentUserTurns]!;
  if (cut <= headEnd) return undefined;
  return { head: messages.slice(0, headEnd), older: messages.slice(headEnd, cut), recent: messages.slice(cut) };
}

export function summaryMessage(summary: string, timestamp: number): AgentMessage {
  return {
    role: "user",
    content: `Summary of the earlier conversation, for context only:\n\n${summary}`,
    timestamp,
  };
}

/** Plain-text transcript of messages to summarize; images and raw tool payloads are elided. */
export function serializeForSummary(messages: readonly AgentMessage[], maxChars = 200_000): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "toolResult") {
      const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      lines.push(`Tool result (${message.toolName}): ${text.slice(0, 2_000)}`);
      continue;
    }
    // Only person and bot turns are summarized; harness-specific message types are skipped.
    if (message.role !== "user" && message.role !== "assistant") continue;
    const content = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
    for (const part of content) {
      if (part.type === "text") lines.push(`${message.role === "user" ? "Person" : "Bot"}: ${part.text}`);
      else if (part.type === "toolCall") lines.push(`Bot used ${part.name}.`);
    }
  }
  const text = lines.join("\n");
  return text.length > maxChars ? text.slice(text.length - maxChars) : text;
}

export async function compactSession(input: {
  messages: readonly AgentMessage[];
  summarize(transcript: string): Promise<string>;
  now(): number;
}): Promise<AgentMessage[]> {
  const plan = planCompaction(input.messages);
  if (!plan) return [...input.messages];
  const summary = (await input.summarize(serializeForSummary(plan.older))).trim();
  if (summary.length === 0) return [...input.messages];
  return [...plan.head, summaryMessage(summary.slice(0, 16_000), input.now()), ...plan.recent];
}
