import { z } from "zod/v4";

const SessionIdSchema = z.uuid();
const MetadataSchema = z.object({
  type: z.literal("session_meta"),
  payload: z.object({
    id: SessionIdSchema,
    cwd: z.string().min(1).max(4096),
    git: z.object({ repository_url: z.string().max(4096).nullable().optional() }).passthrough().optional(),
  }).passthrough(),
}).passthrough();

export interface CodexImportMessage {
  role: "user" | "assistant";
  text: string;
  createdAt: string;
}

export interface CodexImportMetadata {
  sourceId: string;
  cwd: string;
  repositoryUrl?: string;
}

export type CodexImportEvent = { type: "metadata"; value: CodexImportMetadata }
  | { type: "message"; value: CodexImportMessage };

const MAX_VISIBLE_RECORD_CHARS = 16 * 1024 * 1024;

function ignorableRecordPrefix(prefix: string): boolean {
  const kind = /"type"\s*:\s*"([^"]+)"/.exec(prefix)?.[1];
  if (kind && kind !== "session_meta" && kind !== "response_item") return true;
  if (kind !== "response_item") return false;
  const payloadKind = /"payload"\s*:\s*\{\s*"type"\s*:\s*"([^"]+)"/.exec(prefix)?.[1];
  return payloadKind !== undefined && payloadKind !== "message";
}

/** Splits byte streams into JSONL records while discarding large internal records early. */
export async function* decodeCodexJsonl(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let current = "";
  let discarding = false;
  const append = (segment: string) => {
    if (discarding) return;
    current += segment;
    if (current.length > 8192 && ignorableRecordPrefix(current.slice(0, 2048))) {
      current = "";
      discarding = true;
    } else if (current.length > MAX_VISIBLE_RECORD_CHARS) {
      throw new Error("Codex JSONL record exceeds the visible message limit");
    }
  };
  for await (const bytes of chunks) {
    const text = decoder.decode(bytes, { stream: true });
    let start = 0;
    while (start < text.length) {
      const end = text.indexOf("\n", start);
      if (end < 0) { append(text.slice(start)); break; }
      append(text.slice(start, end));
      if (!discarding && !ignorableRecordPrefix(current.slice(0, 2048))) {
        yield current.endsWith("\r") ? current.slice(0, -1) : current;
      } else {
        // Keep physical JSONL positions while avoiding materializing internal records.
        yield "";
      }
      current = "";
      discarding = false;
      start = end + 1;
    }
  }
  append(decoder.decode());
  if (current && !discarding && !ignorableRecordPrefix(current.slice(0, 2048))) yield current;
}

function* visibleTextChunks(text: string): Generator<string> {
  let start = 0;
  let offset = 0;
  let bytes = 0;
  for (const character of text) {
    const codepoint = character.codePointAt(0)!;
    const nextBytes = codepoint <= 0x7f ? 1 : codepoint <= 0x7ff ? 2
      : codepoint <= 0xffff ? 3 : 4;
    if (offset > start && (offset - start + character.length > 20_000 || bytes + nextBytes > 64 * 1024)) {
      yield text.slice(start, offset);
      start = offset;
      bytes = 0;
    }
    offset += character.length;
    bytes += nextBytes;
  }
  if (offset > start) yield text.slice(start, offset);
}

/**
 * Projects a Codex JSONL session into the visible human conversation. Internal
 * instructions, reasoning, tool calls/results and duplicate event_msg records
 * are never sent to Chat. The caller can consume messages incrementally.
 */
export async function* streamCodexTranscript(
  lines: Iterable<string> | AsyncIterable<string>,
): AsyncGenerator<CodexImportEvent> {
  let metadataSeen = false;
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    // Codex tool output can be enormous. Its record kind appears at the start
    // of each JSONL line, so avoid parsing it into another large JS object.
    const prefix = line.slice(0, 2048);
    const recordKind = /"type"\s*:\s*"([^"]+)"/.exec(prefix)?.[1];
    if (recordKind !== "session_meta" && recordKind !== "response_item") continue;
    if (recordKind === "response_item" && ignorableRecordPrefix(prefix)) continue;
    let raw: unknown;
    try { raw = JSON.parse(line) as unknown; }
    catch (error: unknown) {
      if (error instanceof SyntaxError) throw new Error(`Invalid Codex JSONL at line ${lineNumber}`);
      throw error;
    }
    if (typeof raw !== "object" || raw === null || !("type" in raw)) continue;
    if (raw.type === "session_meta") {
      if (metadataSeen) throw new Error("Codex transcript contains multiple session identities");
      const parsed = MetadataSchema.parse(raw);
      metadataSeen = true;
      yield { type: "metadata", value: {
        sourceId: parsed.payload.id,
        cwd: parsed.payload.cwd,
        ...(parsed.payload.git?.repository_url ? { repositoryUrl: parsed.payload.git.repository_url } : {}),
      } };
      continue;
    }
    if (!metadataSeen) throw new Error("Codex transcript has no session identity");
    if (raw.type !== "response_item" || !("payload" in raw)
      || typeof raw.payload !== "object" || raw.payload === null) continue;
    const payload = raw.payload as Record<string, unknown>;
    if (payload.type !== "message") continue;
    const role = payload.role;
    if (role !== "user" && role !== "assistant") continue;
    if (role === "assistant" && payload.phase !== undefined
      && payload.phase !== null && payload.phase !== "final_answer" && payload.phase !== "final") continue;
    if (!Array.isArray(payload.content)) continue;
    const text = payload.content.flatMap((part: unknown) => {
      if (typeof part !== "object" || part === null || !("type" in part) || !("text" in part)) return [];
      const content = part as { type: unknown; text: unknown };
      if (content.type !== (role === "user" ? "input_text" : "output_text")
        || typeof content.text !== "string") return [];
      return [content.text];
    }).join("\n");
    if (!text.trim()) continue;
    const timestamp = "timestamp" in raw && typeof raw.timestamp === "string" ? new Date(raw.timestamp) : null;
    if (!timestamp || Number.isNaN(timestamp.getTime())) {
      throw new Error(`Codex message has no valid timestamp at line ${lineNumber}`);
    }
    for (const chunk of visibleTextChunks(text)) {
      yield { type: "message", value: { role, text: chunk, createdAt: timestamp.toISOString() } };
    }
  }
  if (!metadataSeen) throw new Error("Codex transcript has no session identity");
}

export async function parseCodexTranscript(
  lines: Iterable<string> | AsyncIterable<string>,
): Promise<CodexImportMetadata & { messages: CodexImportMessage[] }> {
  let metadata: CodexImportMetadata | undefined;
  const messages: CodexImportMessage[] = [];
  let projectedBytes = 0;
  for await (const event of streamCodexTranscript(lines)) {
    if (event.type === "metadata") metadata = event.value;
    else {
      projectedBytes += new TextEncoder().encode(event.value.text).byteLength;
      if (messages.length >= 10_000 || projectedBytes > 100 * 1024 * 1024) {
        throw new Error("Projected conversation exceeds the import limit.");
      }
      messages.push(event.value);
    }
  }
  if (!metadata) throw new Error("Codex transcript has no session identity");
  return { ...metadata, messages };
}
