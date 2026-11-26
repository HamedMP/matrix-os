import { z } from "zod/v4";
import { safeUpstreamHeaders } from "./funded-relay-stream.js";

const INVALID_RESPONSE = "Invalid funded OpenAI-compatible response";
const ResponseId = z.string().min(1).max(256);
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(INVALID_RESPONSE);
  return value as Record<string, unknown>;
}

/** Require exact response identity before releasing each bounded JSON/SSE payload. */
export function normalizeFundedOpenAiResponse(upstream: Response, options: {
  modelId: string;
  maxBytes: number;
  upstreamModelAlias?: string;
  rewriteAssistant?: (value: unknown, isSse: boolean) => unknown;
  rewriteUsage?: (value: unknown) => unknown;
}): Response {
  const { modelId, maxBytes, upstreamModelAlias, rewriteAssistant, rewriteUsage } = options;
  if (!upstream.body) return upstream;
  const isSse = upstream.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream") ?? false;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let buffer = "";
  let responseId: string | undefined;
  let sawDone = false;

  function translate(value: unknown) {
    const payload = record(value);
    if ((payload.model !== modelId && (!upstreamModelAlias || payload.model !== upstreamModelAlias))
      || !ResponseId.safeParse(payload.id).success
      || !Array.isArray(payload.choices) || payload.choices.length > 1
      || (responseId !== undefined && responseId !== payload.id)) throw new Error(INVALID_RESPONSE);
    responseId = payload.id as string;
    const field = isSse ? "delta" : "message";
    const choices = payload.choices.map((value: unknown) => {
      const choice = record(value);
      if (choice.index !== 0) throw new Error(INVALID_RESPONSE);
      return choice[field] === undefined || !rewriteAssistant ? choice
        : { ...choice, [field]: rewriteAssistant(choice[field], isSse) };
    });
    const usage = rewriteUsage && "usage" in payload ? { usage: rewriteUsage(payload.usage) } : {};
    return JSON.stringify({ ...payload, model: modelId, choices, ...usage });
  }
  function sseBlock(block: string, controller: TransformStreamDefaultController<Uint8Array>) {
    const data = block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data) return;
    if (sawDone) throw new Error(INVALID_RESPONSE);
    if (data === "[DONE]") sawDone = true;
    controller.enqueue(encoder.encode(`data: ${sawDone ? data : translate(JSON.parse(data))}\n\n`));
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
      if (bytes > maxBytes) throw new Error(INVALID_RESPONSE);
      buffer += decoder.decode(chunk, { stream: true });
      if (isSse) consume(controller);
    },
    flush(controller) {
      buffer += decoder.decode();
      if (!isSse) {
        controller.enqueue(encoder.encode(translate(JSON.parse(buffer))));
        return;
      }
      consume(controller);
      if (buffer.trim()) sseBlock(buffer, controller);
    },
  }));
  return new Response(transformed, { status: upstream.status, headers: safeUpstreamHeaders(upstream) });
}
