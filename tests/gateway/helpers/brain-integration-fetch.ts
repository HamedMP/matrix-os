/** A scripted fetch for the Company Brain integration caller and GitHub REST client tests (no network). */

export interface FakeFetchCall { readonly url: string; readonly init: RequestInit }

/** A fetch that answers from a list of responses in order and records each request. */
export function fakeFetch(responses: (Response | Error | ((call: FakeFetchCall) => Response | Promise<Response>))[]) {
  const calls: FakeFetchCall[] = [];
  const impl = async (url: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const call = { url: String(url), init };
    calls.push(call);
    const next = responses.shift();
    if (next === undefined) throw new Error("unexpected fetch");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(call) : next;
  };
  return { fetch: impl as typeof fetch, calls };
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
