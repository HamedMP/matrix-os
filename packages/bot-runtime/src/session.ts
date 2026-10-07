import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { BOT_SESSION_MAX_BYTES } from "@matrix-os/contracts";

export const SESSION_MAX_BYTES = BOT_SESSION_MAX_BYTES;
/** Compact before the hard cap so one more turn always fits. */
export const SESSION_COMPACT_AT_BYTES = 384 * 1024;
const COMPACT_AT_CONTEXT_RATIO = 0.8;
const KEEP_RECENT_USER_TURNS = 4;
const ROLES = new Set(["system", "user", "assistant", "toolResult"]);
/** Progressively tighter caps on tool payloads in the saved transcript only. */
const TOOL_PAYLOAD_CAPS = [32 * 1024, 8 * 1024, 2 * 1024, 512] as const;
/** A shortened reply always keeps at least this much of its text. */
const MIN_KEPT_CHARS = 512;
/** Headroom so the encoded save always fits the session cap. */
const STORAGE_TARGET_BYTES = SESSION_MAX_BYTES - 16 * 1024;
const SUMMARY_PREFIX = "Summary of the earlier conversation, for context only:\n\n";
const DROPPED_HISTORY_NOTE = "[Earlier conversation was removed to fit saved history.]";
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

function imagePlaceholder(mimeType: unknown): { type: "text"; text: string } {
  const kind = typeof mimeType === "string" && /^image\/[a-z0-9.+-]{1,32}$/.test(mimeType) ? mimeType : "image";
  return { type: "text", text: `[An ${kind} was shown to the assistant here. It is not kept in saved history.]` };
}

function withoutImageParts<T>(content: T): T {
  if (!Array.isArray(content)) return content;
  return content.map((part: { type?: unknown; mimeType?: unknown }) => (part?.type === "image" ? imagePlaceholder(part.mimeType) : part)) as T;
}

/**
 * Images reach the model in the turn they arrive. The saved transcript keeps
 * a text placeholder instead, so one image cannot push a session over its cap.
 */
export function withoutImages(messages: readonly AgentMessage[]): AgentMessage[] {
  return messages.map((message) => {
    if (message.role === "user" || message.role === "toolResult") {
      return { ...message, content: withoutImageParts(message.content) } as AgentMessage;
    }
    return message;
  });
}

function capText(text: string, cap: number): string {
  if (text.length <= cap) return text;
  // Never end on half of a surrogate pair.
  const end = cap > 0 && /[\uD800-\uDBFF]/.test(text[cap - 1]!) ? cap - 1 : cap;
  return `${text.slice(0, end)}\n[${text.length - end} characters were left out of saved history.]`;
}

function capStrings(value: unknown, cap: number): unknown {
  if (typeof value === "string") return capText(value, cap);
  if (Array.isArray(value)) return value.map((item) => capStrings(item, cap));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, capStrings(item, cap)]));
  }
  return value;
}

/** Tool results and tool-call arguments only; the person's words are never cut here. */
function capToolPayloads(message: AgentMessage, cap: number): AgentMessage {
  if (message.role === "toolResult") {
    return { ...message, content: message.content.map((part) => (part.type === "text" ? { ...part, text: capText(part.text, cap) } : part)) };
  }
  if (message.role === "assistant") {
    return {
      ...message,
      content: message.content.map((part) => (part.type === "toolCall"
        ? { ...part, arguments: capStrings(part.arguments, cap) as typeof part.arguments }
        : part)),
    };
  }
  return message;
}

/**
 * Drops whole turns from the oldest end, cutting at person messages so tool
 * calls stay with their results. The latest turn is always kept.
 */
function dropOldestTurns(messages: readonly AgentMessage[], maxBytes: number, now: number): AgentMessage[] {
  let headEnd = 0;
  while (headEnd < messages.length && messages[headEnd]!.role === "system") headEnd += 1;
  const head = messages.slice(0, headEnd);
  let rest = messages.slice(headEnd);
  const note: AgentMessage = { role: "user", content: DROPPED_HISTORY_NOTE, timestamp: now };
  let dropped = false;
  while (encodedSessionBytes([...head, ...(dropped ? [note] : []), ...rest]) > maxBytes) {
    const nextTurn = rest.findIndex((message, index) => index > 0 && message.role === "user");
    if (nextTurn < 0) break;
    rest = rest.slice(nextTurn);
    dropped = true;
  }
  return dropped ? [...head, note, ...rest] : [...head, ...rest];
}

/** True when cutting tool payloads alone brings the transcript under the storage target. */
export function fitsWithToolPayloadCaps(messages: readonly AgentMessage[], maxBytes = STORAGE_TARGET_BYTES): boolean {
  let capped = withoutImages(messages);
  for (const cap of TOOL_PAYLOAD_CAPS) {
    if (encodedSessionBytes(capped) <= maxBytes) return true;
    capped = capped.map((message) => capToolPayloads(message, cap));
  }
  return encodedSessionBytes(capped) <= maxBytes;
}

/** Index of the latest person message; everything from it on is the latest turn. */
function latestTurnStart(messages: readonly AgentMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.role === "user") return index;
  }
  return 0;
}

