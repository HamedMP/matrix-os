import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { buildProxyApiKey } from "../../packages/proxy/src/auth.js";
import { createFundedRelay, resolveFundedRelayConfig } from "../../packages/proxy/src/funded-relay.js";
import { estimateWorstCaseMicrousd, mapFundedModel } from "../../packages/proxy/src/funded-relay-model.js";
import { boundedBody } from "../../packages/proxy/src/funded-relay-stream.js";

const GATEWAY_TOKEN = "cloudflare-unified-billing-token-123456789";
const RELAY_TOKEN = "platform-relay-control-token-123456789";
const METADATA_SECRET = "metadata-hmac-secret-123456789012345";
const GATEWAY_URL =
  "https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/matrix/anthropic";
const PLATFORM_URL = "https://platform.internal.example";
const NATIVE_MODEL = "claude-sonnet-5";
const CANONICAL_MODEL = "anthropic/claude-sonnet-5";
const CREDENTIAL = `sk-matrix-funded-credential_123.${"s".repeat(43)}`;
const NOW = new Date("2026-08-30T20:00:00.000Z");

function enabledEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    MATRIX_FUNDED_AI_ENABLED: "1",
    MATRIX_FUNDED_AI_BETAS: "context-1m-2025-08-07",
    CLOUDFLARE_AI_GATEWAY_URL: GATEWAY_URL,
    CLOUDFLARE_AI_GATEWAY_TOKEN: GATEWAY_TOKEN,
    PLATFORM_INTERNAL_URL: PLATFORM_URL,
    AI_RELAY_CONTROL_TOKEN: RELAY_TOKEN,
    AI_RELAY_METADATA_SECRET: METADATA_SECRET,
    ...overrides,
  };
}

function requestBody(input: { maxTokens?: number; model?: string; stream?: boolean } = {}): string {
  return JSON.stringify({
    model: input.model ?? NATIVE_MODEL,
    max_tokens: input.maxTokens ?? 100,
    stream: input.stream ?? false,
    messages: [{ role: "user", content: "hello" }],
  });
}

function policy() {
  return {
    enabled: true, globalRevision: 2, runtimeRevision: 3,
    allowedModelIds: [CANONICAL_MODEL], monthlyBudgetMicrousd: 100_000,
    checkedAt: NOW.toISOString(), staleAfter: "2026-08-30T20:01:00.000Z",
  };
}

function identity() {
  return {
    tokenId: "credential_123", ownerId: "user_alice", machineId: "machine_123", runtimeSlot: "primary",
    audience: "matrix-funded-relay", scope: "ai:invoke", expiresAt: "2026-08-30T20:15:00.000Z",
  };
}

function checkResponse() {
  return { contractVersion: 1, authorized: true, identity: identity(), policy: policy() };
}

function authorizationResponse(requestId: string, reservationId = "reservation_123") {
  return {
    contractVersion: 1, authorized: true, identity: identity(), policy: policy(),
    funding: {
      asOf: NOW.toISOString(), periodStart: "2026-08-01T00:00:00.000Z", monthlyBudgetMicrousd: 100_000,
      settledThisMonthMicrousd: 0, reservedMicrousd: 3_600, reservedThisMonthMicrousd: 3_600,
      promotionalBalanceMicrousd: 100_000, addonBalanceMicrousd: 0, creditBalanceMicrousd: 100_000,
      remainingBalanceMicrousd: 96_400, remainingBudgetMicrousd: 96_400,
    },
    reservation: {
      reservationId, requestId, modelId: CANONICAL_MODEL, reservedMicrousd: 3_600,
      remainingBalanceMicrousd: 96_400, remainingBudgetMicrousd: 96_400,
      periodStart: "2026-08-01T00:00:00.000Z", expiresAt: "2026-08-30T20:05:00.000Z", status: "reserved",
    },
  };
}

function startResponse(requestId: string, reservationId = "reservation_123") {
  return {
    contractVersion: 1, reservationId, requestId, tokenId: "credential_123",
    startedAt: NOW.toISOString(), expiresAt: "2026-08-30T20:30:00.000Z", status: "in_flight",
  };
}

