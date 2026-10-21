import { MCP_TOOL_STREAM_TYPE, MCP_TOOL_RESULT_MAX_BYTES, MCP_TOOL_STREAM_MAX_BYTES, McpToolProgressSchema, type McpProgressListener } from "./tool-progress.js";

/** One invocation, no retry/resume: existing broker authorization still owns dispatch. */
export function toolProgressResponse(signal: AbortSignal, call: (onProgress: McpProgressListener, signal: AbortSignal) => Promise<unknown>): Response {
  const abort = new AbortController();
  const owned = AbortSignal.any([signal, abort.signal, AbortSignal.timeout(30_000)]);
  const encoder = new TextEncoder();
  let closed = false;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let count = 0;
      let bytes = 0;
      const send = (value: unknown) => {
        if (closed || owned.aborted) return;
        const frame = encoder.encode(`${JSON.stringify(value)}\n`);
        bytes += frame.byteLength;
        if (bytes > MCP_TOOL_STREAM_MAX_BYTES) throw new Error("MCP result exceeds limit");
        controller.enqueue(frame);
      };
      try {
        const result = await call(progress => {
          if (count >= 3) return;
          const parsed = McpToolProgressSchema.safeParse(progress);
          if (parsed.success) { count++; send({ type: "progress", ...parsed.data }); }
        }, owned);
        if (encoder.encode(JSON.stringify(result)).byteLength > MCP_TOOL_RESULT_MAX_BYTES) throw new Error("MCP result exceeds limit");
        send({ type: "result", result });
      } catch (error: unknown) {
        console.warn("[custom-mcp] streamed call failed:", error instanceof Error ? error.name : "UnknownError");
        send({ type: "error" });
      } finally {
        if (!closed) { closed = true; controller.close(); }
      }
    },
    cancel() { closed = true; abort.abort(); },
  });
  return new Response(body, { headers: { "content-type": MCP_TOOL_STREAM_TYPE, "cache-control": "no-store, private", "x-accel-buffering": "no" } });
}