/** Bytes a string adds to the encoded transcript. */
function encodedTextBytes(text: string): number {
  return encoder.encode(JSON.stringify(text)).byteLength;
}

/**
 * The longest cut (at least MIN_KEPT_CHARS) whose shortened text encodes to
 * at most `maxBytes`. Measured in encoded bytes, so multibyte and escaped
 * characters are counted exactly. MIN_KEPT_CHARS when nothing longer fits.
 */
function longestCutWithin(text: string, maxBytes: number): number {
  let low = MIN_KEPT_CHARS;
  let high = text.length - 1;
  let best = MIN_KEPT_CHARS;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (encodedTextBytes(capText(text, middle)) <= maxBytes) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

/**
 * Shortens eligible assistant text by just the overflow, longest part first.
 * Each part is shortened at most once, so every part is considered and no
 * more of a reply is lost than the save limit requires.
 */
function trimAssistantOverflow(
  messages: AgentMessage[],
  maxBytes: number,
  eligible: (index: number) => boolean,
): AgentMessage[] {
  let overflow = encodedSessionBytes(messages) - maxBytes;
  if (overflow <= 0) return messages;
  const candidates: Array<{ message: number; part: number; text: string }> = [];
  messages.forEach((message, messageIndex) => {
    if (message.role !== "assistant" || !eligible(messageIndex)) return;
    message.content.forEach((part, partIndex) => {
      if (part.type === "text" && part.text.length > MIN_KEPT_CHARS) candidates.push({ message: messageIndex, part: partIndex, text: part.text });
    });
  });
  candidates.sort((a, b) => b.text.length - a.text.length);
  const shortened = new Map<number, Map<number, string>>();
  for (const candidate of candidates) {
    if (overflow <= 0) break;
    const before = encodedTextBytes(candidate.text);
    const text = capText(candidate.text, longestCutWithin(candidate.text, before - overflow));
    const saved = before - encodedTextBytes(text);
    // A part barely over the minimum grows once the note is added; leave it whole.
    if (saved <= 0) continue;
    const parts = shortened.get(candidate.message) ?? new Map<number, string>();
    parts.set(candidate.part, text);
    shortened.set(candidate.message, parts);
    overflow -= saved;
  }
  return messages.map((message, messageIndex) => {
    const parts = shortened.get(messageIndex);
    if (!parts || message.role !== "assistant") return message;
    return {
      ...message,
      content: message.content.map((part, partIndex) => {
        const text = parts.get(partIndex);
        return text !== undefined && part.type === "text" ? { ...part, text } : part;
      }),
    };
  });
}

/**
 * Fits a transcript for storage. Images always become placeholders. While
 * it is still too large: tool payloads are cut with a visible note, then
 * earlier replies are shortened by just the overflow, then (if allowed) the
 * oldest turns are dropped behind a note, and only as a last resort the
 * latest reply is shortened, again by just the overflow. The person's words
 * are never shortened. A cancelled run may not drop turns; if even the
 * shortened transcript cannot fit, `encodeSession` refuses it and the
 * previous session is kept.
 */
export function fitForStorage(
  messages: readonly AgentMessage[],
  maxBytes = STORAGE_TARGET_BYTES,
  now: () => number = Date.now,
  options: { allowDroppingTurns?: boolean } = {},
): AgentMessage[] {
  let stored = withoutImages(messages);
  const fits = () => encodedSessionBytes(stored) <= maxBytes;
  for (const cap of TOOL_PAYLOAD_CAPS) {
    if (fits()) return stored;
    stored = stored.map((message) => capToolPayloads(message, cap));
  }
  const latest = latestTurnStart(stored);
  stored = trimAssistantOverflow(stored, maxBytes, (index) => index < latest);
  if (fits()) return stored;
  if (options.allowDroppingTurns !== false) stored = dropOldestTurns(stored, maxBytes, now());
  return trimAssistantOverflow(stored, maxBytes, () => true);
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

/** Discard derived context, never the canonical Chat transcript or ordinary saved turns. */
export function withoutDerivedSummaries(messages: readonly AgentMessage[]): AgentMessage[] {
  const firstTurn = messages.findIndex((message) => message.role !== "system");
  return messages.filter((message, index) => {
    if (message.role !== "user") return true;
    if ("matrixBotSessionKind" in message && message.matrixBotSessionKind === "summary") return false;
    // Older bundles put an untagged summary first, after the system prompt.
    // A later person message quoting that envelope is still an ordinary turn.
    return index !== firstTurn || typeof message.content !== "string" || !message.content.startsWith(SUMMARY_PREFIX);
  });
}

export function summaryMessage(summary: string, timestamp: number): AgentMessage {
  const message = {
    role: "user" as const,
    content: `${SUMMARY_PREFIX}${summary}`,
    timestamp,
    matrixBotSessionKind: "summary" as const,
  };
  return message;
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
  keepRecentUserTurns?: number;
}): Promise<AgentMessage[]> {
  const plan = planCompaction(input.messages, input.keepRecentUserTurns);
  if (!plan) return [...input.messages];
  const summary = (await input.summarize(serializeForSummary(plan.older))).trim();
  if (summary.length === 0) return [...input.messages];
  return [...plan.head, summaryMessage(summary.slice(0, 16_000), input.now()), ...plan.recent];
}
