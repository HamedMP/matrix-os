import { z } from "zod/v4";
import type { ScopeRuntimeBotInferenceRequest, ScopeRuntimeBrokerResponse } from "@matrix-os/scope-runtime/broker-protocol";
import { ScopeRuntimeBrokerResponseSchema } from "@matrix-os/scope-runtime/broker-protocol";
import type { ResolveCodexOwnerIdentity } from "../collaboration/codex-owner-identity.js";
import { discard, readBoundedBody, safeResponseHeaders } from "../collaboration/scope-runtime-broker.js";

export const CODEX_SUBSCRIPTION_URL = "https://chatgpt.com/backend-api/codex/responses";
const IdentitySchema = z.object({
  url: z.literal(CODEX_SUBSCRIPTION_URL),
  headers: z.object({
    authorization: z.string().regex(/^Bearer [^\r\n]+$/),
    "chatgpt-account-id": z.string().min(1).max(512).regex(/^[^\r\n]+$/),
  }).strict(),
}).strict();

/** Pi's Responses wire format, normalized to the subscription endpoint.
 * Credential bytes remain in the gateway; the worker uses a placeholder.
 */
export function codexSubscriptionBody(body: string): string {
  const value = JSON.parse(body) as Record<string, unknown>;
  const input = z.array(z.record(z.string(), z.unknown())).max(2048).parse(value.input);
  const instructions: string[] = [];
  const messages = input.filter((message) => {
    if (message.role !== "system" && message.role !== "developer") return true;
    const content = message.content;
    if (typeof content === "string") instructions.push(content);
    else for (const part of z.array(z.object({ type: z.literal("input_text"), text: z.string() })).parse(content)) instructions.push(part.text);
    return false;
  });
  // The subscription API rejects these ordinary Responses-only controls.
  const { max_output_tokens: _max, prompt_cache_retention: _retention, prompt_cache_options: _cache,
    temperature: _temperature, ...rest } = value;
  return JSON.stringify({ ...rest, store: false, stream: true, input: messages,
    instructions: instructions.join("\n\n") || (typeof value.instructions === "string" ? value.instructions : "You are a helpful assistant.") });
}

export async function forwardCodexBotInference(request: ScopeRuntimeBotInferenceRequest, options: {
  resolveIdentity: ResolveCodexOwnerIdentity;
  stillAuthorized(): boolean;
  signal: AbortSignal;
  fetchImpl: typeof fetch;
}): Promise<ScopeRuntimeBrokerResponse> {
  const fail = (error: "action_denied" | "provider_unavailable") =>
    ScopeRuntimeBrokerResponseSchema.parse({ version: 1, requestId: request.requestId, ok: false, error });
  const body = codexSubscriptionBody(request.body);
  const send = async (refresh = false): Promise<Response | "denied"> => {
    const identity = IdentitySchema.parse(await options.resolveIdentity(options.signal, refresh));
    if (!options.stillAuthorized()) return "denied";
    return options.fetchImpl(identity.url, { method: "POST", redirect: "error", signal: options.signal, body,
      headers: { ...identity.headers, originator: "codex_cli_rs", accept: "text/event-stream", "content-type": "application/json" } });
  };
  let response = await send();
  if (response !== "denied" && response.status === 401) {
    await discard(response);
    response = await send(true);
  }
  if (response === "denied") return fail("action_denied");
  if (!response.ok) {
    console.warn("[bots] Codex subscription request refused:", response.status);
    await discard(response);
    return fail("provider_unavailable");
  }
  return ScopeRuntimeBrokerResponseSchema.parse({ version: 1, requestId: request.requestId, ok: true,
    status: response.status, headers: safeResponseHeaders(response, "inference"), body: await readBoundedBody(response) });
}
