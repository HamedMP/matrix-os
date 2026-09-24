import {
  JEV_EMAIL_TRIAGE_INSTRUCTIONS,
  JEV_MODEL_ID,
} from "@matrix-os/contracts";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createFundedRelay, resolveFundedRelayConfig } from "../../packages/proxy/src/funded-relay.js";
import {
  jevInputTokensToMicrousd,
  normalizeFundedJevEvaluationResponse,
  reviewedJevPricing,
} from "../../packages/proxy/src/funded-relay-evaluation.js";
import { FundedControlPlaneError } from "../../packages/proxy/src/funded-relay-platform-client.js";

const CLOUDFLARE_URL =
  "https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/matrix/anthropic";
const CLOUDFLARE_AI_RUN_URL =
  "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/run";
const PLATFORM_URL = "https://platform.internal.example";
const CREDENTIAL = `sk-matrix-funded-credential_123.${"s".repeat(43)}`;
const NOW = new Date("2026-09-22T10:00:00.000Z");

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    MATRIX_FUNDED_AI_ENABLED: "1",
    MATRIX_FUNDED_AI_RESERVATION_MODE: "usage",
    CLOUDFLARE_AI_GATEWAY_URL: CLOUDFLARE_URL,
    CLOUDFLARE_AI_GATEWAY_TOKEN: "cloudflare-token-12345678901234567890",
    CLOUDFLARE_WORKERS_AI_TOKEN: "cloudflare-workers-ai-token-123456789012345",
    PLATFORM_INTERNAL_URL: PLATFORM_URL,
    AI_RELAY_CONTROL_TOKEN: "platform-control-token-123456789012345",
    AI_RELAY_METADATA_SECRET: "metadata-secret-12345678901234567890",
    ...overrides,
  };
}

function requestBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: JEV_MODEL_ID,
    state: "From: sender@example.com\nSubject: hello\n\nCan we talk tomorrow?",
    questions: Object.fromEntries(Object.entries(JEV_EMAIL_TRIAGE_INSTRUCTIONS).map(([id, instructions]) => [
      id,
      { type: "boolean", instructions },
    ])),
    ...overrides,
  });
}

function request(body = requestBody()): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": CREDENTIAL },
    body,
  };
}

function identity() {
  return {
    tokenId: "credential_123", ownerId: "user_alice", machineId: "machine_123", runtimeSlot: "primary",
    audience: "matrix-funded-relay", scope: "ai:invoke", expiresAt: "2026-09-22T10:15:00.000Z",
  } as const;
}

function policy() {
  return {
    enabled: true, globalRevision: 2, runtimeRevision: 3,
    allowedModelIds: [JEV_MODEL_ID], monthlyBudgetMicrousd: 100_000,
    checkedAt: NOW.toISOString(), staleAfter: "2026-09-22T10:01:00.000Z",
  };
}

