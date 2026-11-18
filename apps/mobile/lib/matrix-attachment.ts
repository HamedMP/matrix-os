import { FileResourceRefSchema, MAX_AGENT_ATTACHMENT_BYTES } from "@matrix-os/contracts";
import { getRandomValues } from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import { fetch } from "expo/fetch";

import {
  attachmentIdFrom,
  attachmentKindForMimeType,
  attachmentName,
  MAX_PHOTO_BYTES,
  type ChatAttachmentKind,
  type ComposerAttachment,
  type MatrixAttachmentSource,
} from "@/lib/chat-attachments";
import { assertSecureTokenTransport } from "@/lib/gateway-client";
import { buildGatewayRequestUrl } from "@/lib/requests/http";

const CACHE_NAME = "chat-matrix-attachments";
const CACHE_LIMIT = 64;
const CACHE_MAX_AGE = 24 * 60 * 60 * 1000;
const SAFE_MIME_TYPE = /^[A-Za-z0-9][A-Za-z0-9.+/-]{1,119}$/;

function collectCache(directory: Directory) {
  const threshold = Date.now() - CACHE_MAX_AGE;
  const current = directory.list()
    .filter((entry): entry is File => entry instanceof File)
    .sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0));
  for (const [index, file] of current.entries()) {
    if (index >= CACHE_LIMIT - 1 || (file.lastModified ?? 0) < threshold) file.delete();
  }
}

export function discardMatrixAttachment(attachment: ComposerAttachment): void {
  if (!attachment.matrixSource) return;
  try {
    const file = new File(Paths.cache, CACHE_NAME, attachment.id);
    if (file.exists) file.delete();
  } catch (error: unknown) {
    console.warn("[chat] staged attachment cleanup failed", error instanceof Error ? error.name : "UnknownError");
  }
}

export async function stageMatrixAttachment(
  source: MatrixAttachmentSource,
  token: string,
  kinds: readonly ChatAttachmentKind[],
  signal: AbortSignal,
): Promise<ComposerAttachment> {
  const resource = FileResourceRefSchema.parse({ kind: "home", path: source.path });
  assertSecureTokenTransport(source.gatewayUrl);
  const request = new AbortController();
  const abort = () => request.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timeout = setTimeout(abort, 30_000);
  let staged: ComposerAttachment | undefined;
  try {
    if (resource.kind !== "home") throw new Error("MatrixAttachmentUnavailable");
    const url = buildGatewayRequestUrl(source.gatewayUrl, "/api/file-previews/content", {
      kind: resource.kind, path: resource.path, download: "true",
    });
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: request.signal,
    });
    if (!response.ok || !response.body) throw new Error("MatrixAttachmentUnavailable");
    const candidate = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const mimeType = SAFE_MIME_TYPE.test(candidate) ? candidate : "application/octet-stream";
    const kind = attachmentKindForMimeType(mimeType);
    const maximum = kind === "image" ? MAX_PHOTO_BYTES : MAX_AGENT_ATTACHMENT_BYTES;
    if (!kinds.includes(kind)) {
      await response.body.cancel();
      throw new Error("MatrixAttachmentUnsupported");
    }
    if (Number(response.headers.get("content-length")) > maximum) {
      await response.body.cancel();
      throw new Error("MatrixAttachmentTooLarge");
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let sizeBytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        sizeBytes += value.byteLength;
        if (sizeBytes > maximum) {
          await reader.cancel();
          throw new Error("MatrixAttachmentTooLarge");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    if (request.signal.aborted) throw new Error("MatrixAttachmentUnavailable");

    const bytes = new Uint8Array(sizeBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const directory = new Directory(Paths.cache, CACHE_NAME);
    directory.create({ idempotent: true });
    collectCache(directory);
    const id = attachmentIdFrom(getRandomValues(new Uint8Array(16)));
    const file = new File(directory, id);
    const name = attachmentName(source.path.split("/").at(-1)!, mimeType);
    file.create({ overwrite: false });
    staged = { id, uri: file.uri, name, mimeType, kind, sizeBytes, matrixSource: source };
    file.write(bytes);
    return staged;
  } catch (error: unknown) {
    if (staged) discardMatrixAttachment(staged);
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    clearTimeout(timeout);
  }
}