function finalizationResponse(input: {
  requestId: string;
  reservationId?: string;
  actualCostMicrousd: number;
  finalizationMode: "exact" | "conservative";
}) {
  return {
    contractVersion: 1,
    reservationId: input.reservationId ?? "reservation_123",
    requestId: input.requestId,
    tokenId: "credential_123",
    actualCostMicrousd: input.actualCostMicrousd,
    releasedMicrousd: 3_600 - input.actualCostMicrousd,
    remainingBalanceMicrousd: 96_400,
    remainingBudgetMicrousd: 96_400,
    funding: authorizationResponse(input.requestId).funding,
    settledAt: NOW.toISOString(),
    status: "settled",
    finalizationMode: input.finalizationMode,
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function configuredRelay(fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}) {
  const config = resolveFundedRelayConfig(enabledEnv());
  expect(config).not.toBeNull();
  return createFundedRelay({
    ...config!, fetch: fetchImpl, now: () => NOW, requestIdFactory: () => "request_123", ...overrides,
  });
}

function fundedRequest(body = requestBody(), headers: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": CREDENTIAL, ...headers },
    body,
  };
}

describe("funded relay configuration and pricing", () => {
  it("stays disabled by default and fails closed without distinct dedicated authority", () => {
    expect(resolveFundedRelayConfig({})).toBeNull();
    expect(resolveFundedRelayConfig({ MATRIX_FUNDED_AI_ENABLED: "0" })).toBeNull();
    expect(() => resolveFundedRelayConfig({ MATRIX_FUNDED_AI_ENABLED: "1" }))
      .toThrow("CLOUDFLARE_AI_GATEWAY_URL");
    expect(() => resolveFundedRelayConfig(enabledEnv({ AI_RELAY_METADATA_SECRET: RELAY_TOKEN })))
      .toThrow(/distinct/i);
    expect(resolveFundedRelayConfig(enabledEnv())).toMatchObject({
      gatewayBaseUrl: GATEWAY_URL, platformBaseUrl: PLATFORM_URL,
      gatewayToken: GATEWAY_TOKEN, relayControlToken: RELAY_TOKEN, metadataSecret: METADATA_SECRET,
    });
  });

  it("maps exactly Sonnet 5 and prices only a current version with integer safety margin", () => {
    expect(mapFundedModel(NATIVE_MODEL)).toEqual({
      nativeModelId: NATIVE_MODEL, canonicalModelId: CANONICAL_MODEL,
    });
    for (const model of [CANONICAL_MODEL, "claude-sonnet-5-20260829", "claude-opus-5", "sonnet"]) {
      expect(() => mapFundedModel(model)).toThrow(/model/i);
    }
    expect(estimateWorstCaseMicrousd({
      canonicalModelId: CANONICAL_MODEL, inputTokens: 1_000, maxOutputTokens: 100, now: NOW,
    })).toMatchObject({ amountMicrousd: 3_600, pricingVersion: "anthropic-2026-08-29" });
    expect(() => estimateWorstCaseMicrousd({
      canonicalModelId: CANONICAL_MODEL, inputTokens: 1, maxOutputTokens: 1,
      now: new Date("2026-09-01T00:00:00.000Z"),
    })).toThrow(/expired/i);
    expect(() => estimateWorstCaseMicrousd({
      canonicalModelId: "anthropic/unknown", inputTokens: 1, maxOutputTokens: 1, now: NOW,
    })).toThrow(/pricing/i);
  });
});

