import { z } from "zod/v4";
const PART_SIZE = 64 * 1024 * 1024;
const MAX_RAW = 20 * 1024 ** 3;
const Input = z.object({ harness: z.enum(["codex", "claude"]), sourceId: z.uuid(), sourceAgentId: z.string().min(1).max(512).regex(/^[^\u0000-\u001f\u007f]+$/).optional(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/), rawSize: z.number().int().min(1).max(MAX_RAW), title: z.string().trim().min(1).max(160).regex(/^[^\u0000-\u001f\u007f]+$/) }).strict();
const Receipt = z.object({ partNumber: z.number().int().min(1).max(320), etag: z.string().min(1).max(512).regex(/^[^\u0000-\u001f\u007f]+$/), size: z.number().int().min(1).max(PART_SIZE) });
const Job = z.object({ jobId: z.uuid(), status: z.enum(["creating", "uploading", "sealing", "uploaded", "verifying", "published", "failed", "cancelled", "expired"]),
  partSize: z.literal(PART_SIZE), totalParts: z.number().int().min(1).max(320), expiresAt: z.iso.datetime(), cleanupPending: z.boolean(),
  parts: z.array(Receipt).max(320), chatId: z.string().regex(/^chat_[A-Za-z0-9_-]{1,128}$/).optional() });
