const MAX_SINGLE_FILE_BYTES = 110 * 1024 * 1024;
const MAX_TOTAL_BYTES = 140 * 1024 * 1024;

/** Bounds third-party model downloads in the disposable narration worker. */
export function createBoundedNarrationFetch(fetchImpl, { maxFileBytes = MAX_SINGLE_FILE_BYTES, maxTotalBytes = MAX_TOTAL_BYTES, timeoutMs = 180_000 } = {}) {
  let totalBytes = 0;
  return async (input, init = {}) => {
    const workerLocation = typeof self !== "undefined" ? self.location : undefined;
    const url = new URL(typeof input === "string" ? input : input.url, workerLocation?.href ?? "https://matrix-os.com/");
    const sameOrigin = !!workerLocation && url.origin === workerLocation.origin;
    const modelHub = url.protocol === "https:" && url.hostname === "huggingface.co" && url.pathname.startsWith("/onnx-community/Kokoro-82M-v1.0-ONNX/");
    if (!sameOrigin && !modelHub) {
      throw new Error("Unexpected local voice model download URL.");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    if (init.signal?.aborted) controller.abort();
    else init.signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => { clearTimeout(timeout); init.signal?.removeEventListener("abort", onAbort); };
    try {
      const response = await fetchImpl(input, { ...init, signal: controller.signal });
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared > maxFileBytes || totalBytes + declared > maxTotalBytes) throw new Error("Voice model download exceeds the browser limit.");
      if (!response.body) { cleanup(); return response; }
      let fileBytes = 0;
      const body = response.body.pipeThrough(new TransformStream({
        transform(chunk, sink) {
          fileBytes += chunk.byteLength;
          totalBytes += chunk.byteLength;
          if (fileBytes > maxFileBytes || totalBytes > maxTotalBytes) { cleanup(); throw new Error("Voice model download exceeds the browser limit."); }
          sink.enqueue(chunk);
        },
        flush() { cleanup(); },
      }));
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) { cleanup(); throw error; }
  };
}
