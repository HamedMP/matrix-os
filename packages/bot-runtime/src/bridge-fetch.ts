import { request as httpRequest } from "node:http";
import { Readable, Transform } from "node:stream";
import { MAX_BRIDGE_REQUEST_BYTES, MAX_BRIDGE_RESPONSE_BYTES } from "@matrix-os/scope-runtime/inference-bridge";

const MAX_WAIT_MS = 11 * 60_000;

/** SDK-compatible HTTP over the worker's private Unix socket; never opens TCP. */
export function createBotBridgeFetch(socketPath: string): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) {
      throw new TypeError("Bot inference transport requires its private bridge");
    }
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(MAX_WAIT_MS)]);
    signal.throwIfAborted();
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = request.body?.getReader();
    const cancelBody = () => { void reader?.cancel().catch((error: unknown) => {
      console.warn("[bot-runtime] request body cancellation failed:", error instanceof Error ? error.name : "UnknownError");
    }); };
    signal.addEventListener("abort", cancelBody, { once: true });
    try {
      while (reader) {
        signal.throwIfAborted();
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > MAX_BRIDGE_REQUEST_BYTES) throw new RangeError("Bot inference request exceeds capacity");
        chunks.push(next.value);
      }
    } finally {
      signal.removeEventListener("abort", cancelBody);
      await reader?.cancel();
      reader?.releaseLock();
    }
    signal.throwIfAborted();
    return new Promise<Response>((resolve, reject) => {
      const req = httpRequest({ socketPath, path: url.pathname + url.search, method: request.method,
        headers: Object.fromEntries(request.headers), signal }, (res) => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
        let received = 0;
        const bounded = new Transform({ transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length;
          callback(received > MAX_BRIDGE_RESPONSE_BYTES ? new RangeError("Bot inference response exceeds capacity") : null, chunk);
        } });
        res.once("error", (error) => bounded.destroy(error));
        bounded.once("close", () => res.destroy());
        const body = Readable.toWeb(res.pipe(bounded)) as ReadableStream<Uint8Array>;
        try { resolve(new Response(body, { status: res.statusCode ?? 502, headers })); }
        catch (error: unknown) { res.destroy(); bounded.destroy(); reject(error); }
      });
      req.once("error", reject);
      req.end(Buffer.concat(chunks, size));
    });
  };
}
