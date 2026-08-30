import { z } from "zod/v4";
import { priceActualUsageMicrousd, type FundedTokenUsage } from "./funded-relay-model.js";

const DEFAULT_CAPTURE_LIMIT = 1024 * 1024;
const TokenSchema = z.number().int().nonnegative().max(10_000_000);
const UsageSchema = z.object({
  input_tokens: TokenSchema,
  output_tokens: TokenSchema.optional(),
  cache_read_input_tokens: TokenSchema.optional(),
  cache_creation_input_tokens: TokenSchema.optional(),
});
const JsonResponseSchema = z.object({
  type: z.literal("message"),
  model: z.string(),
  usage: UsageSchema.extend({ output_tokens: TokenSchema }),
});

export type FundedFinalization =
  | { mode: "exact"; actualCostMicrousd: number }
  | { mode: "conservative" };

export interface FundedUsageTracker {
  push(chunk: Uint8Array): void;
  complete(): FundedFinalization;
}

function toUsage(input: z.infer<typeof UsageSchema>, outputTokens: number): FundedTokenUsage {
  return {
    inputTokens: input.input_tokens,
    outputTokens,
    cacheReadTokens: input.cache_read_input_tokens ?? 0,
    cacheWriteTokens: input.cache_creation_input_tokens ?? 0,
  };
}

export function createFundedUsageTracker(options: {
  contentType: string;
  nativeModelId: string;
  canonicalModelId: string;
  pricingVersion: string;
  maxCaptureBytes?: number;
}): FundedUsageTracker {
  const maxCaptureBytes = options.maxCaptureBytes ?? DEFAULT_CAPTURE_LIMIT;
  const isSse = options.contentType.toLowerCase().startsWith("text/event-stream");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let seenBytes = 0;
  let invalid = false;
  let completed = false;
  let startUsage: z.infer<typeof UsageSchema> | null = null;
  let outputTokens: number | null = null;
  let sawStop = false;

  function processSseEvent(block: string): void {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n");
    if (data === "" || data === "[DONE]") return;
    let value: unknown;
    try {
      value = JSON.parse(data) as unknown;
    } catch (error) {
      if (!(error instanceof Error)) console.warn("[proxy] Funded AI usage event parse failed");
      invalid = true;
      return;
    }
    if (typeof value !== "object" || value === null || !("type" in value)) {
      invalid = true;
      return;
    }
    const event = value as Record<string, unknown>;
    if (event.type === "message_start") {
      if (startUsage !== null || sawStop || typeof event.message !== "object" || event.message === null) {
        invalid = true;
        return;
      }
      const message = event.message as Record<string, unknown>;
      const usage = UsageSchema.safeParse(message.usage);
      if (message.type !== "message" || message.model !== options.nativeModelId || !usage.success) {
        invalid = true;
        return;
      }
      startUsage = usage.data;
      return;
    }
    if (event.type === "message_delta") {
      const usage = z.object({ output_tokens: TokenSchema }).safeParse(event.usage);
      if (startUsage === null || sawStop || !usage.success || outputTokens !== null) {
        invalid = true;
        return;
      }
      outputTokens = usage.data.output_tokens;
      return;
    }
    if (event.type === "message_stop") {
      if (startUsage === null || outputTokens === null || sawStop) invalid = true;
      sawStop = true;
      return;
    }
    if (event.type === "error") invalid = true;
  }

  function processAvailableEvents(final: boolean): void {
    while (true) {
      const separator = /\r?\n\r?\n/.exec(buffer);
      if (!separator || separator.index === undefined) break;
      const block = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator[0].length);
      processSseEvent(block);
    }
    if (final && buffer.trim() !== "") {
      processSseEvent(buffer);
      buffer = "";
    }
  }

  return {
    push(chunk) {
      if (completed || invalid) return;
      seenBytes += chunk.byteLength;
      if (seenBytes > maxCaptureBytes) {
        invalid = true;
        buffer = "";
        return;
      }
      try {
        buffer += decoder.decode(chunk, { stream: true });
        if (isSse) processAvailableEvents(false);
      } catch (error) {
        if (!(error instanceof Error)) console.warn("[proxy] Funded AI usage decoding failed");
        invalid = true;
        buffer = "";
      }
    },
    complete() {
      if (completed) return { mode: "conservative" };
      completed = true;
      try {
        buffer += decoder.decode();
      } catch (error) {
        if (!(error instanceof Error)) console.warn("[proxy] Funded AI usage decoding failed");
        invalid = true;
      }
      let usage: FundedTokenUsage | null = null;
      if (!invalid && isSse) {
        processAvailableEvents(true);
        if (!invalid && startUsage !== null && outputTokens !== null && sawStop) {
          usage = toUsage(startUsage, outputTokens);
        }
      } else if (!invalid) {
        try {
          const parsed = JsonResponseSchema.parse(JSON.parse(buffer) as unknown);
          if (parsed.model === options.nativeModelId) usage = toUsage(parsed.usage, parsed.usage.output_tokens);
        } catch (error) {
          if (!(error instanceof Error)) console.warn("[proxy] Funded AI usage response parse failed");
          invalid = true;
        }
      }
      if (!usage) return { mode: "conservative" };
      try {
        return {
          mode: "exact",
          actualCostMicrousd: priceActualUsageMicrousd({
            canonicalModelId: options.canonicalModelId,
            pricingVersion: options.pricingVersion,
            usage,
          }),
        };
      } catch (error) {
        if (!(error instanceof Error)) console.warn("[proxy] Funded AI usage pricing failed");
        return { mode: "conservative" };
      }
    },
  };
}
