import { z } from "zod/v4";
import { priceActualUsageMicrousd, type FundedTokenUsage } from "./funded-relay-model.js";
import type { FundedUsageTracker } from "./funded-relay-usage.js";

const Tokens = z.number().int().nonnegative().max(10_000_000);
const Usage = z.object({
  prompt_tokens: Tokens, completion_tokens: Tokens, total_tokens: Tokens,
  prompt_tokens_details: z.object({ cached_tokens: Tokens.optional() }).optional(),
}).superRefine((value, ctx) => {
  if (value.total_tokens !== value.prompt_tokens + value.completion_tokens
    || (value.prompt_tokens_details?.cached_tokens ?? 0) > value.prompt_tokens) {
    ctx.addIssue({ code: "custom", message: "Inconsistent token usage" });
  }
});
const Event = z.object({
  id: z.string().min(1).max(256), model: z.string(),
  choices: z.array(z.object({ index: z.literal(0), finish_reason: z.string().nullable().optional() })).max(1),
  usage: Usage.nullable().optional(),
});

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
      const cached = event.usage.prompt_tokens_details?.cached_tokens ?? 0;
      const next = { inputTokens: event.usage.prompt_tokens - cached,
        outputTokens: event.usage.completion_tokens, cacheReadTokens: cached,
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
