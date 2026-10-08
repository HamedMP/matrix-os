/**
 * Company Brain model claims: the Claude Messages API client behind BrainClaimModel. One non-streaming call per
 * document: the cached system prompt, the title and footer-stripped body as the user turn, structured JSON output,
 * server-side refusal fallbacks ("default"), adaptive thinking at the configured effort. The response is read in a
 * fixed order: usage, refusal, stop reason, then the single text block parsed against the wire schema. SDK errors map
 * to BrainModelError codes by class; a caller abort is rethrown untouched so the job can tell its own signals apart.
 * The key is held by the SDK client of one request only, never follows a redirect and is never logged.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { BrainClaimCandidateSchema, BrainClaimFieldsSchema, type BrainClaimFields } from "../types.js";
import { brainModelUsage } from "./pricing.js";
import { BRAIN_MODEL_SYSTEM_PROMPT, brainModelSkipCode, brainModelUserContent } from "./prompt.js";
import {
  BRAIN_MODEL_API_BASE_URL, BRAIN_MODEL_FALLBACK_BETA, BRAIN_MODEL_MAX_RETRIES, BRAIN_MODEL_MAX_TOKENS,
  BrainModelError, BrainModelWireOutputSchema, type BrainAnthropicClaimModel, type BrainAnthropicModelOptions,
  type BrainModelClaimCandidate, type BrainModelErrorCode, type BrainModelFetch, type BrainModelOutput,
  type BrainModelUsage, type BrainModelWireOutput,
} from "./types.js";

/**
 * The SDK error classes this client maps, from the gateway's own copy of the SDK: with hoisting another package's copy
 * can be a different version whose classes fail instanceof against errors thrown here.
 */
export {
  AnthropicError, APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError,
} from "@anthropic-ai/sdk";

/** Built once at module load: the schema bytes, part of every request, never change between calls. */
export const BRAIN_MODEL_WIRE_FORMAT = betaZodOutputFormat(BrainModelWireOutputSchema);
const ZERO_USAGE: BrainModelUsage = {
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicroUsd: 0,
};

type WireClaim = BrainModelWireOutput["claims"][number];
const LABEL = BrainClaimCandidateSchema.shape.label;
const FIELD = BrainClaimFieldsSchema.shape;
/** The longest server-requested wait the SDK may sleep before its one retry, well inside the job's per-call timeout. */
const RETRY_AFTER_MAX_MS = 5_000;

/** The wait a response asks for before a retry, read as the SDK reads it (retry-after-ms, else retry-after). */
function requestedWaitMs(headers: Headers): number {
  const milliseconds = Number.parseFloat(headers.get("retry-after-ms") ?? "");
  if (milliseconds) return milliseconds;
  const after = headers.get("retry-after");
  if (after === null) return 0;
  const seconds = Number.parseFloat(after);
  return Number.isNaN(seconds) ? Date.parse(after) - Date.now() : seconds * 1_000;
}

/**
 * The SDK sleeps for whatever wait a 429 or 5xx names before retrying; a long one would outlast the job's per-call
 * timeout and fail the document as model_timeout. Such a response is marked not retryable (x-should-retry), so the
 * call fails at once as model_unavailable and the run stops with retry_later.
 */
export function withBoundedRetryWaits(fetch: BrainModelFetch, timeoutMs: number): BrainModelFetch {
  return async (input, init) => {
    // The SDK passes its per-attempt signal (its timeout and the caller's abort); a timeout is added should it not.
    const response = await fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(timeoutMs) });
    if (response.ok || !(requestedWaitMs(response.headers) > RETRY_AFTER_MAX_MS)) return response;
    const headers = new Headers(response.headers);
    headers.set("x-should-retry", "false");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  };
}

export function createAnthropicBrainClaimModel(options: BrainAnthropicModelOptions): BrainAnthropicClaimModel {
  const client = new Anthropic({
    apiKey: options.apiKey, // explicit: the SDK never reads ANTHROPIC_API_KEY or a login profile
    authToken: null, // never ANTHROPIC_AUTH_TOKEN: both auth headers together are a 401
    baseURL: BRAIN_MODEL_API_BASE_URL, // never ANTHROPIC_BASE_URL: document text goes to the API only
    timeout: options.timeoutMs, // per attempt
    maxRetries: BRAIN_MODEL_MAX_RETRIES,
    logLevel: "off", // ANTHROPIC_LOG=debug would log request bodies
    fetch: withBoundedRetryWaits(options.fetch ?? globalThis.fetch, options.timeoutMs),
    // A redirect would carry x-api-key and the document text to another origin; fail instead of following it.
    fetchOptions: { redirect: "error" },
  });
  const skipCode = (input: { readonly body: string }) => brainModelSkipCode(input.body, options.bodyMaxBytes);
  return {
    skip: skipCode,
    async extract(input, signal) {
      const skip = skipCode(input);
      if (skip !== null) return { claims: [], usage: { ...ZERO_USAGE }, outcome: { status: "skipped", code: skip } };
      let message: Anthropic.Beta.BetaMessage;
      try {
        // No thinking, sampling parameters, tools, tool_choice or prefill: Claude Opus 5.5 rejects the disabled and
        // budget thinking forms and forced tool choice; depth is output_config.effort, JSON is output_config.format.
        message = await client.beta.messages.create({
          model: options.modelId,
          max_tokens: BRAIN_MODEL_MAX_TOKENS,
          betas: [BRAIN_MODEL_FALLBACK_BETA],
          fallbacks: "default",
          system: [{ type: "text", text: BRAIN_MODEL_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: brainModelUserContent(input) }],
          output_config: { effort: options.effort, format: BRAIN_MODEL_WIRE_FORMAT },
        }, { signal });
      } catch (error) {
        throw callError(error, signal);
      }
      return readMessage(message, options.modelId);
    },
  };
}

