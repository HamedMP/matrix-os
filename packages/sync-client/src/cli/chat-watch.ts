import { setTimeout as delay } from "node:timers/promises";
import { CanonicalChatTransportFrameSchema, type CanonicalChatTransportFrame } from "@matrix-os/contracts";
import { chatError, validateChatId, type ChatClient } from "./chat-client.js";

const MAX_FRAME_CHARS = 512 * 1024;
const HEALTHY_CONNECTION_MS = 30_000;
const MAX_SEEN_CURSORS = 10_000;
export async function watchChat(client: ChatClient, id: string, input: {
  signal: AbortSignal;
  cursor?: number;
  onFrame(frame: CanonicalChatTransportFrame | { type: "chat.snapshot"; detail: Awaited<ReturnType<ChatClient["read"]>>; reason: "replay_gap" }): void | Promise<void>;
  retryDelayMs?: number;
}): Promise<void> {
  validateChatId(id);
  if (input.cursor !== undefined && (!Number.isSafeInteger(input.cursor) || input.cursor < 0)) throw chatError("chat_invalid_input");
  try { await client.read(id, { limit: 1, signal: input.signal }); }
  catch (error: unknown) {
    if (input.signal.aborted) return;
    throw error instanceof Error ? error : chatError("chat_unavailable");
  }
  let cursor = input.cursor; let failures = 0;
  const seen = new Set<number>(); // FIFO eviction bounds deduplication across reconnects.
  async function emit(frame: Parameters<typeof input.onFrame>[0]) {
    try { await input.onFrame(frame); }
    catch (error: unknown) { if (!(error instanceof Error)) console.warn("[chat-cli] output failed", "UnknownError"); throw chatError("chat_output_failed"); }
  }
  while (!input.signal.aborted) {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let connectedAt: number | undefined;
    let progress = false;
    try {
      const response = await client.openEvents({ cursor, signal: input.signal });
      connectedAt = Date.now();
      reader = response.body!.getReader();
      let buffer = ""; const decoder = new TextDecoder("utf-8", { fatal: true });
      while (!input.signal.aborted) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer = (buffer + decoder.decode(chunk.value, { stream: true })).replace(/\r\n/g, "\n");
        // Split each chunk before bounding its remainder: a chunk may contain many frames.
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          if (block.length > MAX_FRAME_CHARS) throw chatError("chat_limit");
          const data = block.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
          if (!data) continue;
          let frame: CanonicalChatTransportFrame;
          try { frame = CanonicalChatTransportFrameSchema.parse(JSON.parse(data)); }
          catch (error: unknown) { if (!(error instanceof Error)) console.warn("[chat-cli] invalid frame", "UnknownError"); throw chatError("chat_invalid_response"); }
          if (frame.type === "chat.event" || frame.type === "chat.content") {
            cursor = Math.max(cursor ?? 0, frame.event.cursor); progress = true;
            if (frame.event.chatId === id && !seen.has(frame.event.cursor)) {
              seen.add(frame.event.cursor);
              if (seen.size > MAX_SEEN_CURSORS) seen.delete(seen.values().next().value!);
              await emit(frame);
            }
          } else if (frame.type === "chat.replay.end") {
            if (frame.nextCursor !== undefined) cursor = Math.max(cursor ?? 0, frame.nextCursor);
          } else if (frame.type === "chat.replay.gap") {
            cursor = undefined;
            await emit({ type: "chat.snapshot", reason: "replay_gap", detail: await client.read(id, { signal: input.signal }) });
          } else if (frame.type === "chat.stream.error") throw chatError("chat_unavailable");
          if (input.signal.aborted) break;
        }
        if (buffer.length > MAX_FRAME_CHARS) throw chatError("chat_limit");
      }
      if (progress) failures = 0;
      else failures++;
    } catch (error: unknown) {
      if (input.signal.aborted) return;
      const code = error instanceof Error && "code" in error ? String(error.code) : "chat_unavailable";
      if (["chat_auth_required", "chat_not_found", "chat_invalid_input", "chat_invalid_response", "chat_limit", "chat_output_failed"].includes(code)) throw chatError(code);
      failures++;
    } finally {
      try { await reader?.cancel(); } catch (error: unknown) {
        if (!input.signal.aborted) console.warn("[chat-cli] stream cleanup failed", error instanceof Error ? error.name : "UnknownError");
      }
      reader?.releaseLock();
    }
    if (input.signal.aborted) return;
    // Quiet streams also expire at the request timeout; they are not repeated connection failures.
    if (progress || (connectedAt !== undefined && Date.now() - connectedAt >= HEALTHY_CONNECTION_MS)) failures = 0;
    if (failures >= 5) throw chatError("chat_watch_disconnected");
    try { await delay(Math.min(5000, (input.retryDelayMs ?? 500) * 2 ** Math.max(0, failures - 1)), undefined, { signal: input.signal }); }
    catch (error: unknown) { if (input.signal.aborted) return; throw chatError("chat_unavailable"); }
  }
}
