import { validateBotImageInferenceBody, INFERENCE_RESPONSE_BODY_MAX_BYTES } from "@matrix-os/contracts";
/**
 * Model calls from bot workloads (spec 536, contracts/bot-broker-protocol.md).
 * The worker's loopback bridge sends each provider request as a broker frame;
 * the gateway injects the credential for the run's resolved access source
 * and forwards it. Unlike shared Chat, bot requests may carry tools (at most
 * 64): tool calls come back to the worker and every one of them is a
 * separately authorized `bot.tool` frame. Only the route's own model is used.
 */
import {
  ScopeRuntimeBrokerResponseSchema,
  type ScopeRuntimeBotInferenceRequest,
  type ScopeRuntimeBrokerResponse,
  type ScopeRuntimeBrokerResult,
} from "@matrix-os/scope-runtime/broker-protocol";
import { z } from "zod/v4";
import { boundedInferenceSseFrames, guardInferenceStream, inferenceResponseText } from "./inference-stream.js";
import { forwardChatGptPlanInference } from "./chatgpt-plan-inference.js";
import type { FundedAdmissionQueue } from "../funded-ai/admission-queue.js";
import { FundedAiCredentialError, type MatrixFundedCredentialProvider } from "../funded-ai-credential-manager.js";
import {
  buildKernelCredentialLaunch,
  type KernelCredentialAccessSourceId,
  type KernelCredentialLaunch,
  type KernelFundingContext,
} from "../kernel-credentials.js";
import type { ResolveCodexOwnerIdentity } from "../collaboration/codex-owner-identity.js";
import type { BotInferenceAuthorization } from "./credentials.js";
import {
  discard,
  readBoundedBody,
  safeResponseHeaders,
} from "../collaboration/scope-runtime-broker.js";
import { isManagedPiBinding, type PiRuntimeBinding } from "./runtime-registry.js";

const INFERENCE_TIMEOUT_MS = 30_000;
/** Funded relay generation may buffer the full reply; the worker bridge and
 * turn retain independent bounds and lifetime cancellation still applies. */
const FUNDED_INFERENCE_TIMEOUT_MS = 120_000;
export const MAX_BOT_TOOLS = 64;

/** Read-only authority checks cannot hold the inference broker or funded queue.
 * A late result is observed but never resumes the caller after cancellation or
 * the deadline. This does not release reservations or classify provider effects.
 */
const AUTHORIZATION_TIMEOUT_MS = 10_000;

function waitForInferenceAuthority<T>(operation: () => T | Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (value: T | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => finish(undefined);
    timer = setTimeout(onAbort, AUTHORIZATION_TIMEOUT_MS);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) { finish(undefined); return; }
    Promise.resolve().then(() => signal.aborted ? undefined : operation()).then(finish, (error: unknown) => {
      if (!settled) console.warn("[bots] inference authority unavailable:", error instanceof Error ? error.name : "UnknownError");
      finish(undefined);
    });
  });
}

const BotInferenceBodySchema = z.object({
  model: z.string().min(1).max(256),
  stream: z.literal(true),
  tools: z.array(z.unknown()).max(MAX_BOT_TOOLS).optional(),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
}).passthrough();

export interface BotInferenceDependencies {
  isolatedChat?: import("../chat/isolated-chat-envelope.js").IsolatedChatAuthority;
  homePath: string;
  chatgptPlan?: import("./chatgpt-plan.js").ChatGptPlanAuthority;
  matrixAnthropic?: import("./matrix-anthropic-api.js").MatrixAnthropicAuthority;
  lifetime: AbortSignal;
  /** Exact registry-owned run lifetime; combined with subsystem shutdown. */
  runSignal?: AbortSignal;
  fundedCredentialProvider?: MatrixFundedCredentialProvider;
  fundedAdmission?: FundedAdmissionQueue;
  resolveCredentials?: typeof buildKernelCredentialLaunch;
  /** Deprecated compatibility seam; it is never invoked by Bot inference. */
  resolveCodexIdentity?: ResolveCodexOwnerIdentity;
  fetchImpl?: typeof fetch;
  /** Canonical owner/run/workspace authority is rechecked after funded queue waits. */
  revalidateBinding?: (binding: PiRuntimeBinding) => Promise<boolean>;
  /** Gateway-only diagnostic bound to the registry's exact run; not a worker claim. */
  onFundedFailure?: (binding: PiRuntimeBinding, reason: "insufficient_credit" | "budget_exceeded" | undefined) => void;
}

