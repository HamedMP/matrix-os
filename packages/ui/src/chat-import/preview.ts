import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { decodeCodexJsonl, parseCodexTranscript, type CodexImportMessage } from "@matrix-os/contracts/codex-chat-import";

const MAX_RAW_BYTES = 20 * 1024 ** 3;
const MAX_PROJECTED_BYTES = 100 * 1024 ** 2;
const MAX_MESSAGES = 10_000;

export interface BrowserCodexImportPreview {
  sourceId: string;
  sourceHash: string;
  cwd: string;
  repositoryUrl?: string;
  title: string;
  messages: CodexImportMessage[];
  rawBytes: number;
  projectedBytes: number;
}

export async function previewCodexBrowserFile(file: Blob): Promise<BrowserCodexImportPreview> {
  if (file.size < 1 || file.size > MAX_RAW_BYTES) {
    throw new Error("Select a Codex JSONL file smaller than 20 GiB.");
  }
  const digest = sha256.create();
  const reader = file.stream().getReader();
  async function* chunks(): AsyncGenerator<Uint8Array> {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        digest.update(chunk.value);
        yield chunk.value;
      }
    } finally {
      reader.releaseLock();
    }
  }
  const projected = await parseCodexTranscript(decodeCodexJsonl(chunks()));
  if (projected.messages.length < 1 || projected.messages.length > MAX_MESSAGES) {
    throw new Error("Codex transcript has no supported messages or exceeds the import limit.");
  }
  const projectedBytes = projected.messages.reduce((total, message) =>
    total + new TextEncoder().encode(message.text).byteLength, 0);
  if (projectedBytes > MAX_PROJECTED_BYTES) throw new Error("Projected conversation exceeds the import limit.");
  const first = projected.messages.find((message) => message.role === "user")?.text
    ?? projected.messages[0]?.text ?? "Imported Codex chat";
  const title = first.split("\n")[0]!.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 160)
    || "Imported Codex chat";
  return { sourceId: projected.sourceId, sourceHash: bytesToHex(digest.digest()), cwd: projected.cwd,
    ...(projected.repositoryUrl ? { repositoryUrl: projected.repositoryUrl } : {}),
    title, messages: projected.messages, rawBytes: file.size, projectedBytes };
}
