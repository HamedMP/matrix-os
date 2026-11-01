/**
 * A fake Anthropic Messages endpoint for the Company Brain model tests. It is injected as the SDK's fetch: every
 * request is recorded and answered locally, so no test reaches the network or holds a real key.
 */
import type { BrainModelFetch } from "../../../packages/gateway/src/brain/claims/model/types.js";

export const SYNTHETIC_KEY = "sk-ant-api03-synthetic-only";

/** body: the parsed JSON request body, typed loosely so tests can read nested request fields. */
export interface CapturedRequest {
  readonly url: string; readonly method: string; readonly headers: Headers; readonly body: any;
  readonly signal: AbortSignal | null; readonly redirect: RequestRedirect | undefined;
}

const USAGE = {
  input_tokens: 900, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
  cache_creation: null, iterations: null,
};

/** A 200 Messages body. Default content: an empty thinking block, then one text block with JSON {claims}. */
export function messageBody(options: {
  claims?: unknown[]; text?: string; content?: unknown[]; stopReason?: string; model?: string;
  usage?: Record<string, unknown>;
} = {}): Record<string, unknown> {
  const text = options.text ?? JSON.stringify({ claims: options.claims ?? [] });
  return {
    id: "msg_synthetic", type: "message", role: "assistant", model: options.model ?? "claude-opus-5-5",
    content: options.content ?? [{ type: "thinking", thinking: "", signature: "s" }, { type: "text", text }],
    stop_reason: options.stopReason ?? "end_turn", stop_sequence: null, stop_details: null,
    usage: { ...USAGE, ...options.usage },
  };
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** {type:"error",error:{type,message:"synthetic"}} with retry-after-ms "1" so SDK retries take 1 ms. */
export function errorResponse(status: number, type: string): Response {
  return jsonResponse(status, { type: "error", error: { type, message: "synthetic" } }, { "retry-after-ms": "1" });
}

/** "hang": a promise that rejects with DOMException("aborted","AbortError") when init.signal aborts. */
export function fakeAnthropic(
  handler: (request: CapturedRequest, call: number) => Response | Promise<Response> | "hang",
): { readonly fetch: BrainModelFetch; readonly requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const fetch: BrainModelFetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const signal = init?.signal ?? null;
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    const headers = new Headers(init?.headers);
    const request: CapturedRequest = { url, method: init?.method ?? "GET", headers, body, signal, redirect: init?.redirect };
    requests.push(request);
    const answer = await handler(request, requests.length);
    if (answer !== "hang") return answer;
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(new DOMException("aborted", "AbortError"));
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  };
  return { fetch, requests };
}
