/**
 * The caller's signal through executeIntegrationAction, and the byte-capped raw Pipedream proxy read the Company Brain
 * local transport uses. A fake fetch stands in for Pipedream; no network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeIntegrationAction } from "../../packages/gateway/src/integrations/action-execution.js";
import { BoundedPipedreamReadError } from "../../packages/gateway/src/integrations/pipedream-bounded-get.js";
import {
  BoundedProxyStatusError, createBoundedPipedreamProxy, type BoundedProxyRequest,
} from "../../packages/gateway/src/integrations/pipedream-bounded-proxy.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";
import type { ServiceAction, ServiceDefinition } from "../../packages/gateway/src/integrations/types.js";

const DEF = { id: "github", pipedreamApp: "github", connectorKind: "pipedream", actions: {} } as unknown as ServiceDefinition;
const GET_ACTION: ServiceAction = {
  description: "List", risk: "read", params: {},
  directApi: {
    method: "GET", url: (p) => `https://api.github.com/repos/${String(p.repo)}/issues`,
    mapParams: (p) => ({ state: String(p.state) }), staticHeaders: { Accept: "application/vnd.github+json" },
  },
};
const POST_ACTION: ServiceAction = {
  description: "Query", risk: "read", params: {},
  directApi: { method: "POST", url: "https://api.linear.app/graphql", mapBody: (p) => ({ query: "q", variables: p }) },
};
const COMPONENT_ACTION: ServiceAction = { description: "Run", risk: "read", params: {}, componentKey: "github-list" };
const base = { externalUserId: "ext_1", connection: { pipedream_account_id: "apn_1" }, def: DEF, serviceId: "github" };
const request = (overrides: Partial<BoundedProxyRequest> = {}): BoundedProxyRequest => ({
  externalUserId: "ext_1", accountId: "apn_1", method: "GET", url: "https://api.github.com/repos/a/b/issues",
  params: { state: "all" }, maxBytes: 64, ...overrides,
});

function fakePipedream(extra: Partial<PipedreamConnectClient> = {}) {
  return {
    runAction: vi.fn(async () => ({ exports: {}, ret: "ran" })), proxyGet: vi.fn(async () => "sdk"),
    proxyPost: vi.fn(async () => "sdk"), boundedProxy: vi.fn(async () => ({ bounded: true })), ...extra,
  } as unknown as PipedreamConnectClient & Record<string, ReturnType<typeof vi.fn>>;
}

function chunked(chunks: readonly string[], cancel = vi.fn()): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(new TextEncoder().encode(chunks[index++]));
      else controller.close();
    },
    cancel,
  });
}

function proxy(respond: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const fetcher = vi.fn(async (url: string, init: RequestInit) => respond(new URL(url), init));
  const read = createBoundedPipedreamProxy({
    projectId: "proj_fixture", environment: "production", getAccessToken: async () => "synthetic-access-token", fetcher,
  });
  return { read, fetcher };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("executeIntegrationAction signal and byte cap", () => {
  it("passes the caller's signal to the SDK call and refuses one that already aborted", async () => {
    const pipedream = fakePipedream();
    const controller = new AbortController();
    await executeIntegrationAction({ ...base, pipedream, actionDef: GET_ACTION, actionId: "list", params: { repo: "a/b", state: "all" }, signal: controller.signal });
    expect(pipedream.proxyGet).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
    await executeIntegrationAction({ ...base, pipedream, actionDef: COMPONENT_ACTION, actionId: "run", signal: controller.signal });
    expect(pipedream.runAction).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
    controller.abort(new Error("stop"));
    await expect(executeIntegrationAction({ ...base, pipedream, actionDef: GET_ACTION, actionId: "list", signal: controller.signal }))
      .rejects.toThrow("stop");
    expect(pipedream.proxyGet).toHaveBeenCalledTimes(1);
  });

  it("reads a capped call through the raw proxy, GET with params and POST with the mapped body", async () => {
    const pipedream = fakePipedream();
    const signal = new AbortController().signal;
    expect(await executeIntegrationAction({
      ...base, pipedream, actionDef: GET_ACTION, actionId: "list", params: { repo: "a/b", state: "all" }, signal, maxResponseBytes: 99,
    })).toEqual({ data: { bounded: true } });
    expect(pipedream.boundedProxy).toHaveBeenLastCalledWith({
      externalUserId: "ext_1", accountId: "apn_1", method: "GET", url: "https://api.github.com/repos/a/b/issues",
      params: { state: "all" }, headers: { Accept: "application/vnd.github+json" }, maxBytes: 99,
    }, signal);
    await executeIntegrationAction({ ...base, pipedream, actionDef: POST_ACTION, actionId: "query", params: { a: 1 }, maxResponseBytes: 5 });
    expect(pipedream.boundedProxy).toHaveBeenLastCalledWith({
      externalUserId: "ext_1", accountId: "apn_1", method: "POST", url: "https://api.linear.app/graphql",
      body: { query: "q", variables: { a: 1 } }, maxBytes: 5,
    }, expect.any(AbortSignal));
    expect(pipedream.proxyGet).not.toHaveBeenCalled();
  });

  it("never buffers a capped call it cannot read raw", async () => {
    const put: ServiceAction = { ...GET_ACTION, directApi: { method: "PUT", url: "https://api.github.com/x" } };
    for (const [pipedream, actionDef] of [
      [fakePipedream({ boundedProxy: undefined }), GET_ACTION], [fakePipedream(), COMPONENT_ACTION], [fakePipedream(), put],
    ] as const) {
      await expect(executeIntegrationAction({ ...base, pipedream, actionDef, actionId: "x", maxResponseBytes: 10 }))
        .rejects.toBeInstanceOf(BoundedPipedreamReadError);
      expect(pipedream.proxyGet).not.toHaveBeenCalled();
      expect(pipedream.runAction).not.toHaveBeenCalled();
    }
  });
});

describe("createBoundedPipedreamProxy", () => {
  it("sends one proxy request with the account, environment and prefixed registry headers, and parses JSON", async () => {
    const { read, fetcher } = proxy(() => Response.json({ items: [1] }));
    expect(await read(request({ headers: { Accept: "application/vnd.github+json" } }), new AbortController().signal))
      .toEqual({ items: [1] });
    const [rawUrl, init] = fetcher.mock.calls[0]!;
    const url = new URL(rawUrl);
    expect(url.origin + url.pathname.split("/proxy/")[0]).toBe("https://api.pipedream.com/v1/connect/proj_fixture");
    expect(Buffer.from(url.pathname.split("/proxy/")[1]!, "base64url").toString()).toBe("https://api.github.com/repos/a/b/issues?state=all");
    expect([url.searchParams.get("external_user_id"), url.searchParams.get("account_id")]).toEqual(["ext_1", "apn_1"]);
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer synthetic-access-token");
    expect(headers.get("x-pd-environment")).toBe("production");
    expect(headers.get("x-pd-proxy-accept")).toBe("application/vnd.github+json");
    expect(init).toMatchObject({ method: "GET", redirect: "error" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("posts a JSON body, returns text bodies as strings and an empty body as null", async () => {
    const target = (url: URL) => Buffer.from(url.pathname.split("/proxy/")[1]!, "base64url").toString();
    const { read, fetcher } = proxy((url) => target(url).startsWith("https://www.googleapis.com/a?")
      ? new Response("plain words", { headers: { "content-type": "text/plain; charset=utf-8" } })
      : new Response(null, { status: 204 }));
    const google = (name: string) => `https://www.googleapis.com/${name}`;
    expect(await read(request({ method: "POST", url: google("a"), body: { q: 1 } }), new AbortController().signal)).toBe("plain words");
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: "POST", body: '{"q":1}' });
    expect(new Headers(fetcher.mock.calls[0]![1].headers).get("content-type")).toBe("application/json");
    expect(await read(request({ url: google("b") }), new AbortController().signal)).toBeNull();
  });

  it("stops at the byte cap by length or while reading, and refuses bodies it cannot decode", async () => {
    const cancel = vi.fn();
    const cases: [Response, string][] = [
      [new Response("{}", { headers: { "content-length": "65" } }), "declared length"],
      [new Response("{}", { headers: { "content-length": "x" } }), "malformed length"],
      [new Response(chunked(["[" + "1,".repeat(20), "1,".repeat(20), "1,".repeat(20), "1,".repeat(20), "1]"], cancel)), "read in chunks"],
      [new Response("<html/>", { headers: { "content-type": "application/octet-stream" } }), "binary"],
      [new Response(new Uint8Array([0xff, 0xfe])), "bad utf-8"],
    ];
    for (const [response, label] of cases) {
      await expect(proxy(() => response).read(request(), new AbortController().signal), label).rejects.toThrow();
    }
    expect(cancel).toHaveBeenCalled();
  });

  it("throws the status and rate-limit headers of a provider error, never its text", async () => {
    const answer = (status: number, body: string, headers: Record<string, string> = {}) =>
      proxy(() => new Response(body, { status, headers })).read(request(), new AbortController().signal);
    const limited = await answer(403, '{"message":"You have exceeded a secondary rate limit"}', { "x-ratelimit-remaining": "0" })
      .catch((error: unknown) => error);
    expect(limited).toBeInstanceOf(BoundedProxyStatusError);
    expect(limited).toMatchObject({ statusCode: 403, body: { message: "rate limit" } });
    expect((limited as BoundedProxyStatusError).headers.get("x-ratelimit-remaining")).toBe("0");
    const denied = await answer(403, '{"message":"Bad credentials /home/secret"}').catch((error: unknown) => error);
    expect(denied).toMatchObject({ statusCode: 403, body: null });
    expect(JSON.stringify(denied) + String(denied)).not.toContain("secret");
    const slow = await answer(429, "slow down", { "retry-after": "12", "x-other": "1" }).catch((error: unknown) => error);
    expect([...(slow as BoundedProxyStatusError).headers.keys()]).toEqual(["retry-after"]);
  });

  it("aborts the request and the token wait with the caller's signal, and refuses bad requests before any call", async () => {
    let seen: AbortSignal | null = null;
    const { read, fetcher } = proxy((_url, init) => {
      seen = init.signal ?? null;
      return new Promise<Response>(() => undefined);
    });
    const controller = new AbortController();
    const pending = read(request(), controller.signal);
    await vi.waitFor(() => expect(seen).not.toBeNull());
    controller.abort(new Error("stop"));
    await expect(pending).rejects.toThrow("stop");
    expect(seen!.aborted).toBe(true);
    const slowToken = createBoundedPipedreamProxy({
      projectId: "proj_fixture", environment: "production", getAccessToken: () => new Promise(() => undefined), fetcher,
    });
    const tokenWait = new AbortController();
    const waiting = slowToken(request(), tokenWait.signal);
    tokenWait.abort(new Error("token stop"));
    await expect(waiting).rejects.toThrow("token stop");
    for (const bad of [
      { url: "http://api.github.com/x" }, { url: "https://user:pw@api.github.com/x" }, { method: "DELETE" },
      { maxBytes: 0 }, { headers: { "bad header": "x" } }, { accountId: "../x" },
    ]) await expect(read(request(bad as Partial<BoundedProxyRequest>), new AbortController().signal)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