/** Funding belongs to this gateway broker, never the isolated Pi worker or SDK. */
async function resolveInferenceCredentials(
  accessSourceId: KernelCredentialAccessSourceId,
  funding: KernelFundingContext,
  lifecycle: AbortSignal,
  deps: BotInferenceDependencies,
): Promise<KernelCredentialLaunch> {
  if (deps.resolveCredentials) {
    return deps.resolveCredentials(deps.homePath, process.env, accessSourceId, deps.fundedCredentialProvider, funding);
  }
  if (accessSourceId !== "matrix_included") {
    return buildKernelCredentialLaunch(deps.homePath, process.env, accessSourceId, deps.fundedCredentialProvider, funding);
  }
  if (!deps.fundedCredentialProvider?.enabled) throw new FundedAiCredentialError();
  const lease = await deps.fundedCredentialProvider.getCredential({ requestClass: funding.requestClass, signal: lifecycle });
  if (!lease.token || !lease.relayBaseUrl) throw new FundedAiCredentialError();
  // Do not inherit ambient or saved owner credentials into the funded request.
  return { env: { ANTHROPIC_AUTH_TOKEN: lease.token, ANTHROPIC_BASE_URL: lease.relayBaseUrl } };
}

function failure(
  requestId: string,
  error: "action_denied" | "invalid_request" | "provider_unavailable" | "response_too_large",
): ScopeRuntimeBrokerResponse {
  return ScopeRuntimeBrokerResponseSchema.parse({ version: 1, requestId, ok: false, error });
}

/** Settle owner waits on cancellation and ignore any late result. */
function awaitOwnerStreamResult<T>(pending: Promise<T>, signal: AbortSignal, discardLate?: (value: T) => Promise<void>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { signal.removeEventListener("abort", aborted); reject(signal.reason); };
    signal.addEventListener("abort", aborted, { once: true });
    pending.then(response => {
      signal.removeEventListener("abort", aborted);
      if (signal.aborted) {
        if (discardLate) void discardLate(response).catch(error => console.warn("[bots] late owner response cleanup failed:", error instanceof Error ? error.name : "UnknownError"));
        reject(signal.reason);
      } else resolve(response);
    }, error => { signal.removeEventListener("abort", aborted); reject(error); });
    if (signal.aborted) aborted();
  });
}

/**
 * Forwards one bot inference frame. `authorize` is consulted before every
 * send, including the first funded attempt after a queue wait, so a run whose
 * binding was released or changed never starts a paid request. The funded
 * queue bounds how long a request waits for capacity (two minutes for a
 * person in chat, ten for a routine); each send then has its own deadline.
 */
