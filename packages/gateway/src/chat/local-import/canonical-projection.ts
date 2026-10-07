/** Server-side readable projection; the private original remains the lossless source of truth. */
import { createHash } from "node:crypto";
import { CanonicalChatMessagePartSchema, type CanonicalChatMessagePart } from "@matrix-os/contracts";
import type { ImportBlock, ImportProjection } from "@matrix-os/contracts/local-chat-import";
export interface ImportAssetWriter {
  storeAsset(input: { bytes: Uint8Array; sha256: string; mimeType: string }): Promise<{ assetId: string }>;
}
export interface ImportedCanonicalRecord {
  recordKey: string; logicalKey: string; mode: "append" | "replace_mirror";
  role: "user" | "assistant" | "tool" | "system";
  createdAt?: string; parts: CanonicalChatMessagePart[];
}
const encoder = new TextEncoder();
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
/** Bounded by source record size; preserves full bytes in an asset whenever preview differs. */
function preview(text: string, max = 8_000): string {
  let result = text.slice(0, max);
  if (/[\uD800-\uDBFF]$/.test(result)) result = result.slice(0, -1);
  return result;
}
function safeToolName(name: string): string {
  const parsed = CanonicalChatMessagePartSchema.safeParse({ type: "tool_request", toolCallId: "import_probe", name, label: name });
  return parsed.success ? name : "Imported tool";
}
function mediaMime(bytes: Uint8Array, declared?: string): string {
  const b = Buffer.from(bytes);
  if (declared === "image/png" && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return declared;
  if (declared === "image/jpeg" && b[0] === 255 && b[1] === 216 && b[2] === 255) return declared;
  if (declared === "image/gif" && /^(GIF87a|GIF89a)$/.test(b.subarray(0, 6).toString("ascii"))) return declared;
  if (declared === "image/webp" && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP") return declared;
  if (declared === "application/pdf" && b.subarray(0, 5).toString("ascii") === "%PDF-") return declared;
  return "application/octet-stream";
}
async function reference(bytes: Uint8Array, kind: "text" | "tool_input" | "tool_output" | "image" | "file", mimeType: string, writer: ImportAssetWriter): Promise<CanonicalChatMessagePart> {
  if (bytes.byteLength > MAX_ASSET_BYTES) throw new Error("Import projection exceeds asset limit");
  const { assetId } = await writer.storeAsset({ bytes, sha256: digest(bytes), mimeType });
  return CanonicalChatMessagePartSchema.parse({ type: "import_reference", assetId, kind, mimeType, sizeBytes: bytes.byteLength,
    label: kind === "text" ? "Full message" : kind === "tool_input" ? "Full tool input" : kind === "tool_output" ? "Full tool output" : kind === "image" ? "Imported image" : "Imported file" });
}
async function blocksToParts(blocks: ImportBlock[], writer: ImportAssetWriter, textKind: "text" | "tool_output" = "text"): Promise<CanonicalChatMessagePart[]> {
  const parts: CanonicalChatMessagePart[] = [];
  for (const block of blocks) {
    if (block.kind === "text") {
      const text = preview(block.text);
      if (text.trim()) parts.push({ type: "text", text });
      if (text !== block.text || !text.trim()) parts.push(await reference(encoder.encode(block.text), textKind, "text/plain", writer));
    } else if (block.kind === "media" && block.encoding === "base64") {
      // Reject permissive base64 decoding; malformed original bytes remain in the private archive.
      const clean = block.data.replace(/[\r\n\t ]/g, "");
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(clean)) throw new Error("Invalid embedded import content");
      const bytes = Buffer.from(clean, "base64");
      const mime = mediaMime(bytes, block.mediaType);
      parts.push(await reference(bytes, mime.startsWith("image/") ? "image" : "file", mime, writer));
    } else if (block.kind === "media") {
      parts.push({ type: "status", tone: "warning", label: "External attachment was not included", detail: "The original reference is retained in the private archive." });
    } else {
      parts.push({ type: "status", tone: "info", label: "Additional content is in the private archive" });
    }
  }
  return parts;
}
/** No instructions, encrypted material, thinking, or inherited context become shared Chat prose. */
export async function projectImportedChatRecord(event: ImportProjection, writer: ImportAssetWriter): Promise<ImportedCanonicalRecord[]> {
  if (!["message", "tool_call", "tool_result", "notice", "issue", "compaction", "inter_agent"].includes(event.kind)) return [];
  if (!event.conversation.sessionId) throw new Error("Import source identity is required");
  const identity = [event.conversation.harness, event.conversation.sessionId, event.conversation.agentId ?? ""];
  const logicalId = event.kind === "message" ? event.messageKey : event.kind === "tool_call" || event.kind === "tool_result" ? event.callId : `${event.kind}:${event.source.offset}`;
  const logicalKey = digest(JSON.stringify([...identity, logicalId]));
  const callId = `import_${logicalKey}`;
  let role: ImportedCanonicalRecord["role"] = "system";
  let origin: "human" | "assistant" | "agent_task" | "tool" | "system" = "system";
  let phase: "unknown" | "human" | "commentary" | "final" | "tool" | "notice" | "agent_task" = "notice";
  let parts: CanonicalChatMessagePart[] = [];
  if (event.kind === "message") {
    origin = event.origin; role = origin === "human" ? "user" : "assistant";
    phase = origin === "human" ? "human" : origin === "agent_task" ? "agent_task" : event.phase;
    parts = await blocksToParts(event.blocks, writer);
  } else if (event.kind === "tool_call") {
    role = "tool"; origin = "tool"; phase = "tool";
    const name = safeToolName(event.name);
    parts = [{ type: "tool_request", toolCallId: callId, name, label: name },
      await reference(encoder.encode(typeof event.input === "string" ? event.input : JSON.stringify(event.input) ?? "null"), "tool_input", "text/plain", writer)];
  } else if (event.kind === "tool_result") {
    role = "tool"; origin = "tool"; phase = "tool";
    const resultText = event.blocks.filter((block): block is Extract<ImportBlock, { kind: "text" }> => block.kind === "text").map(block => block.text).join("\n\n");
    if (event.outcome !== "incomplete") parts.push({ type: "tool_result", toolCallId: callId, outcome: event.outcome,
      ...(resultText.trim() ? { text: event.outcome === "failed" ? "Imported tool reported a failure." : preview(resultText) } : {}),
      truncated: resultText.length > 8_000 || event.outcome === "failed" });
    else parts.push({ type: "status", tone: "warning", label: "Imported tool output is incomplete" });
    if (resultText.length > 8_000 || event.outcome === "failed" || event.outcome === "incomplete") {
      if (resultText) parts.push(await reference(encoder.encode(resultText), "tool_output", "text/plain", writer));
    }
    parts.push(...await blocksToParts(event.blocks.filter(block => block.kind !== "text"), writer, "tool_output"));
  } else if (event.kind === "notice") parts = [{ type: "status", tone: "warning", label: event.outcome === "interrupted" ? "Imported conversation was interrupted" : "Imported conversation reported a failure" }];
  else if (event.kind === "compaction") parts = [{ type: "status", tone: "info", label: "Saved conversation context was compacted", detail: "Retained context is in the private archive; it is not a new human message." }];
  else if (event.kind === "inter_agent") parts = [{ type: "status", tone: "info", label: "An agent exchange is retained in the private archive" }];
  else if (event.kind === "issue") parts = [{ type: "status", tone: "warning", label: "A source record could not be displayed", detail: "Its original bytes and location are retained in the private archive." }];
  if (!parts.length) return [];
  const provenance = CanonicalChatMessagePartSchema.parse({ type: "import_provenance", harness: event.conversation.harness,
    sourceId: event.conversation.sessionId, sourceKey: logicalKey, phase, origin, offset: event.source.offset, end: event.source.end });
  const rows: ImportedCanonicalRecord[] = [];
  let chunk: CanonicalChatMessagePart[] = [];
  let size = 0;
  let textCharacters = 0;
  const flush = () => {
    if (!chunk.length) return;
    rows.push({ recordKey: digest(JSON.stringify([...identity, event.source.offset, event.source.blockIndex ?? 0, rows.length, event.kind])), logicalKey,
      mode: event.kind === "message" && event.mode === "replace_mirror" ? "replace_mirror" : "append", role,
      ...(event.source.timestamp && Number.isFinite(Date.parse(event.source.timestamp)) ? { createdAt: new Date(event.source.timestamp).toISOString() } : {}), parts: [...chunk, provenance] });
    chunk = []; size = 0; textCharacters = 0;
  };
  for (const part of parts) {
    const parsed = CanonicalChatMessagePartSchema.parse(part);
    const bytes = encoder.encode(JSON.stringify(parsed)).byteLength;
    const characters = parsed.type === "text" ? parsed.text.length : 0;
    if (chunk.length >= 60 || size + bytes > 48 * 1024 || (role === "user" && textCharacters + characters > 24_000)) flush();
    chunk.push(parsed); size += bytes; textCharacters += characters;
  }
  flush(); return rows;
}
