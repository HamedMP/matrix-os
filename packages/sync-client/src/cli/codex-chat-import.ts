import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { decodeCodexJsonl, parseCodexTranscript, type CodexImportMessage } from "@matrix-os/contracts/codex-chat-import";
import { submitCodexChatImport } from "@matrix-os/contracts/codex-chat-import-client";
import { expandLocalPath } from "./file-transfer-client.js";

const MAX_RAW_BYTES = 20 * 1024 ** 3;
const MAX_PROJECTED_BYTES = 100 * 1024 ** 2;
const MAX_MESSAGES = 10_000;

export interface CodexImportPreview {
  sourceId: string;
  sourceHash: string;
  cwd: string;
  repositoryUrl?: string;
  title: string;
  messages: CodexImportMessage[];
  rawBytes: number;
  projectedBytes: number;
}

function titleFromMessages(messages: readonly CodexImportMessage[]): string {
  const first = messages.find((message) => message.role === "user")?.text ?? messages[0]?.text ?? "Imported Codex chat";
  return first.split("\n")[0]!.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 160)
    || "Imported Codex chat";
}

export async function previewCodexFile(localPath: string): Promise<CodexImportPreview> {
  const path = expandLocalPath(localPath);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_RAW_BYTES) {
    throw new Error("Select a regular Codex JSONL file smaller than 20 GiB.");
  }
  const hash = createHash("sha256");
  async function* chunks(): AsyncGenerator<Uint8Array> {
    for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
      const bytes = chunk as Buffer;
      hash.update(bytes);
      yield bytes;
    }
  }
  const projected = await parseCodexTranscript(decodeCodexJsonl(chunks()));
  if (projected.messages.length < 1 || projected.messages.length > MAX_MESSAGES) {
    throw new Error("Codex transcript has no supported messages or exceeds the import limit.");
  }
  const projectedBytes = projected.messages.reduce((total, message) => total + Buffer.byteLength(message.text, "utf8"), 0);
  if (projectedBytes > MAX_PROJECTED_BYTES) throw new Error("Projected conversation exceeds the import limit.");
  return { sourceId: projected.sourceId, sourceHash: hash.digest("hex"), cwd: projected.cwd,
    ...(projected.repositoryUrl ? { repositoryUrl: projected.repositoryUrl } : {}),
    title: titleFromMessages(projected.messages), messages: projected.messages,
    rawBytes: info.size, projectedBytes };
}

export async function importCodexPreview(
  preview: CodexImportPreview,
  client: { gatewayUrl: string; token: string },
  fetchFn: typeof fetch = fetch,
): Promise<{ chatId: string; messageCount: number }> {
  return submitCodexChatImport(preview, async (path, body) => {
    const response = await fetchFn(new URL(path, client.gatewayUrl).toString(), {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${client.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(path.endsWith("/complete") ? 5 * 60_000 : 30_000),
    });
    if (!response.ok) throw new Error(`Matrix Chat import request failed (${response.status}).`);
    return response.json() as Promise<unknown>;
  });
}