export function forwardBotInference(
  request: ScopeRuntimeBotInferenceRequest & { responseMode?: undefined }, binding: PiRuntimeBinding,
  authorize: (modelId: string) => BotInferenceAuthorization | Promise<BotInferenceAuthorization>, deps: BotInferenceDependencies,
): Promise<ScopeRuntimeBrokerResponse>;
export function forwardBotInference(
  request: ScopeRuntimeBotInferenceRequest, binding: PiRuntimeBinding,
  authorize: (modelId: string) => BotInferenceAuthorization | Promise<BotInferenceAuthorization>, deps: BotInferenceDependencies,
): Promise<ScopeRuntimeBrokerResult>;
export async function forwardBotInference(
  request: ScopeRuntimeBotInferenceRequest,
  binding: PiRuntimeBinding,
  authorize: (modelId: string) => BotInferenceAuthorization | Promise<BotInferenceAuthorization>,
  deps: BotInferenceDependencies,
): Promise<ScopeRuntimeBrokerResult> {
  let modelId: string;
  let parsedBody: z.infer<typeof BotInferenceBodySchema>;
  try {
    parsedBody = BotInferenceBodySchema.parse(JSON.parse(request.body));
    modelId = parsedBody.model;
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError) && !(error instanceof z.ZodError)) {
      console.warn("[bots] inference validation failed:", error instanceof Error ? error.name : "UnknownError");
    }
    return failure(request.requestId, "invalid_request");
  }
  const imageInput = validateBotImageInferenceBody(request.body);
  if (!imageInput.valid || (imageInput.imageCount > 0 && !binding.route.input.includes("image"))) return failure(request.requestId, "invalid_request");
  const isolated = deps.isolatedChat?.targets(binding) === true;
  if (isolated && !validIsolatedInference(request, binding)) return failure(request.requestId, "invalid_request");
  const lifecycle = deps.runSignal ? AbortSignal.any([deps.lifetime, deps.runSignal]) : deps.lifetime;
  const readAuthorization = () => waitForInferenceAuthority(() => authorize(modelId), lifecycle);
  const bindingValid = () => !deps.revalidateBinding ? Promise.resolve(true)
    : ownerStream ? deps.revalidateBinding(binding)
    : waitForInferenceAuthority(() => deps.revalidateBinding!(binding), lifecycle);
  const anthropicValid = (signal = lifecycle) => ownerStream ? deps.matrixAnthropic!.revalidate(binding, signal)
    : waitForInferenceAuthority(() => deps.matrixAnthropic!.revalidate(binding, signal), signal);
  if (lifecycle.aborted) return failure(request.requestId, "action_denied");
  const streamLifetime = new AbortController();
  const ownerStream = binding.accessSourceId === "owner_anthropic_key" && request.responseMode === "stream";
  const ownerSignal = ownerStream ? AbortSignal.any([lifecycle, streamLifetime.signal]) : lifecycle;
  // Each owner stage owns one timer; successful stages never spend a stream-wide deadline.
  const stage = async <T>(work: (signal: AbortSignal) => Promise<T>, signal = ownerSignal): Promise<T> => {
    if (!ownerStream) return work(signal);
    signal.throwIfAborted();
    const timer = setTimeout(() => streamLifetime.abort(new DOMException("Owner inference stage timed out", "TimeoutError")), INFERENCE_TIMEOUT_MS);
    timer.unref?.();
    try { return await awaitOwnerStreamResult(Promise.resolve().then(() => { signal.throwIfAborted(); return work(signal); }), signal); }
    finally { clearTimeout(timer); }
  };
  let authorization: BotInferenceAuthorization | undefined;
  try {
    if (await stage(bindingValid) !== true) return failure(request.requestId, "action_denied");
    if (ownerSignal.aborted) return failure(request.requestId, "action_denied");
    authorization = await stage(readAuthorization);
    if (binding.anthropicApi && (!deps.matrixAnthropic || binding.accessSourceId !== "owner_anthropic_key"
      || await stage(anthropicValid) !== true)) return failure(request.requestId, "action_denied");
  } catch (error: unknown) {
    if (!ownerStream) throw error;
    console.warn("[bots] owner inference setup failed:", error instanceof Error ? error.name : "UnknownError");
    return failure(request.requestId, lifecycle.aborted ? "action_denied" : "provider_unavailable");
  }
  if (!authorization?.allowed || !authorization.accessSourceId || !authorization?.allowedModelIds.includes(modelId)) {
    return failure(request.requestId, "action_denied");
  }
  if (authorization.accessSourceId === "matrix_chatgpt_plan") {
    if (!deps.chatgptPlan) return failure(request.requestId, "provider_unavailable");
    const authority = deps.chatgptPlan;
    return forwardChatGptPlanInference(request, binding, { authority: {
      ...authority,
      infer: (candidate, body, signal) => authority.infer(candidate, body, signal),
      ...(authority.inferStream ? { inferStream: (candidate: PiRuntimeBinding, body: string, signal: AbortSignal) => authority.inferStream!(candidate, body, signal) } : {}),
      revalidate: async (candidate, signal) => await waitForInferenceAuthority(async () =>
        (!deps.revalidateBinding || await deps.revalidateBinding(candidate))
          && !signal.aborted && await authority.revalidate(candidate, signal), signal) === true,
    }, signal: lifecycle,
      stillAuthorized: async () => { const current = await readAuthorization(); return !lifecycle.aborted && current?.allowed === true && current.accessSourceId === "matrix_chatgpt_plan" && current.allowedModelIds.includes(modelId); } });
  }
  // Borrowed native profiles remain task-executor-only; never substitute them for the explicit paired-device source.
  if (authorization.accessSourceId === "owner_openai_profile" || authorization.accessSourceId === "owner_anthropic_profile"
    || request.action === "inference.responses") return failure(request.requestId, "provider_unavailable");
  // Chat completions exist only on Matrix's managed route (the funded relay).
  if (request.action === "inference.chat_completions" && authorization.accessSourceId !== "matrix_included") {
    return failure(request.requestId, "provider_unavailable");
  }

  // The registry's resolved route is the output authority. Omission must not
  // let an upstream default widen it; preserve smaller explicit limits (for
  // example session summaries) and reject conflicting/oversized limits.
  if ((parsedBody.max_tokens !== undefined && parsedBody.max_completion_tokens !== undefined)
    || (request.action === "inference.messages" && parsedBody.max_completion_tokens !== undefined)) {
    return failure(request.requestId, "invalid_request");
  }
  const outputTokens = parsedBody.max_tokens ?? parsedBody.max_completion_tokens ?? binding.route.maxOutputTokens;
  if (outputTokens > binding.route.maxOutputTokens) return failure(request.requestId, "invalid_request");
  const inferenceBody = parsedBody.max_tokens === undefined && parsedBody.max_completion_tokens === undefined
    ? JSON.stringify({ ...parsedBody, max_tokens: outputTokens }) : request.body;

  const accessSourceId = authorization.accessSourceId;
  const stillAuthorized = async () => {
    if (lifecycle.aborted) return false;
    const current = await readAuthorization();
    if (!current?.allowed || current.accessSourceId !== accessSourceId || !current.allowedModelIds.includes(modelId)) return false;
    if (await bindingValid() !== true) return false;
    return !lifecycle.aborted;
  };
  const funded = !isolated && accessSourceId === "matrix_included" ? deps.fundedAdmission : undefined;
  const fetchImpl = deps.fetchImpl ?? fetch;

  try {
    if (isolated && (deps.isolatedChat!.validate && await waitForInferenceAuthority(() => deps.isolatedChat!.validate!(binding), lifecycle) !== true || lifecycle.aborted || !await stillAuthorized())) return failure(request.requestId, "action_denied");
    const launch = await stage<KernelCredentialLaunch>(async signal => binding.anthropicApi
      ? { env: { ANTHROPIC_API_KEY: await deps.matrixAnthropic!.credential(binding, signal) } }
      : resolveInferenceCredentials(accessSourceId, { requestClass: binding.requestClass, claimKey: request.runtimeHandle }, signal, deps));
    const env = launch.env;
    if (lifecycle.aborted) return failure(request.requestId, "action_denied");
    const apiKey = env?.ANTHROPIC_API_KEY;
    const authToken = env?.ANTHROPIC_AUTH_TOKEN;
    if ((!apiKey && !authToken) || (apiKey && authToken)) return failure(request.requestId, "provider_unavailable");
    const baseUrl = env?.ANTHROPIC_BASE_URL?.replace(/\/$/, "") ?? "https://api.anthropic.com";
    const headers = new Headers({ accept: "text/event-stream", "content-type": "application/json" });
    if (apiKey) headers.set("x-api-key", apiKey);
    if (authToken) headers.set("authorization", `Bearer ${authToken}`);
    if (request.action === "inference.messages") {
      for (const [name, value] of Object.entries(request.headers)) {
        if (value) headers.set(name, value);
      }
    }
    if (accessSourceId === "matrix_included") headers.set("x-matrix-funded-claim-key", request.runtimeHandle);
    // Returns "denied" instead of sending when the run lost its authorization.
    let responseSignal = lifecycle;
    const send = async (): Promise<Response | "denied"> => {
      const permitted = await stage(async signal => {
        if (binding.anthropicApi && await anthropicValid(signal) !== true) return false;
        if (await bindingValid() !== true) return false;
        if (signal.aborted || !await stillAuthorized()) return false;
        if (isolated && (!await deps.isolatedChat!.consume(binding) || signal.aborted || !await stillAuthorized())) return false;
        return true;
      });
      if (!permitted) return "denied";
      // Owner streams bound time-to-headers here; body reads have an independent idle limit.
      // Funded generation and legacy buffered requests keep their original absolute deadlines.
      let headersTimer: ReturnType<typeof setTimeout> | undefined;
      if (ownerStream) {
        responseSignal = AbortSignal.any([lifecycle, streamLifetime.signal]);
        headersTimer = setTimeout(() => streamLifetime.abort(new DOMException("Timed out", "TimeoutError")), INFERENCE_TIMEOUT_MS);
        headersTimer.unref?.();
      } else responseSignal = AbortSignal.any([lifecycle, streamLifetime.signal, AbortSignal.timeout(
        accessSourceId === "matrix_included" ? FUNDED_INFERENCE_TIMEOUT_MS : INFERENCE_TIMEOUT_MS,
      )]);
      try {
        const pending = fetchImpl(`${baseUrl}${request.path}`, {
          method: "POST", headers, body: inferenceBody, redirect: "error", signal: responseSignal,
        });
        return ownerStream ? await awaitOwnerStreamResult(pending, responseSignal, discard) : await pending;
      } finally { if (headersTimer !== undefined) clearTimeout(headersTimer); }
    };

    const response = funded
      ? await funded.run<Response | "denied">({ requestClass: binding.requestClass, signal: lifecycle }, async () => {
        const attempt = await send();
        if (attempt === "denied") return { kind: "done", value: "denied" };
        // Only a relay capacity refusal is safe to repeat; upstream provider 429s are final.
        if (attempt.status !== 429 || attempt.headers.get("x-matrix-funded-reason") === null) {
          return { kind: "done", value: attempt };
        }
        await discard(attempt);
        return { kind: "busy" };
      })
      : await send();
    if (response === "denied") return failure(request.requestId, "action_denied");
    if (!response.ok) {
      const reason = response.headers.get("x-matrix-funded-error");
      if (accessSourceId === "matrix_included" && await stillAuthorized()) {
        deps.onFundedFailure?.(binding, response.status === 403
          && (reason === "insufficient_credit" || reason === "budget_exceeded") ? reason : undefined);
      }
      await discard(response);
      return failure(request.requestId, "provider_unavailable");
    }
    if (request.responseMode === 'stream') {
      const authorized = () => stage(async signal => !signal.aborted && await stillAuthorized()
        && (!binding.anthropicApi || await anthropicValid(signal) === true)
        && (await bindingValid() === true) && !signal.aborted && await stillAuthorized(), responseSignal);
      let permitted: boolean;
      try { permitted = await authorized(); }
      catch (error: unknown) {
        if (ownerStream) { streamLifetime.abort(); void discard(response); }
        throw error;
      }
      if (!permitted) {
        streamLifetime.abort();
        if (ownerStream) void discard(response); else await discard(response);
        return failure(request.requestId, 'action_denied');
      }
      if (accessSourceId === 'matrix_included') deps.onFundedFailure?.(binding, undefined);
      return { version: 1, requestId: request.requestId, ok: true, status: response.status,
        headers: safeResponseHeaders(response, 'inference'),
        body: guardInferenceStream(boundedInferenceSseFrames(inferenceResponseText(response, responseSignal,
          accessSourceId === "owner_anthropic_key" ? INFERENCE_TIMEOUT_MS : undefined)), {
          signal: responseSignal, authorized, abort: () => streamLifetime.abort(),
        }) };
    }
    const body = await readBoundedBody(response, INFERENCE_RESPONSE_BODY_MAX_BYTES);
    if (binding.anthropicApi && (lifecycle.aborted || await anthropicValid() !== true
      || await bindingValid() !== true || !await stillAuthorized())) return failure(request.requestId, "action_denied");
    const result = ScopeRuntimeBrokerResponseSchema.parse({
      version: 1,
      requestId: request.requestId,
      ok: true,
      status: response.status,
      headers: safeResponseHeaders(response, "inference"),
      body,
    });
    if (accessSourceId === "matrix_included") deps.onFundedFailure?.(binding, undefined);
    return result;
  } catch (error: unknown) {
    if (accessSourceId === "matrix_included" && await stillAuthorized()) deps.onFundedFailure?.(binding, undefined);
    if (error instanceof RangeError && error.message === "response_too_large") return failure(request.requestId, "response_too_large");
    console.warn("[bots] inference forward failed:", error instanceof Error ? error.name : "UnknownError");
    return failure(request.requestId, "provider_unavailable");
  }
}


