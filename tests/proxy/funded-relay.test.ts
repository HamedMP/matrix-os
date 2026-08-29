import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { buildFundedProxyApiKey, buildProxyApiKey } from "../../packages/proxy/src/auth.js";
import {
  createFundedRelay,
  resolveFundedRelayConfig,
} from "../../packages/proxy/src/funded-relay.js";
import { boundedBody } from "../../packages/proxy/src/funded-relay-stream.js";

const SHARED_SECRET = "shared-secret-with-enough-entropy";
const GATEWAY_TOKEN = "cloudflare-gateway-token";
const GATEWAY_URL =
  "https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/matrix/anthropic";

function enabledEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    MATRIX_FUNDED_AI_ENABLED: "1",
    MATRIX_FUNDED_AI_MODELS: "claude-sonnet-5,claude-haiku-4-5",
    MATRIX_FUNDED_AI_BETAS: "context-1m-2025-08-07",
    CLOUDFLARE_AI_GATEWAY_URL: GATEWAY_URL,
    CLOUDFLARE_AI_GATEWAY_TOKEN: GATEWAY_TOKEN,
    PROXY_SHARED_SECRET: SHARED_SECRET,
    ...overrides,
  };
}

function requestBody(model = "claude-sonnet-5", stream = false): string {
  return JSON.stringify({
    model,
    max_tokens: 1024,
    stream,
    messages: [{ role: "user", content: "hello" }],
  });
}

describe("funded relay configuration", () => {
  it("stays disabled unless explicitly enabled", () => {
    expect(resolveFundedRelayConfig({})).toBeNull();
    expect(resolveFundedRelayConfig({ MATRIX_FUNDED_AI_ENABLED: "0" })).toBeNull();
  });

  it("fails closed when enabled configuration is incomplete", () => {
    expect(() => resolveFundedRelayConfig({ MATRIX_FUNDED_AI_ENABLED: "1" }))
      .toThrow("CLOUDFLARE_AI_GATEWAY_URL");
  });

  it("accepts only the fixed Cloudflare Anthropic gateway shape", () => {
    expect(resolveFundedRelayConfig(enabledEnv())).toMatchObject({
      gatewayBaseUrl: GATEWAY_URL,
      allowedModels: new Set(["claude-sonnet-5", "claude-haiku-4-5"]),
      gatewayToken: GATEWAY_TOKEN,
      sharedSecret: SHARED_SECRET,
      allowedBetas: new Set(["context-1m-2025-08-07"]),
      firstResponseTimeoutMs: 10_000,
    });

    expect(() => resolveFundedRelayConfig(enabledEnv({
      CLOUDFLARE_AI_GATEWAY_URL: "https://api.anthropic.com",
    }))).toThrow("CLOUDFLARE_AI_GATEWAY_URL");
  });
});

