import { randomUUID } from "node:crypto";
import { lstat, open, unlink } from "node:fs/promises";
import { z } from "zod/v4";
import {
  CanonicalChatIdSchema, CanonicalChatApiCursorSchema, CanonicalChatDetailResponseSchema,
  CanonicalChatTurnAdmissionResponseSchema, CanonicalCreateChatTurnRequestSchema,
  type CanonicalChatDetailResponse,
} from "@matrix-os/contracts";
import { runtimeApiUrl } from "../mcp/profile-context.js";

export const CHAT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const CHAT_MAX_EXPORT_BYTES = 64 * 1024 * 1024;
export const CHAT_MAX_EXPORT_MESSAGES = 10_000;
export const CHAT_WIRE_QUERY = { messageVersion: "2", inputVersion: "1", commandPreviewVersion: "1", readStateVersion: "1", fundingVersion: "1" };
export function chatError(code: string, requestId?: string) {
  return Object.assign(new Error(code), { code, ...(requestId ? { requestId } : {}) });
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw chatError("chat_invalid_input");
  return result.data;
}
export function validateChatId(id: string): string { return parse(CanonicalChatIdSchema, id); }

export async function readChatBytes(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw chatError("chat_invalid_response");
  const chunks: Uint8Array[] = []; // Bounded by CHAT_MAX_RESPONSE_BYTES.
  let size = 0;
  try {
    if (Number(response.headers.get("content-length")) > CHAT_MAX_RESPONSE_BYTES) throw chatError("chat_limit");
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > CHAT_MAX_RESPONSE_BYTES) throw chatError("chat_limit");
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    try { await reader.cancel(); } catch (error: unknown) { console.warn("[chat-cli] response cleanup failed", error instanceof Error ? error.name : "UnknownError"); }
    reader.releaseLock();
  }
}
export function chatStatusError(status: number) {
  return chatError(status === 401 || status === 403 ? "chat_auth_required" : status === 404 ? "chat_not_found"
    : status === 409 ? "chat_conflict" : status === 400 || status === 422 ? "chat_invalid_input" : "chat_unavailable");
}

export function createChatClient(options: { gatewayUrl: string; token: string; fetch?: typeof fetch }) {
  const fetcher = options.fetch ?? fetch;
  // Validate the destination before any credentials can leave the process.
  let base: string;
  try { base = runtimeApiUrl(options.gatewayUrl, "/api/chats"); }
  catch (error: unknown) { if (!(error instanceof Error)) console.warn("[chat-cli] invalid destination", "UnknownError"); throw chatError("chat_invalid_input"); }
  function url(path: string, query: Record<string, string | undefined> = {}) {
    const target = new URL(base);
    target.pathname += path;
    for (const [key, value] of Object.entries(query)) if (value !== undefined) target.searchParams.set(key, value);
    return target.toString();
  }
  async function request(path: string, init: RequestInit = {}, query: Record<string, string | undefined> = {}, signal?: AbortSignal) {
    let response: Response;
    try {
      response = await fetcher(url(path, query), { ...init, redirect: "error",
        headers: { Authorization: `Bearer ${options.token}`, "Content-Type": "application/json", "X-Matrix-Chat-Metadata": "1", ...init.headers },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) });
    } catch (error: unknown) {
      if (signal?.aborted) throw chatError("chat_cancelled");
      if (error instanceof DOMException && error.name === "TimeoutError") throw chatError("chat_timeout");
      throw chatError("chat_unavailable");
    }
    if (!response.ok) { await response.body?.cancel(); throw chatStatusError(response.status); }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readChatBytes(response))) as unknown; }
    catch (error: unknown) { if (error instanceof Error && "code" in error) throw error; throw chatError("chat_invalid_response"); }
  }
  async function read(id: string, input: { limit?: number; cursor?: string; signal?: AbortSignal } = {}): Promise<CanonicalChatDetailResponse> {
    validateChatId(id);
    const limit = parse(z.number().int().min(1).max(200), input.limit ?? 200);
    if (input.cursor !== undefined) parse(CanonicalChatApiCursorSchema, input.cursor);
    const data = CanonicalChatDetailResponseSchema.safeParse(await request(`/${id}`, {}, { ...CHAT_WIRE_QUERY, limit: String(limit), cursor: input.cursor }, input.signal));
    if (!data.success || data.data.record.chat.id !== id) throw chatError("chat_invalid_response");
    const messages = data.data.messages;
    if (messages.some((m, i) => i > 0 && m.seq !== messages[i - 1]!.seq + 1)) throw chatError("chat_invalid_response");
    return data.data;
  }
  async function send(id: string, text: string, input: { requestId?: string; permission?: string; interaction?: string; signal?: AbortSignal } = {}) {
    validateChatId(id);
    if (!text.trim() || text.length > 24_000 || Buffer.byteLength(text) > 96 * 1024) throw chatError("chat_invalid_input");
    const requestId = input.requestId ?? `req_${randomUUID()}`;
    const current = await read(id, { limit: 1, signal: input.signal });
    const selection = current.record.chat.currentSelection;
    if (!selection) throw chatError("chat_selection_required");
    const body = parse(CanonicalCreateChatTurnRequestSchema, { clientRequestId: requestId, baseRevision: current.record.chat.revision,
      parts: [{ type: "text", text }], selection, interactionMode: input.interaction ?? "default", permissionMode: input.permission ?? "supervised" });
    try {
      const result = CanonicalChatTurnAdmissionResponseSchema.safeParse(await request(`/${id}/turns`, { method: "POST", body: JSON.stringify(body) }, CHAT_WIRE_QUERY, input.signal));
      if (!result.success || result.data.record.chat.id !== id || result.data.turn.clientRequestId !== requestId) throw chatError("chat_invalid_response");
      return { requestId, ...result.data };
    } catch (error: unknown) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "chat_unavailable";
      if (["chat_auth_required", "chat_not_found", "chat_conflict", "chat_invalid_input"].includes(code)) throw Object.assign(chatError(code), { requestId });
      throw chatError("chat_send_uncertain", requestId);
    }
  }
  async function openEvents(input: { cursor?: number; signal: AbortSignal }) {
    const headers: Record<string, string> = { Authorization: `Bearer ${options.token}`, Accept: "text/event-stream", "X-Matrix-Chat-Protocol": "2", "X-Matrix-Chat-Metadata": "1" };
    if (input.cursor !== undefined) headers["Last-Event-ID"] = String(input.cursor);
    let response: Response;
    try { response = await fetcher(url("/events", { ...CHAT_WIRE_QUERY, eventVersion: "1" }), {
      headers, redirect: "error", signal: AbortSignal.any([input.signal, AbortSignal.timeout(5 * 60_000)]),
    }); } catch (error: unknown) { if (input.signal.aborted) throw chatError("chat_cancelled"); throw chatError("chat_unavailable"); }
    if (!response.ok) { await response.body?.cancel(); throw chatStatusError(response.status); }
    if (!response.headers.get("content-type")?.startsWith("text/event-stream") || !response.body) {
      await response.body?.cancel(); throw chatError("chat_invalid_response");
    }
    return response;
  }
  return { read, send, openEvents };
}
export type ChatClient = ReturnType<typeof createChatClient>;

