import { describe, expect, it, vi } from "vitest";
import {
  FundedAiFundingSummaryClientError,
  createFundedAiFundingSummaryClient,
} from "../../packages/gateway/src/funded-ai-funding-summary-client.js";
import {
  loadFundedAiRuntimeConfig,
} from "../../packages/gateway/src/funded-ai-credential-manager.js";
import { createFundedAiRouteReadinessClient } from "../../packages/gateway/src/funded-ai-route-readiness-client.js";

const NOW = "2026-08-30T10:00:00.000Z";
const funding = {
  asOf: NOW,
  periodStart: "2026-08-01T00:00:00.000Z",
  monthlyBudgetMicrousd: 5_000_000,
  settledThisMonthMicrousd: 1_000_000,
  reservedMicrousd: 250_000,
  reservedThisMonthMicrousd: 250_000,
  promotionalBalanceMicrousd: 2_000_000,
  addonBalanceMicrousd: 1_000_000,
  creditBalanceMicrousd: 3_000_000,
  remainingBalanceMicrousd: 2_750_000,
  remainingBudgetMicrousd: 3_750_000,
} as const;
const policy = {
  enabled: true,
  globalRevision: 4,
  runtimeRevision: 2,
  allowedModelIds: ["anthropic/claude-sonnet-5"],
  monthlyBudgetMicrousd: funding.monthlyBudgetMicrousd,
  checkedAt: NOW,
  staleAfter: "2026-08-30T10:01:00.000Z",
} as const;

function runtimeConfig() {
  return loadFundedAiRuntimeConfig({
    MATRIX_FUNDED_AI_ENABLED: "true",
    MATRIX_FUNDED_AI_RELAY_URL: "https://relay.matrix-os.com",
    PLATFORM_INTERNAL_URL: "https://platform.matrix-os.com",
    MATRIX_AUTH_TOKEN: "legacy-token-must-not-authorize-funded-ai",
    MATRIX_FUNDED_AI_RUNTIME_TOKEN: "p".repeat(64),
    MATRIX_HANDLE: "alice",
    MATRIX_CLERK_USER_ID: "user_123",
    MATRIX_MACHINE_ID: "machine_123",
    MATRIX_RUNTIME_SLOT: "primary",
  })!;
}

