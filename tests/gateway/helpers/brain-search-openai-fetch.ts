/** A fake fetch for the OpenAI embeddings endpoint: records each call and answers from a queue, else with success. */
import { fakeVector } from "./brain-search-fakes.js";

export interface OpenAiCall {
  readonly url: string; readonly init: RequestInit; readonly authorization: string | null;
  readonly body: { model: string; input: string[]; dimensions: number; encoding_format: string };
}
export type OpenAiReply = Response | Error | ((call: OpenAiCall) => Response | Promise<Response>);

/** Tokens the fake bills for one input. */
export const fakeTokens = (text: string): number => Math.ceil(text.length / 4);

/** A 200 answer: fakeVector of each input, data reversed (the provider must sort by index), tokens summed. */
export function openAiSuccess(
  texts: readonly string[], dimensions: number, override: { tokens?: number; data?: unknown } = {},
): Response {
  const data = texts.map((text, index) => ({ object: "embedding", index, embedding: fakeVector(text, dimensions) }));
  return Response.json({
    object: "list", model: "text-embedding-3-small", data: override.data ?? data.reverse(),
    usage: { prompt_tokens: 0, total_tokens: override.tokens ?? texts.reduce((sum, text) => sum + fakeTokens(text), 0) },
  });
}

/** An error answer with OpenAI's body shape; the message holds a key-like string that must never be logged. */
export function openAiError(status: number, code: string | null, headers: Record<string, string> = {}): Response {
  return Response.json({ error: { message: "Incorrect API key provided: sk-proj-****abcd", type: "invalid_request_error",
    param: null, code } }, { status, headers });
}

export function createOpenAiFetch(dimensions = 256) {
  const calls: OpenAiCall[] = [];
  const queue: OpenAiReply[] = [];
  const fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const call: OpenAiCall = {
      url: String(input), init, authorization: new Headers(init.headers).get("authorization"),
      body: JSON.parse(String(init.body)) as OpenAiCall["body"],
    };
    calls.push(call);
    const reply = queue.shift();
    if (reply === undefined) return openAiSuccess(call.body.input, dimensions);
    if (reply instanceof Error) throw reply;
    return typeof reply === "function" ? reply(call) : reply;
  };
  return { fetch: fetch as typeof globalThis.fetch, calls, queue };
}
