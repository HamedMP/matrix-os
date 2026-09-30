/** Verifies the immutable private original; projected records remain unpublished staging. */
import { createHash } from "node:crypto";
import { readLocalChatJsonl, reconstructLocalChat, type ImportHarness, type ImportProjection } from "@matrix-os/contracts/local-chat-import";
import { z } from "zod/v4";
const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024 * 1024;
const ARCHIVE_DEADLINE_MS = 60 * 60_000;
const READ_IDLE_MS = 30_000;
const InputSchema = z.object({ expectedSize: z.number().int().min(1).max(MAX_ARCHIVE_BYTES),
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/), sourceId: z.uuid(), sourceAgentId: z.string().min(1).max(512).optional(), harness: z.enum(["codex", "claude"]) });
export class ChatArchiveVerificationError extends Error {
  constructor(readonly code: "invalid" | "unavailable" | "cancelled" | "size_mismatch" | "checksum_mismatch" | "source_mismatch") {
    super("Chat archive verification failed"); this.name = "ChatArchiveVerificationError";
  }
}
/** getUrl must derive from a server-owned job key via the trusted R2 broker, never request/source URLs. */
export async function verifyLocalChatArchive(options: {
  getUrl(): Promise<string>;
  expectedSize: number; expectedSha256: string; sourceId: string; sourceAgentId?: string; harness: ImportHarness;
  stage(event: ImportProjection): Promise<void>;
  signal?: AbortSignal; fetchImpl?: typeof fetch;
}): Promise<{ rawSize: number; sha256: string; issues: number; unknownRecords: number; parserVersion: 1 }> {
  if (!InputSchema.safeParse(options).success) throw new ChatArchiveVerificationError("invalid");
  if (options.signal?.aborted) throw new ChatArchiveVerificationError("cancelled");
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(ARCHIVE_DEADLINE_MS), ...(options.signal ? [options.signal] : [])]);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const url = new URL(await options.getUrl());
    if (url.protocol !== "https:" || url.username || url.password || signal.aborted) {
      throw new ChatArchiveVerificationError(signal.aborted ? "cancelled" : "unavailable");
    }
    // Trusted broker-generated object URL; no user URL or redirect can change the destination.
    const response = await (options.fetchImpl ?? fetch)(url, { signal, redirect: "error" });
    if (!response.ok || !response.body) throw new ChatArchiveVerificationError("unavailable");
    reader = response.body.getReader();
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) !== options.expectedSize)) {
      throw new ChatArchiveVerificationError("size_mismatch");
    }
    const hash = createHash("sha256");
    let rawSize = 0;
    const activeReader = reader;
    async function* bytes(): AsyncGenerator<Uint8Array> {
      for (;;) {
        if (signal.aborted) throw new ChatArchiveVerificationError("cancelled");
        let idle: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_resolve, reject) => {
          idle = setTimeout(() => { controller.abort(); reject(new ChatArchiveVerificationError("unavailable")); }, READ_IDLE_MS);
          idle.unref();
        });
        let next: ReadableStreamReadResult<Uint8Array>;
        try { next = await Promise.race([activeReader.read(), timeout]); }
        finally { if (idle) clearTimeout(idle); }
        if (next.done) break;
        if (!(next.value instanceof Uint8Array)) throw new ChatArchiveVerificationError("unavailable");
        rawSize += next.value.length;
        if (rawSize > options.expectedSize) throw new ChatArchiveVerificationError("size_mismatch");
        hash.update(next.value);
        yield next.value;
      }
    }
    let sourceSeen = false;
    let agentSeen = false;
    let issues = 0;
    let unknownRecords = 0;
    const records = readLocalChatJsonl(bytes(), { finalLine: "complete" });
    for await (const event of reconstructLocalChat(options.harness, records)) {
      if (signal.aborted) throw new ChatArchiveVerificationError("cancelled");
      const session = event.conversation.sessionId;
      if (session && session !== options.sourceId) throw new ChatArchiveVerificationError("source_mismatch");
      if (session === options.sourceId) sourceSeen = true;
      const agent = event.conversation.agentId;
      if (agent && agent !== options.sourceAgentId) throw new ChatArchiveVerificationError("source_mismatch");
      if (agent === options.sourceAgentId) agentSeen = true;
      if (event.kind === "issue") issues += 1;
      if (event.kind === "unknown") unknownRecords += 1;
      await options.stage(event);
    }
    if (rawSize !== options.expectedSize) throw new ChatArchiveVerificationError("size_mismatch");
    const sha256 = hash.digest("hex");
    if (sha256 !== options.expectedSha256) throw new ChatArchiveVerificationError("checksum_mismatch");
    if (!sourceSeen || (options.sourceAgentId && !agentSeen)) throw new ChatArchiveVerificationError("source_mismatch");
    return { rawSize, sha256, issues, unknownRecords, parserVersion: 1 };
  } catch (error: unknown) {
    if (error instanceof ChatArchiveVerificationError) throw error;
    if (options.signal?.aborted) throw new ChatArchiveVerificationError("cancelled");
    console.warn("[chat/archive] verification unavailable", error instanceof Error ? error.name : "UnknownError");
    throw new ChatArchiveVerificationError("unavailable");
  } finally {
    controller.abort();
    try { await reader?.cancel(); }
    catch (error: unknown) { console.warn("[chat/archive] stream cleanup failed", error instanceof Error ? error.name : "UnknownError"); }
    reader?.releaseLock();
  }
}