const Signed = z.object({ parts: z.array(z.object({ partNumber: Receipt.shape.partNumber, size: Receipt.shape.size, url: z.string().max(8192), expiresAt: z.iso.datetime() })).length(1) });
export type LocalChatImportPayload = z.infer<typeof Input>;
export type LocalChatImportRequest = (path: string, options: { method: "GET" | "POST"; body?: unknown; signal: AbortSignal; timeoutMs?: number }) => Promise<unknown>;
export interface LocalChatUploadSource {
  read(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array>;
  createHash(): { update(bytes: Uint8Array): void; digest(): string | Promise<string> };
}
export interface LocalChatImportProgress { phase: "uploading" | "verifying"; uploadedBytes: number; totalBytes: number; jobId: string }
export class LocalChatTransferError extends Error {
  code: "invalid" | "invalid_response" | "source_changed" | "cancelled" | "unavailable" | "failed" | "expired";
  constructor(code: "invalid" | "invalid_response" | "source_changed" | "cancelled" | "unavailable" | "failed" | "expired") {
    super("Chat import unavailable"); this.name = "LocalChatTransferError"; this.code = code;
  }
}
function checked<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value); if (!result.success) throw new LocalChatTransferError("invalid_response"); return result.data;
}
function aborted(signal: AbortSignal) { if (signal.aborted) throw new LocalChatTransferError("cancelled"); }
async function pause(signal: AbortSignal, ms: number): Promise<void> {
  aborted(signal);
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(new LocalChatTransferError("cancelled")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
/** Original-byte protocol shared by the CLI and all supported local-file shells. */
export async function uploadLocalChatArchive(payload: LocalChatImportPayload, source: LocalChatUploadSource,
  transport: { request: LocalChatImportRequest; put(url: string, bytes: Uint8Array, signal: AbortSignal): Promise<string> },
  options: { signal?: AbortSignal; onProgress?(progress: LocalChatImportProgress): void } = {},
): Promise<{ jobId: string; chatId: string; messageCount: number }> {
  if (!Input.safeParse(payload).success) throw new LocalChatTransferError("invalid");
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(60 * 60_000)]) : AbortSignal.timeout(60 * 60_000);
  let expectedJobId: string | undefined;
  const request = async (path: string, body?: unknown) => {
    const timeoutMs=path.endsWith("/complete")?5*60_000:30_000;
    aborted(signal); return transport.request(path, { method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { body }), timeoutMs, signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) });
  };
  const state = (value: unknown) => {
    const job = checked(Job, value);
    if (expectedJobId && job.jobId !== expectedJobId) throw new LocalChatTransferError("invalid_response");
    if (job.totalParts !== Math.ceil(payload.rawSize / PART_SIZE) || new Set(job.parts.map(part => part.partNumber)).size !== job.parts.length
      || job.parts.some(part => part.partNumber > job.totalParts || part.size !== Math.min(PART_SIZE, payload.rawSize - (part.partNumber - 1) * PART_SIZE))) throw new LocalChatTransferError("invalid_response");
    if (["failed", "cancelled"].includes(job.status)) throw new LocalChatTransferError("failed");
    if (job.status === "expired") throw new LocalChatTransferError("expired"); return job;
  };
  let job = state(await request("/api/chats/imports/local", payload));
  expectedJobId = job.jobId;
  const base = `/api/chats/imports/local/${job.jobId}`;
  while (job.status === "creating") { await pause(signal, 1000); job = state(await request(base)); }
  if (job.status === "uploading") {
    const hash = source.createHash(); let uploadedBytes = 0;
    // At most 320 durable receipts, only one 64 MiB part in memory. Retry reads use the captured byte boundary.
    for (let partNumber = 1; partNumber <= job.totalParts; partNumber++) {
      aborted(signal); const length = Math.min(PART_SIZE, payload.rawSize - (partNumber - 1) * PART_SIZE);
      const bytes = await source.read((partNumber - 1) * PART_SIZE, length, signal);
      if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) throw new LocalChatTransferError("source_changed");
      hash.update(bytes);
      if (!job.parts.some(part => part.partNumber === partNumber)) {
        let completed = false;
        for (let attempt = 0; attempt < 3 && !completed; attempt++) {
          aborted(signal);
          const signed = checked(Signed, await request(`${base}/parts`, { partNumbers: [partNumber] })).parts[0]!;
          let url: URL;
          try { url = new URL(signed.url); } catch (error: unknown) { if (!(error instanceof TypeError)) throw error; throw new LocalChatTransferError("invalid_response"); }
          if (signed.partNumber !== partNumber || signed.size !== length || url.protocol !== "https:" || url.username || url.password || url.hash)
            throw new LocalChatTransferError("invalid_response");
          let etag: string;
          try { etag = await transport.put(signed.url, bytes, AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)])); }
          catch (error: unknown) {
            aborted(signal); if (attempt === 2 || (error instanceof LocalChatTransferError && error.code !== "unavailable")) throw error;
            await pause(signal, 250 * (attempt + 1)); continue;
          }
          checked(Receipt, { partNumber, size: length, etag });
          // A lost acknowledgment leaves the part retryable on the next invocation with its current receipt.
          job = state(await request(`${base}/parts/ack`, { partNumber, etag, size: length })); completed = true;
        }
      }
      uploadedBytes += length;
      options.onProgress?.({ phase: "uploading", uploadedBytes, totalBytes: payload.rawSize, jobId: job.jobId });
    }
    if (await hash.digest() !== payload.sourceHash) throw new LocalChatTransferError("source_changed");
    aborted(signal);
    try { job = state(await request(`${base}/complete`, {})); }
    catch(error:unknown){
      aborted(signal);
      if(!(error instanceof LocalChatTransferError&&error.code==="unavailable")&&!(error instanceof Error&&error.name==="TimeoutError"))throw error;
      // Completion is durable. A response lost after sealing is recovered by the exact selected job.
      job=state(await request(base));
      if(job.status==="uploading")throw new LocalChatTransferError("unavailable");
    }
  }
  while (job.status !== "published") {
    aborted(signal); options.onProgress?.({ phase: "verifying", uploadedBytes: payload.rawSize, totalBytes: payload.rawSize, jobId: job.jobId });
    await pause(signal, 1000); job = state(await request(base));
    if (job.status === "uploading") throw new LocalChatTransferError("unavailable"); // Reseal recovery requires a fresh source verification.
  }
  if (!job.chatId) throw new LocalChatTransferError("invalid_response");
  const detail = checked(z.object({ record: z.object({ chat: z.object({ id: z.literal(job.chatId), messageCount: z.number().int().min(1).max(100_000) }) }) }), await request(`/api/chats/${job.chatId}?limit=1`));
  return { jobId: job.jobId, chatId: job.chatId, messageCount: detail.record.chat.messageCount };
}
