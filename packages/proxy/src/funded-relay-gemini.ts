import { GOOGLE_GEMINI_38_FLASH_MODEL_ID } from "@matrix-os/contracts";
import { z } from "zod/v4";
import { normalizeFundedOpenAiResponse } from "./funded-relay-openai-response.js";
import { normalizeFundedGeminiUsage } from "./funded-relay-openai-usage.js";

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
function record(value: unknown): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(FALLBACK_ERROR);
  return value as JsonRecord;
}

const WireToolCall = z.object({
  index: z.number().int().nonnegative().max(255).optional(), id: ToolId.optional(),
  extra_content: z.object({ google: z.object({ thought_signature: Signature.optional() }).optional() }).optional(),
}).passthrough();

/** Pi's OpenAI transport round-trips encrypted reasoning_details internally. Translate the
 * Google-native replay material at the Relay boundary, keyed to the exact provider tool ID. */
function assistantWire(value: unknown, streamedToolIds?: Map<number, string>): JsonRecord {
  const { tool_calls, reasoning_details: _untrusted, ...assistant } = record(value);
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
