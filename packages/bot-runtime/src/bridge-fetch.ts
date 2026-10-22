import { BOT_IMAGE_INFERENCE_MAX_BYTES, INFERENCE_RESPONSE_BUFFER_MAX_BYTES, validateBotImageInferenceBody } from "@matrix-os/contracts";
import { request as httpRequest } from "node:http";
import { Readable } from "node:stream";
import { MAX_BRIDGE_RESPONSE_BYTES } from "@matrix-os/scope-runtime/inference-bridge";

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
        if (size > BOT_IMAGE_INFERENCE_MAX_BYTES) throw new RangeError("Bot inference request exceeds capacity");
        chunks.push(next.value);
      }
    } finally {
      signal.removeEventListener("abort", cancelBody);
      await reader?.cancel();
      reader?.releaseLock();
    }
    signal.throwIfAborted();
    if (size > 0 && !validateBotImageInferenceBody(Buffer.concat(chunks, size).toString("utf8")).valid) throw new RangeError("Bot inference request exceeds capacity or has invalid images");
    return new Promise<Response>((resolve, reject) => {
      const req = httpRequest({ socketPath, path: url.pathname + url.search, method: request.method,
        headers: Object.fromEntries(request.headers), signal }, (res) => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
        const streamed = res.headers["x-matrix-inference-stream"] === "1";
        let received = 0;
        const source = Readable.toWeb(res) as ReadableStream<Uint8Array>;
        const body = source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            if (!streamed) received += chunk.byteLength;
            if (chunk.byteLength > INFERENCE_RESPONSE_BUFFER_MAX_BYTES
              || (!streamed && received > MAX_BRIDGE_RESPONSE_BYTES)) {
              throw new RangeError("Bot inference response exceeds capacity");
            }
            controller.enqueue(chunk);
          },
        }));
        try { resolve(new Response(body, { status: res.statusCode ?? 502, headers })); }
        catch (error: unknown) { res.destroy(); reject(error); }
      });
      req.once("error", reject);
      req.end(Buffer.concat(chunks, size));
    });
  };
}
