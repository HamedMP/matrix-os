import { GOOGLE_GEMINI_38_FLASH_MODEL_ID } from "@matrix-os/contracts";
import { z } from "zod/v4";
import { priceActualUsageMicrousd, type FundedTokenUsage } from "./funded-relay-model.js";
import type { FundedUsageTracker } from "./funded-relay-usage.js";

const Tokens = z.number().int().nonnegative().max(10_000_000);
const Usage = z.object({
  prompt_tokens: Tokens, completion_tokens: Tokens, total_tokens: Tokens,
  prompt_tokens_details: z.object({ cached_tokens: Tokens.optional() }).optional(),
  completion_tokens_details: z.unknown().optional(),
}).superRefine((value, ctx) => {
  if ((value.prompt_tokens_details?.cached_tokens ?? 0) > value.prompt_tokens) {
    ctx.addIssue({ code: "custom", message: "Inconsistent token usage" });
  }
});
const Event = z.object({
  id: z.string().min(1).max(256), model: z.string(),
  choices: z.array(z.object({ index: z.literal(0), finish_reason: z.string().nullable().optional() })).max(1),
  usage: Usage.nullable().optional(),
});

const GeminiCompletionDetails = z.object({ reasoning_tokens: Tokens.nullish() }).nullish();

function billedOutputTokens(usage: z.infer<typeof Usage>, modelId: string): number | undefined {
  const reportedTotal = usage.prompt_tokens + usage.completion_tokens;
  if (modelId !== GOOGLE_GEMINI_38_FLASH_MODEL_ID) {
    return usage.total_tokens === reportedTotal ? usage.completion_tokens : undefined;
  }
  // Cloudflare's Gemini wire can report thought tokens outside completion_tokens.
  // Bill both only if total_tokens independently accounts for the exact difference.
  // https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking
  const parsedDetails = GeminiCompletionDetails.safeParse(usage.completion_tokens_details);
  if (!parsedDetails.success) return undefined;
  const reasoningTokens = parsedDetails.data?.reasoning_tokens ?? 0;
  if (usage.total_tokens === reportedTotal) {
    return reasoningTokens <= usage.completion_tokens ? usage.completion_tokens : undefined;
  }
  return usage.total_tokens === reportedTotal + reasoningTokens
    ? usage.completion_tokens + reasoningTokens : undefined;
}

export function normalizeFundedGeminiUsage(value: unknown): unknown {
  const parsed = Usage.safeParse(value);
  if (!parsed.success) return value;
  const outputTokens = billedOutputTokens(parsed.data, GOOGLE_GEMINI_38_FLASH_MODEL_ID);
  // Pi and other OpenAI clients expect completion_tokens to include reasoning.
  if (outputTokens === undefined || outputTokens === parsed.data.completion_tokens) return value;
  return { ...(value as Record<string, unknown>), completion_tokens: outputTokens };
}

export function createFundedOpenAiUsageTracker(options: {
  contentType: string; nativeModelId: string; canonicalModelId: string;
  pricingVersion: string; maxCaptureBytes?: number;
}): FundedUsageTracker {
  const isSse = options.contentType.toLowerCase().startsWith("text/event-stream");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let bytes = 0;
  let invalid = false;
  let completed = false;
  let sawDone = false;
  let sawFinish = false;
  let responseId: string | null = null;
  let usage: FundedTokenUsage | null = null;
  function accept(value: unknown) {
    const parsed = Event.safeParse(value);
    if (!parsed.success || parsed.data.model !== options.nativeModelId || sawDone) { invalid = true; return; }
    const event = parsed.data;
    if (responseId !== null && event.id !== responseId) { invalid = true; return; }
    responseId = event.id;
    if (event.choices.some((choice) => choice.finish_reason != null)) sawFinish = true;
    if (event.usage) {
      const outputTokens = billedOutputTokens(event.usage, options.nativeModelId);
      if (outputTokens === undefined) { invalid = true; return; }
      const cached = event.usage.prompt_tokens_details?.cached_tokens ?? 0;
      const next = { inputTokens: event.usage.prompt_tokens - cached,
        outputTokens, cacheReadTokens: cached,
        cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 };
      // Duplicate final usage events are harmless; differing totals are not.
      if (usage !== null && JSON.stringify(usage) !== JSON.stringify(next)) invalid = true;
      usage = next;
    }
  }
  function block(text: string) {
    const data = text.split(/\r?\n/).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) return;
    if (data === "[DONE]") { if (sawDone) invalid = true; sawDone = true; return; }
    try { accept(JSON.parse(data)); } catch (error) {
      if (!(error instanceof SyntaxError)) console.warn("[proxy] Funded usage event decoding failed");
      invalid = true;
    }
  }
  function consume() {
    let separator: RegExpExecArray | null;
    while ((separator = /\r?\n\r?\n/.exec(buffer)) !== null) {
      block(buffer.slice(0, separator.index)); buffer = buffer.slice(separator.index + separator[0].length);
    }
  }
  return {
    push(chunk) {
      if (completed || invalid) return;
      bytes += chunk.byteLength;
      if (bytes > (options.maxCaptureBytes ?? 1024 * 1024)) { invalid = true; buffer = ""; return; }
      try { buffer += decoder.decode(chunk, { stream: true }); if (isSse) consume(); } catch (error) {
        if (!(error instanceof TypeError)) console.warn("[proxy] Funded usage text decoding failed");
        invalid = true; buffer = "";
      }
    },
    complete() {
      if (completed) return { mode: "conservative" };
      completed = true;
      try {
        buffer += decoder.decode();
        if (isSse) { consume(); if (buffer.trim()) block(buffer); }
        else { accept(JSON.parse(buffer)); sawDone = true; }
        if (invalid || !sawDone || !sawFinish || !usage) return { mode: "conservative" };
        return { mode: "exact", actualCostMicrousd: priceActualUsageMicrousd({
          canonicalModelId: options.canonicalModelId, pricingVersion: options.pricingVersion, usage,
        }) };
      } catch (error) {
        if (!(error instanceof Error)) console.warn("[proxy] Funded usage response decoding failed");
        return { mode: "conservative" };
      }
    },
  };
}