describe("Cloudflare funded relay", () => {
  it("cancels an upstream body when its lifetime already expired", async () => {
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({ cancel });
    const lifetime = AbortSignal.abort(new DOMException("expired", "TimeoutError"));
    const release = vi.fn();

    const body = boundedBody(source, 1_024, { release }, vi.fn(), lifetime);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(release).toHaveBeenCalledOnce();
    await body.cancel();
  });

  it("derives opaque metadata from runtime auth and strips caller credentials", async () => {
    const upstreamFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("x-api-key")).toBeNull();
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("cf-aig-authorization")).toBe(`Bearer ${GATEWAY_TOKEN}`);
      expect(headers.get("cf-aig-collect-log-payload")).toBe("false");
      expect(headers.get("cf-aig-zdr")).toBe("true");
      expect(JSON.parse(headers.get("cf-aig-metadata") ?? "{}")).toEqual({
        runtime_id: expect.not.stringContaining("alice"),
        access_source: "matrix_included",
      });
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify({ id: "msg_1", model: "claude-sonnet-5" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const config = resolveFundedRelayConfig(enabledEnv());
    expect(config).not.toBeNull();
    const relay = createFundedRelay({ ...config!, fetch: upstreamFetch as typeof fetch });
    const app = new Hono();
    relay.register(app);

    const response = await app.request("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": buildFundedProxyApiKey("alice", SHARED_SECRET),
        "x-matrix-user": "mallory",
        authorization: "Bearer attacker-controlled",
      },
      body: requestBody(),
    });

    expect(response.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledOnce();
    expect(String(upstreamFetch.mock.calls[0]?.[0])).toBe(`${GATEWAY_URL}/v1/messages`);
    relay.close();
  });

  it("does not fund raw provider keys, unsupported paths, models, or oversized bodies", async () => {
    const upstreamFetch = vi.fn();
    const config = resolveFundedRelayConfig(enabledEnv({
      MATRIX_FUNDED_AI_MAX_BODY_BYTES: "256",
    }));
    expect(config).not.toBeNull();
    const relay = createFundedRelay({ ...config!, fetch: upstreamFetch as typeof fetch });
    const app = new Hono();
    relay.register(app);
    const proxyKey = buildFundedProxyApiKey("alice", SHARED_SECRET);

    const rawKey = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "sk-ant-secret" },
      body: requestBody(),
    });
    expect(rawKey.status).toBe(404);

    const wrongPath = await app.request("/v1/complete", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": proxyKey },
      body: requestBody(),
    });
    expect(wrongPath.status).toBe(404);

    const queryString = await app.request("/v1/messages?target=attacker-controlled", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": proxyKey },
      body: requestBody(),
    });
    expect(queryString.status).toBe(404);

    const wrongModel = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": proxyKey },
      body: requestBody("claude-fable-5"),
    });
    expect(wrongModel.status).toBe(403);

    const oversizedBody = JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 1024,
      messages: [{ role: "user", content: "x".repeat(512) }],
    });
    const oversized = await app.request("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(oversizedBody.length),
        "x-api-key": proxyKey,
      },
      body: oversizedBody,
    });
    expect(oversized.status).toBe(413);
    expect(upstreamFetch).not.toHaveBeenCalled();
    relay.close();
  });

  it("aborts active upstream streams when the relay closes", async () => {
    let upstreamSignal: AbortSignal | undefined;
    const upstreamFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      upstreamSignal = init?.signal ?? undefined;
      return new Response(new ReadableStream<Uint8Array>({
        start() {
          // Intentionally remains open until relay shutdown aborts the request.
        },
      }), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const config = resolveFundedRelayConfig(enabledEnv());
    expect(config).not.toBeNull();
    const relay = createFundedRelay({ ...config!, fetch: upstreamFetch as typeof fetch });
    const app = new Hono();
    relay.register(app);

    const response = await app.request("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": buildFundedProxyApiKey("alice", SHARED_SECRET),
      },
      body: requestBody("claude-sonnet-5", true),
    });

    expect(response.status).toBe(200);
    expect(upstreamSignal?.aborted).toBe(false);
    relay.close();
    expect(upstreamSignal?.aborted).toBe(true);
    await response.body?.cancel();
  });

  it("releases admission when the total timeout fires after response headers", async () => {
    const upstreamFetch = vi.fn(async () => {
      if (upstreamFetch.mock.calls.length === 1) {
        return new Response(new ReadableStream<Uint8Array>({
          start() {
            // Simulate an upstream body that never produces bytes or closes.
          },
        }), {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response(JSON.stringify({ id: "msg_after_timeout" }), {
        headers: { "content-type": "application/json" },
      });
    });
    const config = resolveFundedRelayConfig(enabledEnv({
      MATRIX_FUNDED_AI_RUNTIME_CONCURRENCY: "1",
    }));
    expect(config).not.toBeNull();
    const relay = createFundedRelay({
      ...config!,
      fetch: upstreamFetch as typeof fetch,
      timeoutMs: 20,
    });
    const app = new Hono();
    relay.register(app);
    const headers = {
      "content-type": "application/json",
      "x-api-key": buildFundedProxyApiKey("alice", SHARED_SECRET),
    };

    const stalled = await app.request("/v1/messages", {
      method: "POST",
      headers,
      body: requestBody("claude-sonnet-5", true),
    });
    expect(stalled.status).toBe(200);

    const blocked = await app.request("/v1/messages", {
      method: "POST",
      headers,
      body: requestBody(),
    });
    expect(blocked.status).toBe(429);

    await new Promise((resolve) => setTimeout(resolve, 40));
    const admitted = await app.request("/v1/messages", {
      method: "POST",
      headers,
      body: requestBody(),
    });
    expect(admitted.status).toBe(200);
    await admitted.text();

    await stalled.body?.cancel();
    relay.close();
  });

  it("enforces per-runtime admission limits and maps upstream failures safely", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let releaseFirst: (() => void) | undefined;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const upstreamFetch = vi.fn(async () => {
      if (upstreamFetch.mock.calls.length === 1) {
        await firstPending;
        return new Response(JSON.stringify({ id: "msg_1" }), {
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error("secret upstream detail");
    });
    const config = resolveFundedRelayConfig(enabledEnv({
      MATRIX_FUNDED_AI_RUNTIME_CONCURRENCY: "1",
      MATRIX_FUNDED_AI_RATE_LIMIT: "2",
    }));
    expect(config).not.toBeNull();
    const relay = createFundedRelay({ ...config!, fetch: upstreamFetch as typeof fetch });
    const app = new Hono();
    relay.register(app);
    const headers = {
      "content-type": "application/json",
      "x-api-key": buildFundedProxyApiKey("alice", SHARED_SECRET),
    };

    const first = app.request("/v1/messages", { method: "POST", headers, body: requestBody() });
    await vi.waitFor(() => expect(upstreamFetch).toHaveBeenCalledTimes(1));
    const concurrent = await app.request("/v1/messages", {
      method: "POST",
      headers,
      body: requestBody(),
    });
    expect(concurrent.status).toBe(429);

    releaseFirst?.();
    await (await first).text();

    const failure = await app.request("/v1/messages", {
      method: "POST",
      headers,
      body: requestBody(),
    });
    expect(failure.status).toBe(502);
    expect(await failure.text()).not.toContain("secret upstream detail");

    const rateLimited = await app.request("/v1/messages", {
      method: "POST",
      headers,
      body: requestBody(),
    });
    expect(rateLimited.status).toBe(429);
    expect(upstreamFetch).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret upstream detail");
    warn.mockRestore();
    relay.close();
  });

  it("enforces a global minute budget across distinct runtimes", async () => {
    const upstreamFetch = vi.fn(async () => new Response(JSON.stringify({ id: "msg_1" }), {
      headers: { "content-type": "application/json" },
    }));
    const config = resolveFundedRelayConfig(enabledEnv({
      MATRIX_FUNDED_AI_GLOBAL_RATE_LIMIT: "2",
      MATRIX_FUNDED_AI_RATE_LIMIT: "10",
    }));
    expect(config).not.toBeNull();
    const relay = createFundedRelay({ ...config!, fetch: upstreamFetch as typeof fetch, now: () => 0 });
    const app = new Hono();
    relay.register(app);

    for (const handle of ["alice", "bobbb"]) {
      const response = await app.request("/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": buildFundedProxyApiKey(handle, SHARED_SECRET),
        },
        body: requestBody(),
      });
      expect(response.status).toBe(200);
      await response.text();
    }

    const limited = await app.request("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": buildFundedProxyApiKey("carol", SHARED_SECRET),
      },
      body: requestBody(),
    });
    expect(limited.status).toBe(429);
    expect(upstreamFetch).toHaveBeenCalledTimes(2);
    relay.close();
  });

  it("rejects funded credentials while disabled without falling through to legacy routing", async () => {
    const app = new Hono();
    const relay = createFundedRelay(null);
    relay.register(app);
    app.all("/v1/*", (c) => c.json({ route: "legacy" }));

    const funded = await app.request("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": buildFundedProxyApiKey("alice", SHARED_SECRET),
      },
      body: requestBody(),
    });
    expect(funded.status).toBe(403);
    expect(await funded.text()).not.toContain("legacy");

    const legacy = await app.request("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": buildProxyApiKey("alice", SHARED_SECRET),
      },
      body: requestBody(),
    });
    expect(legacy.status).toBe(200);
    expect(await legacy.json()).toEqual({ route: "legacy" });
    relay.close();
  });

  it("forwards only bounded allowlisted request fields and beta values", async () => {
    const upstreamFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "claude-sonnet-5",
        max_tokens: 1024,
        stream: false,
        messages: [{ role: "user", content: "hello" }],
        tools: [{ name: "lookup", description: "Lookup", input_schema: { type: "object" } }],
      });
      expect(new Headers(init?.headers).get("anthropic-beta"))
        .toBe("context-1m-2025-08-07");
      return new Response(JSON.stringify({ id: "msg_1" }), {
        headers: { "content-type": "application/json" },
      });
    });
    const config = resolveFundedRelayConfig(enabledEnv());
    expect(config).not.toBeNull();
    const relay = createFundedRelay({ ...config!, fetch: upstreamFetch as typeof fetch });
    const app = new Hono();
    relay.register(app);
    const headers = {
      "content-type": "application/json",
      "anthropic-beta": "context-1m-2025-08-07",
      "x-api-key": buildFundedProxyApiKey("alice", SHARED_SECRET),
    };

    const accepted = await app.request("/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 1024,
        stream: false,
        messages: [{ role: "user", content: "hello" }],
        tools: [{ name: "lookup", description: "Lookup", input_schema: { type: "object" } }],
      }),
    });
    expect(accepted.status).toBe(200);
    await accepted.text();

    for (const body of [
      { ...JSON.parse(requestBody()), service_tier: "priority_only" },
      {
        ...JSON.parse(requestBody()),
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      },
    ]) {
      const rejected = await app.request("/v1/messages", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      expect(rejected.status).toBe(400);
    }
    const rejectedBeta = await app.request("/v1/messages", {
      method: "POST",
      headers: { ...headers, "anthropic-beta": "unapproved-beta-2026-01-01" },
      body: requestBody(),
    });
    expect(rejectedBeta.status).toBe(400);
    expect(upstreamFetch).toHaveBeenCalledOnce();
    relay.close();
  });

  it("admits authenticated requests before parsing their bodies", async () => {
    const upstreamFetch = vi.fn(async () => new Response(JSON.stringify({ id: "unexpected" })));
    const config = resolveFundedRelayConfig(enabledEnv({ MATRIX_FUNDED_AI_RATE_LIMIT: "1" }));
    expect(config).not.toBeNull();
    const relay = createFundedRelay({ ...config!, fetch: upstreamFetch as typeof fetch });
    const app = new Hono();
    relay.register(app);
    const headers = {
      "content-type": "application/json",
      "x-api-key": buildFundedProxyApiKey("alice", SHARED_SECRET),
    };

    const malformed = await app.request("/v1/messages", {
      method: "POST",
      headers,
      body: "{not-json",
    });
    expect(malformed.status).toBe(400);

    const limited = await app.request("/v1/messages", {
      method: "POST",
      headers,
      body: requestBody(),
    });
    expect(limited.status).toBe(429);
    expect(upstreamFetch).not.toHaveBeenCalled();
    relay.close();
  });

  it("uses a short first-response deadline without shortening valid streams", async () => {
    const upstreamFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (upstreamFetch.mock.calls.length === 1) {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }
      return new Response(JSON.stringify({ id: "msg_after_timeout" }), {
        headers: { "content-type": "application/json" },
      });
    });
    const config = resolveFundedRelayConfig(enabledEnv({
      MATRIX_FUNDED_AI_RUNTIME_CONCURRENCY: "1",
    }));
    expect(config).not.toBeNull();
    const relay = createFundedRelay({
      ...config!,
      fetch: upstreamFetch as typeof fetch,
      firstResponseTimeoutMs: 20,
      timeoutMs: 1_000,
    });
    const app = new Hono();
    relay.register(app);
    const headers = {
      "content-type": "application/json",
      "x-api-key": buildFundedProxyApiKey("alice", SHARED_SECRET),
    };

    const timedOut = await app.request("/v1/messages", {
      method: "POST",
      headers,
      body: requestBody(),
    });
    expect(timedOut.status).toBe(504);

    const admitted = await app.request("/v1/messages", {
      method: "POST",
      headers,
      body: requestBody(),
    });
    expect(admitted.status).toBe(200);
    await admitted.text();
    relay.close();
  });

  it("caps count_tokens bodies independently from message bodies", async () => {
    const upstreamFetch = vi.fn();
    const config = resolveFundedRelayConfig(enabledEnv({
      MATRIX_FUNDED_AI_MAX_BODY_BYTES: String(2 * 1024 * 1024),
    }));
    expect(config).not.toBeNull();
    const relay = createFundedRelay({ ...config!, fetch: upstreamFetch as typeof fetch });
    const app = new Hono();
    relay.register(app);
    const body = JSON.stringify({
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "x".repeat(300 * 1024) }],
    });

    const response = await app.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(body.length),
        "x-api-key": buildFundedProxyApiKey("alice", SHARED_SECRET),
      },
      body,
    });
    expect(response.status).toBe(413);
    expect(upstreamFetch).not.toHaveBeenCalled();
    relay.close();
  });

  it("aborts oversized upstream responses and releases admission", async () => {
    let firstSignal: AbortSignal | undefined;
    const upstreamFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (upstreamFetch.mock.calls.length === 1) {
        firstSignal = init?.signal ?? undefined;
        return new Response(new Uint8Array(2_048), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ id: "msg_after_limit" }), {
        headers: { "content-type": "application/json" },
      });
    });
    const config = resolveFundedRelayConfig(enabledEnv({
      MATRIX_FUNDED_AI_RUNTIME_CONCURRENCY: "1",
    }));
    expect(config).not.toBeNull();
    const relay = createFundedRelay({
      ...config!,
      fetch: upstreamFetch as typeof fetch,
      maxResponseBytes: 1_024,
    });
    const app = new Hono();
    relay.register(app);
    const headers = {
      "content-type": "application/json",
      "x-api-key": buildFundedProxyApiKey("alice", SHARED_SECRET),
    };

    const oversized = await app.request("/v1/messages", {
      method: "POST",
      headers,
      body: requestBody(),
    });
    await expect(oversized.text()).rejects.toThrow("configured limit");
    expect(firstSignal?.aborted).toBe(true);

    const admitted = await app.request("/v1/messages", {
      method: "POST",
      headers,
      body: requestBody(),
    });
    expect(admitted.status).toBe(200);
    await admitted.text();
    relay.close();
  });
});