export async function readAllChat(client: ChatClient, id: string, signal?: AbortSignal): Promise<CanonicalChatDetailResponse> {
  const first = await client.read(id, { signal });
  let page = first; let size = 0;
  const result = { ...first, messages: [...first.messages], turns: [...first.turns], runs: [...first.runs], activities: [...first.activities] };
  const cursors = new Set<string>(); // At most 10,000 pages; every page must add messages.
  for (;;) {
    size += Buffer.byteLength(JSON.stringify(page));
    if (result.messages.length > CHAT_MAX_EXPORT_MESSAGES || size > CHAT_MAX_EXPORT_BYTES) throw chatError("chat_limit");
    if (!page.nextCursor) break;
    if (cursors.has(page.nextCursor) || cursors.size >= CHAT_MAX_EXPORT_MESSAGES) throw chatError("chat_invalid_response");
    cursors.add(page.nextCursor);
    const older = await client.read(id, { cursor: page.nextCursor, signal });
    if (older.record.chat.revision !== first.record.chat.revision) throw chatError("chat_changed");
    if (!older.messages.length || older.messages.at(-1)!.seq !== result.messages[0]!.seq - 1) throw chatError("chat_invalid_response");
    result.messages.unshift(...older.messages);
    for (const key of ["turns", "runs", "activities"] as const) {
      const known = new Set(result[key].map(item => item.id)); // Bounded by export byte/message limits.
      // Keep the newest representation when related records overlap pages.
      (result[key] as { id: string }[]).unshift(...older[key].filter(item => !known.has(item.id)));
    }
    page = older;
  }
  if (result.messages.length !== first.record.chat.messageCount) throw chatError("chat_invalid_response");
  const { nextCursor: _, ...complete } = result;
  return complete;
}

export function renderChatMarkdown(detail: CanonicalChatDetailResponse): string {
  const safe = (text: string) => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  const lines = [`# ${safe(detail.record.chat.title)}`, "", `Chat ID: ${detail.record.chat.id}`, ""];
  for (const message of detail.messages) {
    lines.push(`## ${message.role} — ${message.createdAt}`, "");
    for (const part of message.parts) lines.push(safe(part.type === "text" ? part.text : JSON.stringify(part)), "");
  }
  return lines.join("\n");
}
export async function writeChatExport(path: string, content: string, signal?: AbortSignal): Promise<void> {
  if (Buffer.byteLength(content) > CHAT_MAX_EXPORT_BYTES) throw chatError("chat_limit");
  if (signal?.aborted) throw chatError("chat_cancelled");
  let file;
  try { file = await open(path, "wx", 0o600); }
  catch (error: unknown) { if (error instanceof Error && "code" in error && error.code === "EEXIST") throw chatError("chat_file_exists"); throw chatError("chat_export_failed"); }
  let owned: { ino: number; dev: number } | undefined;
  let failed = false;
  try {
    owned = await file.stat();
    if (signal?.aborted) throw chatError("chat_cancelled");
    await file.writeFile(content, { signal });
    if (signal?.aborted) throw chatError("chat_cancelled");
    await file.sync();
  }
  catch (error: unknown) {
    failed = true;
    if (!(error instanceof Error)) console.warn("[chat-cli] export failed", "UnknownError");
  } finally {
    try { await file.close(); }
    catch (error: unknown) {
      failed = true;
      console.warn("[chat-cli] export close failed", error instanceof Error ? error.name : "UnknownError");
    }
  }
  if (failed || signal?.aborted) {
    try { const current = owned ? await lstat(path) : undefined; if (owned && current?.isFile() && current.ino === owned.ino && current.dev === owned.dev) await unlink(path); }
    catch (cleanup: unknown) { console.warn("[chat-cli] incomplete export cleanup failed", cleanup instanceof Error ? cleanup.name : "UnknownError"); }
    throw chatError(signal?.aborted ? "chat_cancelled" : "chat_export_failed");
  }
}
