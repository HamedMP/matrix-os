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
} from "@matrix-os/scope-runtime/broker-protocol";
import { z } from "zod/v4";
import type { FundedAdmissionQueue } from "../funded-ai/admission-queue.js";
import type { MatrixFundedCredentialProvider } from "../funded-ai-credential-manager.js";
import { buildKernelCredentialLaunch } from "../kernel-credentials.js";
import {
  discard,
  readBoundedBody,
  safeResponseHeaders,
  type ScopeRuntimeBrokerAuthorization,
} from "../collaboration/scope-runtime-broker.js";
import type { BotRuntimeBinding } from "./runtime-registry.js";

const INFERENCE_TIMEOUT_MS = 30_000;
export const MAX_BOT_TOOLS = 64;

const BotInferenceBodySchema = z.object({
  model: z.string().min(1).max(256),
  stream: z.literal(true),
  tools: z.array(z.unknown()).max(MAX_BOT_TOOLS).optional(),
}).passthrough();

export interface BotInferenceDependencies {
  homePath: string;
  lifetime: AbortSignal;
  fundedCredentialProvider?: MatrixFundedCredentialProvider;
  fundedAdmission?: FundedAdmissionQueue;
  resolveCredentials?: typeof buildKernelCredentialLaunch;
  fetchImpl?: typeof fetch;
}

function failure(
  requestId: string,
  error: "action_denied" | "invalid_request" | "provider_unavailable" | "response_too_large",
): ScopeRuntimeBrokerResponse {
  return ScopeRuntimeBrokerResponseSchema.parse({ version: 1, requestId, ok: false, error });
}

/**
 * Forwards one bot inference frame. `authorize` is consulted before the
 * first attempt and again before any funded retry, so a run whose binding
 * was released or changed never starts another paid request.
 */
export async function forwardBotInference(
  request: ScopeRuntimeBotInferenceRequest,
  binding: BotRuntimeBinding,
  authorize: (modelId: string) => ScopeRuntimeBrokerAuthorization,
  deps: BotInferenceDependencies,
): Promise<ScopeRuntimeBrokerResponse> {
  let modelId: string;
  try {
    modelId = BotInferenceBodySchema.parse(JSON.parse(request.body)).model;
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError) && !(error instanceof z.ZodError)) {
      console.warn("[bots] inference validation failed:", error instanceof Error ? error.name : "UnknownError");
    }
    return failure(request.requestId, "invalid_request");
  }
  const authorization = authorize(modelId);
  if (!authorization.allowed || !authorization.accessSourceId || !authorization.allowedModelIds.includes(modelId)) {
    return failure(request.requestId, "action_denied");
  }
  // No access source serves the OpenAI Responses API for bots yet; the route resolver never selects it.
  if (request.action === "inference.responses") return failure(request.requestId, "provider_unavailable");
  // Chat completions exist only on Matrix's managed route (the funded relay).
  if (request.action === "inference.chat_completions" && authorization.accessSourceId !== "matrix_included") {
    return failure(request.requestId, "provider_unavailable");
  }

  const accessSourceId = authorization.accessSourceId;
  const resolveCredentials = deps.resolveCredentials ?? buildKernelCredentialLaunch;
  const launch = await resolveCredentials(
    deps.homePath,
    process.env,
    accessSourceId,
    deps.fundedCredentialProvider,
    { requestClass: binding.requestClass, claimKey: request.runtimeHandle },
  );
  const env = launch.env;
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
  const funded = accessSourceId === "matrix_included" ? deps.fundedAdmission : undefined;
  if (accessSourceId === "matrix_included") headers.set("x-matrix-funded-claim-key", request.runtimeHandle);
  const deadline = AbortSignal.any([deps.lifetime, AbortSignal.timeout(INFERENCE_TIMEOUT_MS)]);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const send = () => fetchImpl(`${baseUrl}${request.path}`, {
    method: "POST",
    headers,
    body: request.body,
    redirect: "error",
    signal: deadline,
  });

  try {
    let attempts = 0;
    const response = funded
      ? await funded.run<Response | "denied">({ requestClass: binding.requestClass, signal: deadline }, async () => {
        attempts += 1;
        if (attempts > 1) {
          const current = authorize(modelId);
          if (!current.allowed || current.accessSourceId !== accessSourceId || !current.allowedModelIds.includes(modelId)) {
            return { kind: "done", value: "denied" };
          }
        }
        const attempt = await send();
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
      await discard(response);
      return failure(request.requestId, "provider_unavailable");
    }
    const body = await readBoundedBody(response);
    return ScopeRuntimeBrokerResponseSchema.parse({
      version: 1,
      requestId: request.requestId,
      ok: true,
      status: response.status,
      headers: safeResponseHeaders(response, "inference"),
      body,
    });
  } catch (error: unknown) {
    if (error instanceof RangeError && error.message === "response_too_large") return failure(request.requestId, "response_too_large");
    console.warn("[bots] inference forward failed:", error instanceof Error ? error.name : "UnknownError");
    return failure(request.requestId, "provider_unavailable");
  }
}