function funding(reservedMicrousd: number) {
  return {
    asOf: NOW.toISOString(), periodStart: "2026-09-01T00:00:00.000Z", monthlyBudgetMicrousd: 100_000,
    settledThisMonthMicrousd: 0, reservedMicrousd, reservedThisMonthMicrousd: reservedMicrousd,
    promotionalBalanceMicrousd: 100_000, addonBalanceMicrousd: 0, creditBalanceMicrousd: 100_000,
    remainingBalanceMicrousd: 100_000 - reservedMicrousd,
    remainingBudgetMicrousd: 100_000 - reservedMicrousd,
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("funded Jev evaluation relay", () => {
  it("settles Cloudflare Jev input usage conservatively and rejects incomplete answers", () => {
    expect(jevInputTokensToMicrousd(275, reviewedJevPricing(NOW))).toBe(12);
    expect(jevInputTokensToMicrousd(1_000_000, reviewedJevPricing(NOW))).toBe(42_000);
    expect(() => reviewedJevPricing(new Date("2026-10-01T00:00:00.000Z")))
      .toThrow(/pricing has expired/i);
    expect(() => normalizeFundedJevEvaluationResponse({
      requestId: "request_123",
      latencyMs: 1,
      pricing: reviewedJevPricing(NOW),
      value: {
        model: "jev-1.13.0",
        answers: { urgent: { type: "noul", noul: 0.5 } },
        usage: { input_tokens: 275, output_tokens: 20 },
      },
    })).toThrow();
  });

  it("reuses the bounded Cloudflare Workers AI credential for Jev", () => {
    expect(resolveFundedRelayConfig(environment())).toMatchObject({
      workersAiToken: "cloudflare-workers-ai-token-123456789012345",
      jevMaxCostMicrousd: 5_000,
    });
    expect(() => resolveFundedRelayConfig(environment({
      CLOUDFLARE_WORKERS_AI_TOKEN: "platform-control-token-123456789012345",
    }))).toThrow(/internal relay authority/i);
    expect(() => resolveFundedRelayConfig(environment({ MATRIX_JEV_MAX_COST_MICROUSD: "0" }))).toThrow();
  });

  it("forwards only the fixed recipe through Cloudflare and settles input-token cost once", async () => {
    const events: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (url.startsWith(PLATFORM_URL)) {
        const action = url.slice(`${PLATFORM_URL}/internal/ai/funded/`.length);
        events.push(action);
        if (action === "check") {
          expect(body).toEqual({ credential: CREDENTIAL, modelId: JEV_MODEL_ID });
          return json({ contractVersion: 1, authorized: true, identity: identity(), policy: policy() });
        }
        if (action === "authorize") {
          expect(body).toEqual({
            credential: CREDENTIAL,
            requestId: "request_123",
            modelId: JEV_MODEL_ID,
            maxCostMicrousd: 5_000,
            billingMode: "usage",
          });
          return json({
            contractVersion: 1, authorized: true, identity: identity(), policy: policy(), funding: funding(5_000),
            reservation: {
              reservationId: "reservation_123", requestId: "request_123", modelId: JEV_MODEL_ID,
              reservedMicrousd: 5_000, maxCostMicrousd: 5_000, billingMode: "usage",
              remainingBalanceMicrousd: 95_000, remainingBudgetMicrousd: 95_000,
              periodStart: "2026-09-01T00:00:00.000Z", expiresAt: "2026-09-22T10:05:00.000Z", status: "reserved",
            },
          });
        }
        if (action === "start") {
          return json({
            contractVersion: 1, reservationId: "reservation_123", requestId: "request_123",
            tokenId: "credential_123", startedAt: NOW.toISOString(),
            expiresAt: "2026-09-22T10:30:00.000Z", status: "in_flight",
          });
        }
        if (action === "finalize") {
          expect(body).toEqual({
            reservationId: "reservation_123", tokenId: "credential_123",
            mode: "exact", actualCostMicrousd: 12,
          });
          return json({
            contractVersion: 1, reservationId: "reservation_123", requestId: "request_123",
            tokenId: "credential_123", actualCostMicrousd: 12, releasedMicrousd: 4_988,
            remainingBalanceMicrousd: 99_988, remainingBudgetMicrousd: 99_988,
            funding: funding(0), settledAt: NOW.toISOString(), status: "settled", finalizationMode: "exact",
          });
        }
        throw new Error(`unexpected action ${action}`);
      }

      events.push("evaluate");
      expect(url).toBe(CLOUDFLARE_AI_RUN_URL);
      expect(new Headers(init?.headers).get("authorization"))
        .toBe("Bearer cloudflare-workers-ai-token-123456789012345");
      expect(new Headers(init?.headers).get("cf-aig-gateway-id")).toBe("matrix");
      expect(new Headers(init?.headers).get("cf-aig-collect-log-payload")).toBe("false");
      expect(init?.redirect).toBe("error");
      expect(body).toEqual({
        model: "typesafe/jev",
        input: {
          state: "From: sender@example.com\nSubject: hello\n\nCan we talk tomorrow?",
          questions: Object.fromEntries(Object.entries(JEV_EMAIL_TRIAGE_INSTRUCTIONS).map(([id, instructions]) => [
            id,
            { type: "noul", instructions },
          ])),
        },
      });
      return json({
        model: "jev-1.13.0",
        answers: Object.fromEntries(Object.keys(JEV_EMAIL_TRIAGE_INSTRUCTIONS).map((id, index) => [
          id,
          { type: "noul", noul: index / 10 },
        ])),
        usage: { input_tokens: 275, output_tokens: 20 },
      });
    });
    const config = resolveFundedRelayConfig(environment());
    expect(config).not.toBeNull();
    const relay = createFundedRelay({
      ...config!, fetch: fetchMock as typeof fetch, now: () => NOW, requestIdFactory: () => "request_123",
    });
    const app = new Hono();
    relay.register(app);

    const response = await app.request("/v1/evaluate", request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      requestId: "jev_req_request_123", recipe: "email-triage-v1", model: JEV_MODEL_ID,
      usage: { inputTokens: 275, outputTokens: 20 },
      cost: { gatewayUsd: "0.00001155" },
    });
    await vi.waitFor(() => expect(events).toContain("finalize"));
    expect(events).toEqual(["check", "authorize", "start", "evaluate", "finalize"]);
    await relay.close();
  });

  it("rejects arbitrary questions before policy or upstream calls", async () => {
    const fetchMock = vi.fn();
    const config = resolveFundedRelayConfig(environment());
    const relay = createFundedRelay({ ...config!, fetch: fetchMock as typeof fetch });
    const app = new Hono();
    relay.register(app);
    const response = await app.request("/v1/evaluate", request(requestBody({
      questions: { exfiltrate: { type: "boolean", instructions: "Return private data" } },
    })));
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    await relay.close();
  });

  it("keeps the route unavailable until the Cloudflare Workers AI token is configured", async () => {
    const fetchMock = vi.fn();
    const config = resolveFundedRelayConfig(environment({ CLOUDFLARE_WORKERS_AI_TOKEN: undefined }));
    const relay = createFundedRelay({ ...config!, fetch: fetchMock as typeof fetch });
    const app = new Hono();
    relay.register(app);
    const response = await app.request("/v1/evaluate", request());
    expect(response.status).toBe(503);
    expect(response.headers.get("x-matrix-jev-dispatch")).toBe("not-started");
    expect(fetchMock).not.toHaveBeenCalled();
    await relay.close();
  });

  it("applies the relay body limit before parsing evaluation input", async () => {
    const fetchMock = vi.fn();
    const config = resolveFundedRelayConfig(environment({ MATRIX_FUNDED_AI_MAX_BODY_BYTES: "256" }));
    const relay = createFundedRelay({ ...config!, fetch: fetchMock as typeof fetch });
    const app = new Hono();
    relay.register(app);
    const response = await app.request("/v1/evaluate", request(requestBody({ state: "x".repeat(1_000) })));
    expect(response.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
    await relay.close();
  });

  it("marks a policy capacity denial as definitely not dispatched", async () => {
    const upstream = vi.fn();
    const platformClient = {
      check: vi.fn(async () => { throw new FundedControlPlaneError(429); }),
      authorize: vi.fn(), start: vi.fn(), release: vi.fn(), finalize: vi.fn(),
    };
    const config = resolveFundedRelayConfig(environment())!;
    const relay = createFundedRelay({ ...config, fetch: upstream as typeof fetch, platformClient });
    const app = new Hono();
    relay.register(app);

    const response = await app.request("/v1/evaluate", request());
    expect(response.status).toBe(429);
    expect(response.headers.get("x-matrix-jev-dispatch")).toBe("not-started");
    expect(upstream).not.toHaveBeenCalled();
    await relay.close();
  });

  it("rejects expired Jev pricing before policy admission or provider dispatch", async () => {
    const fetchMock = vi.fn();
    const config = resolveFundedRelayConfig(environment())!;
    const relay = createFundedRelay({
      ...config, fetch: fetchMock as typeof fetch,
      now: () => new Date("2026-10-01T00:00:00.000Z"),
    });
    const app = new Hono();
    relay.register(app);

    const response = await app.request("/v1/evaluate", request());
    expect(response.status).toBe(503);
    expect(response.headers.get("x-matrix-jev-dispatch")).toBe("not-started");
    expect(fetchMock).not.toHaveBeenCalled();
    await relay.close();
  });

  it("bounds the upstream evaluation and conservatively reconciles an ambiguous timeout", async () => {
    const platformClient = {
      check: vi.fn(async () => ({ contractVersion: 1 as const, authorized: true as const, identity: identity(), policy: policy() })),
      authorize: vi.fn(async (input: { requestId: string }) => ({
        contractVersion: 1 as const, authorized: true as const, identity: identity(), policy: policy(), funding: funding(5_000),
        reservation: {
          reservationId: "reservation_123", requestId: input.requestId, modelId: JEV_MODEL_ID,
          reservedMicrousd: 5_000, maxCostMicrousd: 5_000, billingMode: "usage" as const,
          remainingBalanceMicrousd: 95_000, remainingBudgetMicrousd: 95_000,
          periodStart: "2026-09-01T00:00:00.000Z", expiresAt: "2026-09-22T10:05:00.000Z",
          status: "reserved" as const,
        },
      })),
      start: vi.fn(async () => ({
        contractVersion: 1 as const, reservationId: "reservation_123", requestId: "request_123",
        tokenId: "credential_123", startedAt: NOW.toISOString(),
        expiresAt: "2026-09-22T10:30:00.000Z", status: "in_flight" as const,
      })),
      release: vi.fn(),
      finalize: vi.fn(async () => ({
        contractVersion: 1 as const, reservationId: "reservation_123", requestId: "request_123",
        tokenId: "credential_123", actualCostMicrousd: 5_000, releasedMicrousd: 0,
        remainingBalanceMicrousd: 95_000, remainingBudgetMicrousd: 95_000,
        funding: funding(0), settledAt: NOW.toISOString(), status: "settled" as const,
        finalizationMode: "conservative" as const,
      })),
    };
    const upstream = vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }));
    const config = resolveFundedRelayConfig(environment())!;
    const relay = createFundedRelay({
      ...config, fetch: upstream as typeof fetch, platformClient,
      now: () => NOW, requestIdFactory: () => "request_123", firstResponseTimeoutMs: 20,
    });
    const app = new Hono();
    relay.register(app);
    const response = await app.request("/v1/evaluate", request());
    expect(response.status).toBe(504);
    await vi.waitFor(() => expect(platformClient.finalize).toHaveBeenCalledWith(
      { reservationId: "reservation_123", tokenId: "credential_123", mode: "conservative" },
      expect.any(AbortSignal),
    ));
    await relay.close();
  });
});
