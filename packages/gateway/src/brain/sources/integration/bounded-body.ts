/**
 * Reads a fetch response body as JSON with a byte cap. Used by the integration caller and the GitHub REST client.
 * The body is cancelled on every early exit so the connection is released.
 */

export type BoundedJsonResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: "too_large" | "invalid" };

function cancelBody(body: ReadableStream<Uint8Array> | ReadableStreamDefaultReader<Uint8Array>): void {
  void body.cancel().catch((error: unknown) => {
    console.warn("[brain-sources] response body cancel failed:", error instanceof Error ? error.name : "UnknownError");
  });
}

/** Releases a response whose body will not be read. */
export function discardBody(response: Response): void {
  if (response.body !== null) cancelBody(response.body);
}

/** Rejects only when the signal aborts while reading; every other failure is a value. */
export async function readBoundedJson(response: Response, maxBytes: number, signal: AbortSignal): Promise<BoundedJsonResult> {
  const length = response.headers.get("content-length");
  if (response.body === null) return { ok: false, reason: "invalid" };
  if (length !== null && (!/^\d{1,12}$/.test(length) || Number(length) > maxBytes)) {
    cancelBody(response.body);
    return { ok: false, reason: "too_large" };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) {
        cancelBody(reader);
        return { ok: false, reason: "too_large" };
      }
      chunks.push(next.value);
    }
  } catch (error: unknown) {
    cancelBody(reader);
    throw error;
  } finally {
    reader.releaseLock();
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size))) };
  } catch (error: unknown) {
    if (error instanceof SyntaxError || error instanceof TypeError) return { ok: false, reason: "invalid" };
    throw error;
  }
}

/** One top-level field of a small JSON object body (at most 4 KiB), else undefined. Rejects only on abort. */
export async function readJsonField(response: Response, field: string, signal: AbortSignal): Promise<unknown> {
  const body = await readBoundedJson(response, 4_096, signal);
  const value = body.ok ? body.value : null;
  return typeof value === "object" && value !== null && Object.hasOwn(value, field)
    ? (value as Record<string, unknown>)[field] : undefined;
}
