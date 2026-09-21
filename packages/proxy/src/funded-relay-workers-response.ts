import { safeUpstreamHeaders } from "./funded-relay-stream.js";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Workers AI's model-in-path API reports per-chunk usage deltas and a final
 * `{ response, usage }` aggregate. Only the aggregate can be billed. Convert it
 * to the OpenAI SDK's final choices:[] chunk; never expose misleading deltas.
 * Verified against the live GLM Flash model on 2026-09-10.
 */
export function normalizeWorkersAiResponse(upstream: Response, modelId: string, maxBytes: number): Response {
  if (!upstream.body) return upstream;
  const isSse = upstream.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream") ?? false;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let bytes = 0;
  let responseId: string | null = null;
  let created: number | null = null;
  let sawDone = false;
  let sawSummary = false;
  let summarySerialized: string | null = null;

  function sseBlock(block: string, controller: TransformStreamDefaultController<Uint8Array>) {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) return;
    if (sawDone) throw new Error("Invalid AI response");
    if (data === "[DONE]") {
      sawDone = true; controller.enqueue(encoder.encode("data: [DONE]\n\n")); return;
    }
    const value: unknown = JSON.parse(data);
    if (!record(value)) throw new Error("Invalid AI response");
    if ("response" in value) {
      if (responseId === null || !record(value.usage)) throw new Error("Invalid AI response");
      const nextSummary = JSON.stringify(value.usage);
      if (sawSummary) {
        if (nextSummary !== summarySerialized) throw new Error("Invalid AI response");
        return;
      }
      sawSummary = true; summarySerialized = nextSummary;
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: responseId, model: modelId,
        object: "chat.completion.chunk", ...(created === null ? {} : { created }), choices: [], usage: value.usage })}\n\n`));
      return;
    }
    if (!Array.isArray(value.choices) || value.model !== modelId || typeof value.id !== "string"
      || value.id.length > 256 || !value.id || sawSummary
      || (responseId !== null && responseId !== value.id)) throw new Error("Invalid AI response");
    responseId = value.id;
    if (typeof value.created === "number" && Number.isSafeInteger(value.created)) created = value.created;
    if (value.choices.length === 0) return;
    const { usage: _deltaUsage, ...forwarded } = value;
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(forwarded)}\n\n`));
  }
  function consume(controller: TransformStreamDefaultController<Uint8Array>) {
    let separator: RegExpExecArray | null;
    while ((separator = /\r?\n\r?\n/.exec(buffer)) !== null) {
      sseBlock(buffer.slice(0, separator.index), controller);
      buffer = buffer.slice(separator.index + separator[0].length);
    }
  }
  const transformed = upstream.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) throw new Error("AI response exceeded the configured limit");
      try {
        buffer += decoder.decode(chunk, { stream: true });
        if (isSse) consume(controller);
      } catch (error) {
        console.warn("[proxy] Workers AI response normalization failed", { errorName: error instanceof Error ? error.name : "UnknownError" });
        throw new Error("AI response stream failed");
      }
    },
    flush(controller) {
      try {
        buffer += decoder.decode();
        if (isSse) {
          consume(controller); if (buffer.trim()) sseBlock(buffer, controller);
        } else {
          const value: unknown = JSON.parse(buffer);
          const result = record(value) && value.success === true ? value.result : value;
          if (!record(result) || result.model !== modelId || !Array.isArray(result.choices)) throw new Error("Invalid AI response");
          controller.enqueue(encoder.encode(JSON.stringify(result)));
        }
      } catch (error) {
        console.warn("[proxy] Workers AI response normalization failed", { errorName: error instanceof Error ? error.name : "UnknownError" });
        throw new Error("AI response stream failed");
      }
    },
  }));
  return new Response(transformed, { status: upstream.status, headers: safeUpstreamHeaders(upstream) });
}
