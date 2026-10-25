import { SCOPE_RUNTIME_BOT_HARNESS_VERSION } from "@matrix-os/scope-runtime/bot-profile";
import type { ClassificationApi, GenerationFacts } from "../chat-analytics/contracts.js";
import type { OrdinaryGenerationReceipt, createTransientChatClassifier } from "../chat-analytics/index.js";
import type { PiRuntimeBinding } from "./runtime-registry.js";

export type InferenceAnalytics = Pick<ReturnType<typeof createTransientChatClassifier>, "capture" | "completed" | "cancel">;
export type OwnedInferenceAnalytics = InferenceAnalytics & Pick<ReturnType<typeof createTransientChatClassifier>, "close">;
type Tokens = Pick<GenerationFacts, "inputTokens" | "outputTokens" | "cachedInputTokens">;
const unknownTokens = (): Tokens => ({ inputTokens: null, outputTokens: null, cachedInputTokens: null });
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : null;
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000_000;
function cache(value: unknown, input: number, partOfInput = true): number | null | undefined {
  if (value === undefined) return null;
  return count(value) && (!partOfInput || value <= input) ? value : undefined;
}

/** Observed wire counters only. No price inference, provider headers, arbitrary
 * metadata, prompt text, or partial/malformed usage is an accounting source.
 * Parsing has independent byte/event bounds below the primary response bound. */
export function measuredInferenceTokens(api: ClassificationApi, body: string, modelId: string): Tokens {
  if (Buffer.byteLength(body) > 256 * 1024) return unknownTokens();
  try {
    let events: unknown[];
    if (body.trimStart().startsWith("{")) events = [JSON.parse(body)];
    else {
      const frames = body.split(/\r?\n\r?\n/);
      if (frames.length > 512) return unknownTokens();
      events = frames.flatMap(frame => {
        const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        return !data || data === "[DONE]" ? [] : [JSON.parse(data)];
      });
    }
    let result: Tokens | undefined;
    let anthropicInput: { input: number; cached: number | null } | undefined;
    let anthropicOutput: number | undefined;
    let stopped = false;
    for (const value of events) {
      const event = record(value);
      if (!event || event.error !== undefined || event.type === "error") return unknownTokens();
      if (api === "anthropic-messages") {
        const start = event.type === "message_start" ? record(event.message) : event.type === "message" ? event : null;
        if (start) {
          const usage = record(start.usage);
          if (anthropicInput || start.model !== modelId || !usage || !count(usage.input_tokens)) return unknownTokens();
          const cached = cache(usage.cache_read_input_tokens, usage.input_tokens, false);
          if (cached === undefined) return unknownTokens();
          anthropicInput = { input: usage.input_tokens, cached };
          if (event.type === "message") {
            if (!count(usage.output_tokens)) return unknownTokens();
            anthropicOutput = usage.output_tokens; stopped = true;
          }
        } else if (event.type === "message_delta" && record(event.usage)?.output_tokens !== undefined) {
          const output = record(event.usage)!.output_tokens;
          if (!anthropicInput || anthropicOutput !== undefined || !count(output)) return unknownTokens();
          anthropicOutput = output;
        } else if (event.type === "message_stop") {
          if (stopped || !anthropicInput || anthropicOutput === undefined) return unknownTokens();
          stopped = true;
        }
      } else {
        const response = api === "openai-responses" && event.type === "response.completed" ? record(event.response)
          : api === "openai-completions" || api === "openai-responses" && event.object === "response" ? event : null;
        if (!response || response.usage === undefined) continue;
        const usage = record(response.usage);
        const input = api === "openai-completions" ? usage?.prompt_tokens : usage?.input_tokens;
        const output = api === "openai-completions" ? usage?.completion_tokens : usage?.output_tokens;
        if (result || response.model !== modelId || !usage || !count(input) || !count(output)
          || api === "openai-responses" && response.status !== "completed") return unknownTokens();
        const details = record(api === "openai-completions" ? usage.prompt_tokens_details : usage.input_tokens_details);
        const cached = cache(details?.cached_tokens, input);
        if (cached === undefined) return unknownTokens();
        result = { inputTokens: input, outputTokens: output, cachedInputTokens: cached };
      }
    }
    return api === "anthropic-messages" && anthropicInput && anthropicOutput !== undefined && stopped
      ? { inputTokens: anthropicInput.input, outputTokens: anthropicOutput, cachedInputTokens: anthropicInput.cached }
      : result ?? unknownTokens();
  } catch (error: unknown) {
    // Unreadable accounting is unknown; it does not change primary inference.
    if (!(error instanceof SyntaxError)) console.warn("[chat-usage] Measurement unavailable", { errorClass: error instanceof Error ? "Error" : "UnknownError" });
    return unknownTokens();
  }
}

export interface InferenceAnalyticsAttempt { cancel(): void; completed(body: string): void }
/** Called only after real broker admission. The service independently proves
 * positive ordinary provenance; this wrapper grants no permission itself. */
export async function captureInferenceAnalytics(input: {
  analytics?: InferenceAnalytics; binding: PiRuntimeBinding; requestId: string; api: ClassificationApi;
  body: string; signal: AbortSignal; modelId: string; accessSource: string; startedAt: number;
}): Promise<InferenceAnalyticsAttempt | undefined> {
  if (!input.analytics) return undefined;
  const analytics = input.analytics;
  let receipt: OrdinaryGenerationReceipt | null;
  try {
    const { ownerId, chatId, runId, runtimeHandle, executionGeneration } = input.binding;
    receipt = await analytics.capture({ binding: { ownerId, chatId, runId, runtimeHandle, executionGeneration, requestId: input.requestId },
      api: input.api, body: input.body, signal: input.signal });
  } catch (error: unknown) {
    console.warn("[chat-usage] Capture unavailable", { errorClass: error instanceof Error ? "Error" : "UnknownError" });
    return undefined;
  }
  if (!receipt) return undefined;
  let settled = false;
  const cancel = () => {
    if (settled) return;
    settled = true;
    try { analytics.cancel(receipt!); }
    catch (error: unknown) { console.warn("[chat-usage] Cancellation unavailable", { errorClass: error instanceof Error ? "Error" : "UnknownError" }); }
  };
  return {
    cancel,
    completed(body) {
      if (settled) return;
      try {
        analytics.completed(receipt!, { ...measuredInferenceTokens(input.api, body, input.modelId),
          modelId: input.modelId, harness: SCOPE_RUNTIME_BOT_HARNESS_VERSION, accessSource: input.accessSource,
          costUsd: null, latencyMs: Math.max(0, performance.now() - input.startedAt), completedAt: new Date().toISOString() });
        settled = true;
      } catch (error: unknown) {
        console.warn("[chat-usage] Completion unavailable", { errorClass: error instanceof Error ? "Error" : "UnknownError" });
        cancel();
      }
    },
  };
}