/** A caller abort stays as thrown; SDK errors become BrainModelError; anything else is rethrown untouched. */
function callError(error: unknown, signal: AbortSignal): unknown {
  if (signal.aborted || error instanceof Anthropic.APIUserAbortError) return error;
  const code = errorCode(error);
  return code === null ? error : new BrainModelError(code, { cause: error });
}

/** Most specific class first: the connection errors extend APIError. A status is read only for 402 and 408. */
function errorCode(error: unknown): BrainModelErrorCode | null {
  if (error instanceof Anthropic.APIConnectionTimeoutError) return "model_timeout";
  if (error instanceof Anthropic.APIConnectionError) return "model_unavailable";
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError
    || error instanceof Anthropic.NotFoundError) return "model_auth_failed";
  if (error instanceof Anthropic.ConflictError || error instanceof Anthropic.RateLimitError
    || error instanceof Anthropic.InternalServerError) return "model_unavailable";
  if (error instanceof Anthropic.BadRequestError || error instanceof Anthropic.UnprocessableEntityError) {
    return "model_rejected";
  }
  if (error instanceof Anthropic.APIError) {
    if (error.status === 402) return "model_auth_failed"; // billing_error
    if (error.status === 408) return "model_unavailable";
    return "model_rejected";
  }
  return null;
}

/** Usage first, so a refusal or an unusable response is still counted; then the stop reason; then the text. */
function readMessage(message: Anthropic.Beta.BetaMessage, modelId: string): BrainModelOutput {
  const usage = brainModelUsage(message.usage, modelId);
  const invalid: BrainModelOutput = { claims: [], usage, outcome: { status: "invalid" } };
  if (message.stop_reason === "refusal") {
    // recommended_model: the fallback could not run (its model was rate-limited or overloaded), so the chain never
    // declined as a whole; invalid keeps the revision retryable. Otherwise the whole chain declined (stop_details may
    // be null) and the revision is skipped until it changes.
    const details = message.stop_details;
    if (details?.type === "refusal" && details.recommended_model != null) return invalid;
    return { claims: [], usage, outcome: { status: "skipped", code: "model_refused" } };
  }
  if (message.stop_reason !== "end_turn") return invalid;
  // Thinking blocks (empty text) and fallback markers are not output.
  const texts = message.content.filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text");
  if (texts.length !== 1) return invalid;
  let output: BrainModelWireOutput;
  try {
    output = BRAIN_MODEL_WIRE_FORMAT.parse(texts[0].text);
  } catch (error) {
    // SyntaxError: not JSON. AnthropicError: JSON of the wrong shape.
    if (error instanceof SyntaxError || error instanceof Anthropic.AnthropicError) return invalid;
    throw error;
  }
  return { claims: output.claims.map(toCandidate), usage };
}

/** kind, statement and quote pass unchanged (verify.ts re-validates); an unusable label or field is dropped alone. */
function toCandidate(claim: WireClaim): BrainModelClaimCandidate {
  const label = claim.label !== null && LABEL.safeParse(claim.label).success ? claim.label : null;
  const fields = toFields(claim.fields);
  return {
    kind: claim.kind, label, statement: claim.statement, quote: claim.quote,
    ...(fields === undefined ? {} : { fields }),
  };
}

function toFields(wire: WireClaim["fields"]): BrainClaimFields | undefined {
  const assignee = wire.assignee === null ? undefined : FIELD.assignee.safeParse(wire.assignee).data;
  const due = wire.due === null ? undefined : FIELD.due.safeParse(wire.due).data;
  const severity = wire.severity === null ? undefined : FIELD.severity.safeParse(wire.severity).data;
  const fields: BrainClaimFields = {
    ...(assignee === undefined ? {} : { assignee }),
    ...(due === undefined ? {} : { due }),
    ...(severity === undefined ? {} : { severity }),
  };
  return Object.keys(fields).length === 0 ? undefined : fields;
}
