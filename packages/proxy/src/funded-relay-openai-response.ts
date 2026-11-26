import { GOOGLE_GEMINI_38_FLASH_MODEL_ID } from "@matrix-os/contracts";
import { z } from "zod/v4";
import { normalizeFundedGeminiUsage } from "./funded-relay-openai-usage.js";
import { safeUpstreamHeaders } from "./funded-relay-stream.js";

const INVALID_RESPONSE = "Invalid funded OpenAI-compatible response";
const ResponseId = z.string().min(1).max(256);
function record(value: unknown, error = INVALID_RESPONSE): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(error);
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

const Signature = z.string().min(1).max(1024 * 1024).regex(/^[A-Za-z0-9+/_-]+={0,2}$/);
const ToolId = z.string().min(1).max(256);
const SIGNATURE_FORMAT = "google-vertex-tool-signature-v1";
export const FundedGeminiReplaySchema = z.object({
  type: z.literal("reasoning.encrypted"),
  format: z.literal(SIGNATURE_FORMAT),
  id: ToolId,
  data: Signature,
}).strict();

export function restoreFundedGeminiToolSignatures<T extends { id: string }>(
  toolCalls: readonly T[], signatures: ReadonlyArray<z.infer<typeof FundedGeminiReplaySchema>>,
) {
  const signaturesById = new Map(signatures.map(signature => [signature.id, signature.data]));
  if (signaturesById.size !== signatures.length
    || signatures.some(signature => toolCalls.filter(call => call.id === signature.id).length !== 1)) {
    throw new Error("Funded Gemini reasoning detail does not match its tool call");
  }
  return toolCalls.map(call => {
    const signature = signaturesById.get(call.id);
    return signature === undefined ? call : { ...call, extra_content: { google: { thought_signature: signature } } };
  });
}

type JsonRecord = Record<string, unknown>;
const FALLBACK_ERROR = "Invalid funded Gemini response";
const WireToolCall = z.object({
  index: z.number().int().nonnegative().max(255).optional(), id: ToolId.optional(),
  extra_content: z.object({ google: z.object({ thought_signature: Signature.optional() }).optional() }).optional(),
}).passthrough();

/** Pi's OpenAI transport round-trips encrypted reasoning_details internally. Translate the
 * Google-native replay material at the Relay boundary, keyed to the exact provider tool ID. */
function assistantWire(value: unknown, streamedToolIds?: Map<number, string>): JsonRecord {
  const { tool_calls, reasoning_details: _untrusted, ...assistant } = record(value, FALLBACK_ERROR);
  if (tool_calls === undefined || tool_calls === null) return assistant;
  const signatures: z.infer<typeof FundedGeminiReplaySchema>[] = [];
  const toolCalls = z.array(WireToolCall).max(256).parse(tool_calls).map(call => {
    const { extra_content, ...forwarded } = call;
    let id = call.id;
    if (streamedToolIds && call.index !== undefined) {
      const previous = streamedToolIds.get(call.index);
      if (id && previous && previous !== id) throw new Error(FALLBACK_ERROR);
      if (id) streamedToolIds.set(call.index, id);
      else id = previous;
    }
    const signature = extra_content?.google?.thought_signature;
    if (signature !== undefined) {
      if (!id) throw new Error(FALLBACK_ERROR);
      signatures.push({ type: "reasoning.encrypted", format: SIGNATURE_FORMAT, id, data: signature });
    }
    return forwarded;
  });
  return { ...assistant, tool_calls: toolCalls, ...(signatures.length ? { reasoning_details: signatures } : {}) };
}

export function normalizeFundedGeminiResponse(upstream: Response, maxBytes: number): Response {
  // The index is provider validated to the same 256-tool limit as the input.
  const streamedToolIds = new Map<number, string>();
  return normalizeFundedOpenAiResponse(upstream, { modelId: GOOGLE_GEMINI_38_FLASH_MODEL_ID, maxBytes,
    rewriteAssistant: (assistant, isSse) => assistantWire(assistant, isSse ? streamedToolIds : undefined),
    rewriteUsage: normalizeFundedGeminiUsage });
}