const IsolatedTextBlock = z.object({ type: z.literal("text"), text: z.string(),
  cache_control: z.object({ type: z.literal("ephemeral"), ttl: z.enum(["5m", "1h"]).optional() }).strict().optional() }).strict();
const IsolatedText = z.union([z.string(), z.array(IsolatedTextBlock).min(1).max(8)]);
const IsolatedInferenceSchema = z.object({
  model: z.string(), stream: z.literal(true),
  messages: z.array(z.object({ role: z.enum(["system", "developer", "user"]), content: IsolatedText }).strict()).min(1).max(4),
  system: IsolatedText.optional(),
  max_tokens: z.literal(256).optional(), max_completion_tokens: z.literal(256).optional(),
  tools: z.array(z.never()).max(0).optional(), tool_choice: z.literal("none").optional(),
  stream_options: z.object({ include_usage: z.literal(true) }).strict().optional(),
  reasoning_effort: z.literal("low").optional(), thinking: z.object({ type: z.literal("disabled") }).strict().optional(),
  temperature: z.number().min(0).max(2).optional(), top_p: z.number().min(0).max(1).optional(),
  n: z.literal(1).optional(), store: z.literal(false).optional(),
}).strict();
// Canonical Bot phases may reuse bounded text history. Ordinary managed phases
// retain the original empty-session wire contract.
const CanonicalIsolatedInferenceSchema = IsolatedInferenceSchema.extend({
  messages: z.array(z.object({ role: z.enum(["system", "developer", "user", "assistant"]), content: IsolatedText }).strict()).min(1).max(32),
});
function validIsolatedInference(request: ScopeRuntimeBotInferenceRequest, binding: PiRuntimeBinding): boolean {
  if (Buffer.byteLength(request.body, "utf8") > 131072 || binding.accessSourceId !== "matrix_included"
    || binding.route.maxOutputTokens !== 256) return false;
  try {
    const value = (isManagedPiBinding(binding) ? IsolatedInferenceSchema : CanonicalIsolatedInferenceSchema).safeParse(JSON.parse(request.body));
    if (!value.success || value.data.model !== binding.route.modelId
      || (value.data.max_tokens === undefined) === (value.data.max_completion_tokens === undefined)
      || value.data.messages.at(-1)?.role !== "user") return false;
    return binding.route.api === "anthropic-messages"
      ? request.action === "inference.messages" && request.path === "/v1/messages?beta=true"
        && value.data.max_tokens === 256 && value.data.max_completion_tokens === undefined
        && !value.data.stream_options && !value.data.reasoning_effort
      : binding.route.api === "openai-completions" && request.action === "inference.chat_completions"
        && request.path === "/v1/chat/completions" && value.data.system === undefined && value.data.thinking === undefined;
  } catch (error: unknown) {
    console.warn("[bots] Isolated inference refused:", error instanceof Error ? error.name : "UnknownError");
    return false;
  }
}