describe("Cloudflare funded relay control-plane ordering", () => {
  it("checks policy, counts, reserves, acquires, starts, then generates with five opaque metadata fields", async () => {
    const events: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (url.startsWith(PLATFORM_URL)) {
        expect(headers.get("authorization")).toBe(`Bearer ${RELAY_TOKEN}`);
        const action = url.slice(`${PLATFORM_URL}/internal/ai/funded/`.length);
        events.push(action);
        const body = JSON.parse(String(init?.body));
        if (action === "check") {
          expect(body).toEqual({ credential: CREDENTIAL, modelId: CANONICAL_MODEL });
          return json(checkResponse());
        }
        if (action === "authorize") {
          expect(body).toEqual({
            credential: CREDENTIAL, requestId: "request_123",
            modelId: CANONICAL_MODEL, maxCostMicrousd: 3_600,
          });
          return json(authorizationResponse("request_123"));
        }
        if (action === "start") {
          expect(body).toEqual({ reservationId: "reservation_123", tokenId: "credential_123" });
          return json(startResponse("request_123"));
        }
        if (action === "finalize") {
          expect(body).toEqual({
            reservationId: "reservation_123",
            tokenId: "credential_123",
            mode: "exact",
            actualCostMicrousd: 2_100,
          });
          return json(finalizationResponse({
            requestId: "request_123", actualCostMicrousd: 2_100, finalizationMode: "exact",
          }));
        }
        throw new Error(`unexpected platform action ${action}`);
      }

      expect(headers.get("x-api-key")).toBeNull();
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("cf-aig-api-token")).toBeNull();
      expect(headers.get("cf-aig-authorization")).toBe(`Bearer ${GATEWAY_TOKEN}`);
      expect(headers.get("cf-aig-collect-log-payload")).toBe("false");
      expect(headers.get("cf-aig-zdr")).toBe("true");
      const metadata = JSON.parse(headers.get("cf-aig-metadata") ?? "{}");
      expect(Object.keys(metadata).sort()).toEqual([
        "access_source", "matrix_user_ref", "model_ref", "run_ref", "runtime_ref",
      ]);
      expect(Object.values(metadata).every((value) => ["string", "number", "boolean"].includes(typeof value)))
        .toBe(true);
      expect(JSON.stringify(metadata)).not.toContain("user_alice");
      expect(JSON.stringify(metadata)).not.toContain("machine_123");
      const forwarded = JSON.parse(String(init?.body));
      expect(forwarded).not.toHaveProperty("metadata");
      if (url.endsWith("/v1/messages/count_tokens")) {
        expect(forwarded).not.toHaveProperty("max_tokens");
        expect(forwarded).not.toHaveProperty("stream");
        events.push("cloudflare_count");
        return json({ input_tokens: 1_000 });
      }
      expect(forwarded.max_tokens).toBe(100);
      events.push("cloudflare_generate");
      return json({
        id: "msg_1", type: "message", model: NATIVE_MODEL,
        usage: { input_tokens: 1_000, output_tokens: 10 },
      });
    });
    const relay = configuredRelay(fetchMock as typeof fetch);
    const app = new Hono();
    relay.register(app);
    const bodyWithCallerMetadata = JSON.stringify({
      ...JSON.parse(requestBody()),
      metadata: { user_id: "raw-caller-id" },
    });
    const response = await app.request("/v1/messages", fundedRequest(bodyWithCallerMetadata, {
      authorization: "Bearer caller-secret",
      "cf-aig-authorization": "Bearer caller-cloudflare",
      "cf-aig-api-token": "caller-token",
      "cf-aig-metadata": JSON.stringify({ prompt: "secret" }),
      "x-matrix-user": "mallory",
    }));
    expect(response.status).toBe(200);
    await response.text();
    await vi.waitFor(() => expect(events).toContain("finalize"));
    expect(events).toEqual(["check", "cloudflare_count", "authorize", "start", "cloudflare_generate", "finalize"]);
    await relay.close();
  });

  it("uses a zero-cost policy check for count_tokens without reserving or starting", async () => {
    const events: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/check")) { events.push("check"); return json(checkResponse()); }
      if (url.endsWith("/v1/messages/count_tokens")) {
        events.push("cloudflare_count");
        return json({ input_tokens: 42 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const relay = configuredRelay(fetchMock as typeof fetch);
    const app = new Hono();
    relay.register(app);
    const response = await app.request(
      "/v1/messages/count_tokens",
      fundedRequest(JSON.stringify({ model: NATIVE_MODEL, messages: [{ role: "user", content: "hello" }] })),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ input_tokens: 42 });
    expect(events).toEqual(["check", "cloudflare_count"]);
    await relay.close();
  });

  it("never reaches Cloudflare when platform policy denies an opaque or legacy credential", async () => {
    const cloudflareFetch = vi.fn();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith(PLATFORM_URL)) {
        return json({ error: { code: "unauthorized", message: "Unauthorized" } }, 401);
      }
      cloudflareFetch();
      return json({ id: "must_not_happen" });
    });
    const relay = configuredRelay(fetchMock as typeof fetch);
    const app = new Hono();
    relay.register(app);
    expect((await app.request("/v1/messages", fundedRequest())).status).toBe(401);
    const legacySignature = createHmac("sha256", "old-shared-secret")
      .update("funded-proxy:alice").digest("base64url");
    const legacy = await app.request("/v1/messages", fundedRequest(requestBody(), {
      "x-api-key": `sk-matrix-funded-alice.${legacySignature}`,
    }));
    expect(legacy.status).toBe(401);
    expect(cloudflareFetch).not.toHaveBeenCalled();
    await relay.close();
  });

  it("times out platform checks without contacting Cloudflare", async () => {
    const cloudflareFetch = vi.fn();
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).startsWith(PLATFORM_URL)) {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }
      cloudflareFetch();
      return json({});
    });
    const relay = configuredRelay(fetchMock as typeof fetch, { platformTimeoutMs: 20 });
    const app = new Hono();
    relay.register(app);
    expect((await app.request("/v1/messages", fundedRequest())).status).toBe(503);
    expect(cloudflareFetch).not.toHaveBeenCalled();
    await relay.close();
  });

  it("does not start or generate when reservation authorization denies after counting", async () => {
    const events: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/check")) { events.push("check"); return json(checkResponse()); }
      if (url.endsWith("/v1/messages/count_tokens")) {
        events.push("cloudflare_count");
        return json({ input_tokens: 1_000 });
      }
      if (url.endsWith("/authorize")) {
        events.push("authorize_denied");
        return json({ error: { code: "budget_exceeded", message: "Monthly AI budget reached" } }, 403);
      }
      events.push("unexpected_upstream");
      return json({});
    });
    const relay = configuredRelay(fetchMock as typeof fetch);
    const app = new Hono();
    relay.register(app);
    expect((await app.request("/v1/messages", fundedRequest())).status).toBe(403);
    expect(events).toEqual(["check", "cloudflare_count", "authorize_denied"]);
    await relay.close();
  });

  it("rejects unsupported models before platform or Cloudflare calls", async () => {
    const fetchMock = vi.fn();
    const relay = configuredRelay(fetchMock as typeof fetch);
    const app = new Hono();
    relay.register(app);
    const response = await app.request("/v1/messages", fundedRequest(requestBody({ model: "claude-opus-5" })));
    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    await relay.close();
  });

  it("times out bounded token counting and does not reserve or generate", async () => {
    const events: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/check")) { events.push("check"); return json(checkResponse()); }
      events.push("cloudflare_count");
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    const relay = configuredRelay(fetchMock as typeof fetch, { countTokensTimeoutMs: 20 });
    const app = new Hono();
    relay.register(app);
    const response = await app.request("/v1/messages", fundedRequest());
    expect(response.status).toBe(504);
    expect(events).toEqual(["check", "cloudflare_count"]);
    await relay.close();
  });

  it("fails closed on expired pricing after count and before reserve or generation", async () => {
    const events: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/check")) { events.push("check"); return json(checkResponse()); }
      if (url.endsWith("/v1/messages/count_tokens")) {
        events.push("cloudflare_count");
        return json({ input_tokens: 10 });
      }
      events.push("unexpected");
      return json({});
    });
    const relay = configuredRelay(fetchMock as typeof fetch, {
      now: () => new Date("2026-09-01T00:00:00.000Z"),
    });
    const app = new Hono();
    relay.register(app);
    const response = await app.request("/v1/messages", fundedRequest());
    expect(response.status).toBe(503);
    expect(events).toEqual(["check", "cloudflare_count"]);
    await relay.close();
  });

  it("releases only a definitive resource denial before start", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let reservation = 0;
    const events: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/check")) return json(checkResponse());
      if (url.endsWith("/v1/messages/count_tokens")) return json({ input_tokens: 1_000 });
      if (url.endsWith("/authorize")) {
        reservation += 1;
        const requestId = JSON.parse(String(init?.body)).requestId as string;
        return json(authorizationResponse(requestId, `reservation_${reservation}`));
      }
      if (url.endsWith("/start")) {
        const body = JSON.parse(String(init?.body));
        events.push(`start:${body.reservationId}`);
        return json(startResponse("request_1", body.reservationId));
      }
      if (url.endsWith("/release")) {
        const body = JSON.parse(String(init?.body));
        events.push(`release:${body.reservationId}:${body.reason}`);
        return json({
          contractVersion: 1,
          reservationId: body.reservationId,
          requestId: "request_2",
          tokenId: "credential_123",
          releasedMicrousd: 3_600,
          releasedAt: NOW.toISOString(),
          reason: "pre_upstream_failure",
          status: "released",
          funding: authorizationResponse("request_2").funding,
        });
      }
      if (url.endsWith("/finalize")) {
        const body = JSON.parse(String(init?.body));
        events.push(`finalize:${body.reservationId}:${body.mode}`);
        return json(finalizationResponse({
          requestId: "request_1",
          reservationId: body.reservationId,
          actualCostMicrousd: 3_600,
          finalizationMode: "conservative",
        }));
      }
      events.push("generate");
      if (events.filter((event) => event === "generate").length === 1) await firstPending;
      return json({ id: "msg" });
    });
    let requestId = 0;
    const relay = configuredRelay(fetchMock as typeof fetch, {
      requestIdFactory: () => `request_${++requestId}`,
      runtimeConcurrency: 1,
      rateLimitPerMinute: 10,
    });
    const app = new Hono();
    relay.register(app);
    const first = app.request("/v1/messages", fundedRequest());
    await vi.waitFor(() => expect(events).toContain("generate"));
    const denied = await app.request("/v1/messages", fundedRequest());
    expect(denied.status).toBe(429);
    expect(events).toContain("release:reservation_2:pre_upstream_failure");
    expect(events).not.toContain("start:reservation_2");
    releaseFirst?.();
    await (await first).text();
    await relay.close();
  });

  it("never releases an in-flight reservation after generation fetch fails", async () => {
    const events: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/check")) return json(checkResponse());
      if (url.endsWith("/v1/messages/count_tokens")) return json({ input_tokens: 1_000 });
      if (url.endsWith("/authorize")) return json(authorizationResponse("request_123"));
      if (url.endsWith("/start")) { events.push("start"); return json(startResponse("request_123")); }
      if (url.endsWith("/release")) events.push("release");
      if (url.endsWith("/finalize")) {
        const body = JSON.parse(String(init?.body));
        events.push(`finalize:${body.mode}`);
        return json(finalizationResponse({
          requestId: "request_123", actualCostMicrousd: 3_600, finalizationMode: "conservative",
        }));
      }
      events.push("generation_failure");
      throw new Error(`private upstream failure ${String(init?.body).slice(0, 10)}`);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const relay = configuredRelay(fetchMock as typeof fetch);
    const app = new Hono();
    relay.register(app);
    const response = await app.request("/v1/messages", fundedRequest());
    expect(response.status).toBe(502);
    await vi.waitFor(() => expect(events).toContain("finalize:conservative"));
    expect(events).toEqual(["start", "generation_failure", "finalize:conservative"]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private upstream failure");
    await relay.close();
  });

  it("finalizes downstream-cancelled streams conservatively without release", async () => {
    const events: string[] = [];
    const upstreamCancel = vi.fn();
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/check")) return json(checkResponse());
      if (url.endsWith("/v1/messages/count_tokens")) return json({ input_tokens: 1_000 });
      if (url.endsWith("/authorize")) return json(authorizationResponse("request_123"));
      if (url.endsWith("/start")) { events.push("start"); return json(startResponse("request_123")); }
      if (url.endsWith("/release")) { events.push("release"); return json({}); }
      if (url.endsWith("/finalize")) {
        const body = JSON.parse(String(init?.body));
        events.push(`finalize:${body.mode}`);
        return json(finalizationResponse({
          requestId: "request_123", actualCostMicrousd: 3_600, finalizationMode: "conservative",
        }));
      }
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            "data: {\"type\":\"message_start\",\"message\":{\"model\":\"claude-sonnet-5\",\"usage\":{\"input_tokens\":1000}}}\n\n",
          ));
        },
        cancel: upstreamCancel,
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const relay = configuredRelay(fetchMock as typeof fetch);
    const app = new Hono();
    relay.register(app);
    const response = await app.request("/v1/messages", fundedRequest(requestBody({ stream: true })));
    expect(response.status).toBe(200);
    await response.body?.cancel("client disconnected");
    await vi.waitFor(() => expect(events).toContain("finalize:conservative"));
    expect(events).toEqual(["start", "finalize:conservative"]);
    expect(upstreamCancel).toHaveBeenCalled();
    await relay.close();
  });

  it("applies global admission before parsing", async () => {
    const fetchMock = vi.fn();
    const relay = configuredRelay(fetchMock as typeof fetch, { globalRateLimitPerMinute: 1 });
    const app = new Hono();
    relay.register(app);
    expect((await app.request("/v1/messages", fundedRequest("{not-json"))).status).toBe(400);
    expect((await app.request("/v1/messages", fundedRequest())).status).toBe(429);
    expect(fetchMock).not.toHaveBeenCalled();
    await relay.close();
  });

  it("holds global concurrency across policy checks and denies without another fetch", async () => {
    let finishCheck: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(async () => await new Promise<Response>((resolve) => {
      finishCheck = resolve;
    }));
    const relay = configuredRelay(fetchMock as typeof fetch, { globalConcurrency: 1 });
    const app = new Hono();
    relay.register(app);
    const first = app.request("/v1/messages", fundedRequest());
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect((await app.request("/v1/messages", fundedRequest())).status).toBe(429);
    expect(fetchMock).toHaveBeenCalledOnce();
    finishCheck?.(json({ error: { code: "unauthorized", message: "Unauthorized" } }, 401));
    expect((await first).status).toBe(401);
    await relay.close();
  });

  it("rejects invalid routes, queries, content types, and oversized bodies before fetch", async () => {
    const fetchMock = vi.fn();
    const relay = configuredRelay(fetchMock as typeof fetch, { maxBodyBytes: 128 });
    const app = new Hono();
    relay.register(app);
    expect((await app.request("/v1/complete", fundedRequest())).status).toBe(404);
    expect((await app.request("/v1/messages?debug=1", fundedRequest())).status).toBe(404);
    expect((await app.request("/v1/messages", {
      ...fundedRequest(), headers: { "content-type": "text/plain", "x-api-key": CREDENTIAL },
    })).status).toBe(415);
    expect((await app.request("/v1/messages", fundedRequest(requestBody({ maxTokens: 100 }) + " ".repeat(256)))).status)
      .toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
    await relay.close();
  });
});

describe("funded relay bounded resources", () => {
  it("cancels an upstream body when its lifetime already expired", async () => {
    const cancel = vi.fn();
    const body = boundedBody(
      new ReadableStream<Uint8Array>({ cancel }), 1_024,
      { release: vi.fn() }, vi.fn(),
      AbortSignal.abort(new DOMException("expired", "TimeoutError")),
    );
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    await body.cancel();
  });

  it("does not confuse legacy owner-funded proxy credentials with funded access", async () => {
    const app = new Hono();
    const relay = createFundedRelay(null);
    relay.register(app);
    app.all("/v1/*", (c) => c.json({ route: "legacy" }));
    const legacy = await app.request("/v1/messages", fundedRequest(requestBody(), {
      "x-api-key": buildProxyApiKey("alice", "shared-secret-with-enough-entropy"),
    }));
    expect(legacy.status).toBe(200);
    expect(await legacy.json()).toEqual({ route: "legacy" });
    expect((await app.request("/v1/messages", fundedRequest())).status).toBe(403);
    await relay.close();
  });
});
