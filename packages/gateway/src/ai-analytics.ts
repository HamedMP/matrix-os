import { randomUUID } from "node:crypto";

/**
 * PostHog LLM analytics: manual `$ai_generation` events captured once per
 * completed kernel query. PostHog auto-assembles traces from events sharing
 * `$ai_trace_id` (the Agent SDK session id).
 *
 * Privacy: `$ai_input` and `$ai_output_choices` are intentionally never sent.
 * Conversation content stays on the user's VPS; only model, token counts,
 * latency, and error categories leave the box.
 */

export const AI_GENERATION_EVENT = "$ai_generation";

type EnvSource = Record<string, string | undefined>;

export type AiCaptureFn = (
  event: string,
  options: {
    distinctId?: string;
    properties?: Record<string, string | number | boolean | null | undefined>;
  },
) => unknown;

export interface AiGenerationInput {
  /** Kernel/Agent SDK session id; falls back to a generated id when absent. */
  traceId?: string;
  model?: string;
  latencyMs: number;
  tokensIn?: number;
  tokensOut?: number;
  /** Present when the query failed. Only the error category is captured. */
  error?: unknown;
}

export interface AiAnalyticsLogger {
  warn(message: string): void;
}

export interface CreateAiGenerationRecorderOptions {
  capture: AiCaptureFn;
  env?: EnvSource;
  logger?: AiAnalyticsLogger;
}

// PostHog allows alnum plus -_~.@()!':| in $ai_trace_id.
const TRACE_ID_DISALLOWED = /[^a-zA-Z0-9\-_~.@()!':|]/g;
const MAX_TRACE_ID_LENGTH = 128;

export function sanitizeAiTraceId(value: string | undefined): string {
  const cleaned = (value ?? "").replace(TRACE_ID_DISALLOWED, "").slice(0, MAX_TRACE_ID_LENGTH);
  // A fresh id per untraced generation keeps PostHog from collapsing
  // unrelated generations into one synthetic trace.
  return cleaned.length > 0 ? cleaned : randomUUID();
}

/** Error category only -- never the message, which can contain user content. */
export function categorizeAiError(error: unknown): string {
  return error instanceof Error ? error.name || "Error" : typeof error;
}

function errorKind(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Promise<unknown>).then === "function"
  );
}

function resolveDistinctId(env: EnvSource): string {
  return env.MATRIX_USER_ID?.trim() || env.MATRIX_HANDLE?.trim() || "matrix-gateway";
}

export function createAiGenerationRecorder(
  options: CreateAiGenerationRecorderOptions,
): (input: AiGenerationInput) => void {
  const logger = options.logger ?? console;
  const env = options.env ?? process.env;
  const distinctId = resolveDistinctId(env);

  return (input: AiGenerationInput): void => {
    try {
      const isError = input.error !== undefined;
      const result = options.capture(AI_GENERATION_EVENT, {
        distinctId,
        properties: {
          $ai_trace_id: sanitizeAiTraceId(input.traceId),
          $ai_provider: "anthropic",
          $ai_model: input.model,
          $ai_latency: input.latencyMs / 1000,
          $ai_input_tokens: input.tokensIn,
          $ai_output_tokens: input.tokensOut,
          $ai_is_error: isError,
          $ai_error: isError ? categorizeAiError(input.error) : undefined,
        },
      });
      if (isPromiseLike(result)) {
        result.then(undefined, (err: unknown) => {
          logger.warn(`[ai-analytics] failed to capture generation: ${errorKind(err)}`);
        });
      }
    } catch (err: unknown) {
      // Observability must never break dispatch. Log the error kind only.
      logger.warn(`[ai-analytics] failed to capture generation: ${errorKind(err)}`);
    }
  };
}
