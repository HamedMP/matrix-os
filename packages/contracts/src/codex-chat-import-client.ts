import type { CodexImportMessage } from "./codex-chat-import.js";

const MAX_BATCH_BYTES = 400 * 1024;
const encoder = new TextEncoder();

export interface CodexChatImportPayload {
  sourceId: string;
  sourceHash: string;
  title: string;
  messages: readonly CodexImportMessage[];
}

export type CodexChatImportRequest = (path: string, body?: unknown) => Promise<unknown>;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Matrix returned an invalid Chat import response.");
  }
  return value as Record<string, unknown>;
}

function chatId(value: unknown): string {
  if (typeof value !== "string" || !/^chat_[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error("Matrix returned an invalid Chat import result.");
  }
  return value;
}

function batchFrom(messages: readonly CodexImportMessage[], start: number): CodexImportMessage[] {
  const batch: CodexImportMessage[] = [];
  for (let index = start; index < messages.length && batch.length < 50; index += 1) {
    const next = [...batch, messages[index]!];
    if (batch.length > 0 && encoder.encode(JSON.stringify({ startSeq: start + 1, messages: next })).byteLength > MAX_BATCH_BYTES) break;
    batch.push(messages[index]!);
  }
  return batch;
}

/** Shared by CLI and Settings; transport supplies the caller's existing authentication. */
export async function submitCodexChatImport(
  preview: CodexChatImportPayload,
  request: CodexChatImportRequest,
  onProgress?: (sent: number, total: number) => void,
): Promise<{ chatId: string; messageCount: number }> {
  const begin = object(await request("/api/chats/imports/codex", {
    sourceId: preview.sourceId, sourceHash: preview.sourceHash, title: preview.title,
  }));
  let importedChatId: string;
  if (begin.status === "verified") {
    importedChatId = chatId(begin.chatId);
  } else {
    if (begin.status !== "uploading" || typeof begin.nextSeq !== "number"
      || !Number.isInteger(begin.nextSeq) || begin.nextSeq < 1 || begin.nextSeq > preview.messages.length + 1) {
      throw new Error("Matrix returned an invalid Chat import offset.");
    }
    let offset = begin.nextSeq - 1;
    onProgress?.(offset, preview.messages.length);
    while (offset < preview.messages.length) {
      const messages = batchFrom(preview.messages, offset);
      const result = object(await request(`/api/chats/imports/codex/${preview.sourceId}/messages`, {
        startSeq: offset + 1, messages,
      }));
      if (result.nextSeq !== offset + messages.length + 1) {
        throw new Error("Matrix returned an invalid Chat import offset.");
      }
      offset += messages.length;
      onProgress?.(offset, preview.messages.length);
    }
    const complete = object(await request(`/api/chats/imports/codex/${preview.sourceId}/complete`, {
      messageCount: preview.messages.length,
    }));
    importedChatId = chatId(complete.chatId);
    if (complete.messageCount !== preview.messages.length) {
      throw new Error("Matrix returned an incomplete Chat import.");
    }
  }
  const detail = object(await request(`/api/chats/${importedChatId}?limit=1`));
  const record = detail.record;
  if (!record || typeof record !== "object" || !("chat" in record)
    || typeof record.chat !== "object" || record.chat === null
    || !("messageCount" in record.chat) || record.chat.messageCount !== preview.messages.length) {
    throw new Error("The imported Chat could not be verified.");
  }
  return { chatId: importedChatId, messageCount: preview.messages.length };
}
