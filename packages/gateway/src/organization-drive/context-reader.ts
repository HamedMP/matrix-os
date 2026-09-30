import { createHash } from "node:crypto";
import { setImmediate as yieldRead } from "node:timers/promises";
import { OrganizationDriveError } from "./errors.js";
export const MAX_DRIVE_CONTEXT_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_DRIVE_CONTEXT_TEXT_BYTES = 32 * 1024;
/** Verify complete immutable bytes before exposing a bounded UTF-8 excerpt. No archive or binary decoding. */
export async function readVerifiedDriveText(input: {body: unknown; size: number; sha256: string; signal: AbortSignal}): Promise<{text: string; truncated: boolean}> {
  if (!Number.isSafeInteger(input.size) || input.size < 0 || input.size > MAX_DRIVE_CONTEXT_FILE_BYTES) throw new OrganizationDriveError("unsupported");
  const prefix = new Uint8Array(Math.min(input.size, MAX_DRIVE_CONTEXT_TEXT_BYTES));
  const hash = createHash("sha256");
  const decoder = new TextDecoder("utf-8", {fatal: true});
  let size = 0; let chunks = 0; let unsupported = false;
  for await (const chunk of bodyChunks(input.body, input.signal)) {
    input.signal.throwIfAborted();
    if (++chunks % 256 === 0) {await yieldRead(); input.signal.throwIfAborted();}
    if (size + chunk.byteLength > input.size) throw new OrganizationDriveError("checksum");
    const take = Math.max(0, Math.min(chunk.byteLength, prefix.byteLength - size));
    if (take) prefix.set(chunk.subarray(0,take), size);
    hash.update(chunk); size += chunk.byteLength;
    if (!unsupported) {
      try {if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(decoder.decode(chunk, {stream: true}))) unsupported = true;}
      catch (error: unknown) {if (error instanceof TypeError) unsupported = true; else throw error;}
    }
  }
  input.signal.throwIfAborted();
  if (size !== input.size || hash.digest("hex") !== input.sha256) throw new OrganizationDriveError("checksum");
  if (!unsupported) try {decoder.decode();}
  catch (error: unknown) {if (error instanceof TypeError) unsupported = true; else throw error;}
  if (unsupported) throw new OrganizationDriveError("unsupported");
  // stream:true intentionally withholds a partial character at the truncated boundary.
  const text = new TextDecoder("utf-8", {fatal: true}).decode(prefix, {stream: size > prefix.byteLength});
  return {text, truncated: size > prefix.byteLength};
}
async function* bodyChunks(body: unknown, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  if (!body || typeof body !== "object") throw new OrganizationDriveError("unavailable");
  const source = body as {getReader?: () => ReadableStreamDefaultReader<unknown>; destroy?: (error?: Error) => void; [Symbol.asyncIterator]?: () => AsyncIterator<unknown>};
  if (typeof source.getReader === "function") {
    const reader = source.getReader();
    const abort = () => {void reader.cancel().catch((error: unknown) => console.warn("[organization-drive] context read cancel failed", error instanceof Error ? error.name : "UnknownError"));};
    signal.addEventListener("abort", abort, {once: true});
    try {
      if (signal.aborted) {abort(); signal.throwIfAborted();}
      while (true) {
        const result = await reader.read(); signal.throwIfAborted();
        if (result.done) return;
        if (!(result.value instanceof Uint8Array)) throw new OrganizationDriveError("unavailable");
        yield result.value;
      }
    } finally {signal.removeEventListener("abort", abort); void reader.cancel().catch((error: unknown) => console.warn("[organization-drive] context read cleanup failed", error instanceof Error ? error.name : "UnknownError")); reader.releaseLock();}
  }
  if (typeof source[Symbol.asyncIterator] === "function" && typeof source.destroy === "function") {
    const abort = () => source.destroy?.(new Error("Drive context read cancelled"));
    signal.addEventListener("abort", abort, {once: true});
    try {
      if (signal.aborted) {abort(); signal.throwIfAborted();}
      for await (const chunk of source as AsyncIterable<unknown>) {signal.throwIfAborted(); if (!(chunk instanceof Uint8Array)) throw new OrganizationDriveError("unavailable"); yield chunk;}
    } finally {signal.removeEventListener("abort", abort); source.destroy();}
    return;
  }
  throw new OrganizationDriveError("unavailable");
}

/** Start cancellation without letting an unresponsive remote body hold the request open. */
export function cancelDriveObjectBody(body: unknown): void {
  if (!body || typeof body !== "object") return;
  const source = body as {cancel?: () => Promise<void>; destroy?: () => void};
  if (typeof source.destroy === "function") source.destroy();
  else if (typeof source.cancel === "function") void source.cancel().catch((error: unknown) => console.warn("[organization-drive] context body cleanup failed", error instanceof Error ? error.name : "UnknownError"));
}