describe("funded AI funding summary client", () => {
  it("requests the exact authenticated runtime summary with a bounded deadline", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ contractVersion: 1, funding, policy }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const config = runtimeConfig();
    expect(config.fundingSummaryUrl).toBe(
      "https://platform.matrix-os.com/internal/containers/alice/ai/funding-summary?runtimeSlot=primary",
    );
    const client = createFundedAiFundingSummaryClient(config, { fetchFn });
    await expect(client.getFundingSummary()).resolves.toEqual({ funding, policy });
    expect(fetchFn).toHaveBeenCalledWith(config.fundingSummaryUrl, expect.objectContaining({
      method: "POST",
      redirect: "error",
      signal: expect.any(AbortSignal),
      headers: expect.objectContaining({
        authorization: `Bearer ${"p".repeat(64)}`,
        "content-type": "application/json",
      }),
      body: JSON.stringify({ includeChatAvailability: true }),
    }));
  });

  it("reads opted-in Chat availability and rejects malformed or mismatched projections", async () => {
    const chatAvailability = { contractVersion: 1, asOf: NOW, eligibleBalanceMicrousd: 400, availableBalanceMicrousd: 200 };
    const response = { contractVersion: 1, funding, policy, chatAvailability };
    const client = createFundedAiFundingSummaryClient(runtimeConfig(), { fetchFn: vi.fn(async () => Response.json(response)) });
    await expect(client.getFundingSummary()).resolves.toEqual({ funding, policy, chatAvailability });
    for (const invalid of [{ ...chatAvailability, availableBalanceMicrousd: 401 }, { ...chatAvailability, asOf: "2026-08-30T09:00:00.000Z" }]) {
      const bad = createFundedAiFundingSummaryClient(runtimeConfig(), { fetchFn: vi.fn(async () => Response.json({ ...response, chatAvailability: invalid })) });
      await expect(bad.getFundingSummary()).rejects.toBeInstanceOf(FundedAiFundingSummaryClientError);
    }
  });

  it("retries a legacy body rejection once under the same deadline without inventing availability", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(Response.json({ error: { code: "invalid_request", message: "Invalid request" } }, { status: 400 }))
      .mockResolvedValueOnce(Response.json({ contractVersion: 1, funding, policy }));
    const client = createFundedAiFundingSummaryClient(runtimeConfig(), { fetchFn });
    await expect(client.getFundingSummary()).resolves.toEqual({ funding, policy });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[1][1]).toMatchObject({ body: "{}", signal: fetchFn.mock.calls[0][1].signal });
  });

  it("does not retry unrelated or malformed body denials", async () => {
    for (const body of [{ error: { code: "unavailable", message: "Service unavailable" } }, { error: { code: "invalid_request", message: "raw private detail" } }]) {
      const fetchFn = vi.fn(async () => Response.json(body, { status: 400 }));
      const client = createFundedAiFundingSummaryClient(runtimeConfig(), { fetchFn });
      await expect(client.getFundingSummary()).rejects.toBeInstanceOf(FundedAiFundingSummaryClientError);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    }
  });

  it("fails safely on denial, malformed or oversized responses, and timeouts", async () => {
    const responses = [
      new Response("provider raw error", { status: 503 }),
      new Response(JSON.stringify({ contractVersion: 1, ownerId: "user_123", funding }), { status: 200 }),
      new Response("x".repeat(20_000), { status: 200 }),
    ];
    for (const response of responses) {
      const client = createFundedAiFundingSummaryClient(runtimeConfig(), {
        fetchFn: vi.fn(async () => response),
      });
      const error = await client.getFundingSummary().catch((caught: unknown) => caught);
      expect(error).toEqual(expect.objectContaining({
        name: "FundedAiFundingSummaryClientError",
        message: "Matrix AI usage is temporarily unavailable",
      }));
      expect(String(error)).not.toMatch(/provider raw|user_123/);
    }

    const deadline = new AbortController();
    const pendingClient = createFundedAiFundingSummaryClient(runtimeConfig(), {
      fetchFn: vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })),
      makeTimeoutSignal: () => deadline.signal,
    });
    const pending = pendingClient.getFundingSummary();
    deadline.abort();
    await expect(pending).rejects.toBeInstanceOf(FundedAiFundingSummaryClientError);
  });
});

describe("funded AI route readiness client", () => {
  it("uses only the runtime token and validates a bounded model receipt", async () => {
    const config = runtimeConfig();
    const receipt = { contractVersion: 1, globalRevision: 4, runtimeRevision: 2,
      checkedAt: NOW, staleAfter: "2026-08-30T10:00:30.000Z",
      readyModelIds: ["anthropic/claude-sonnet-5"] };
    const fetchFn = vi.fn(async () => Response.json(receipt));
    const client = createFundedAiRouteReadinessClient(config, fetchFn);
    await expect(client.getRouteReadiness()).resolves.toEqual(receipt);
    expect(fetchFn).toHaveBeenCalledWith(config.routeReadinessUrl, expect.objectContaining({
      method: "POST", redirect: "error", signal: expect.any(AbortSignal),
      headers: expect.objectContaining({ authorization: `Bearer ${"p".repeat(64)}` }), body: "{}",
    }));
    const invalid = createFundedAiRouteReadinessClient(config, vi.fn(async () => Response.json({ ...receipt,
      readyModelIds: ["anthropic/claude-sonnet-5", "anthropic/claude-sonnet-5"] })));
    await expect(invalid.getRouteReadiness()).rejects.toThrow();
  });
});
