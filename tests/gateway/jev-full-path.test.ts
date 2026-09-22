import {
  JEV_EMAIL_TRIAGE_ANSWER_IDS,
  JEV_EMAIL_TRIAGE_INSTRUCTIONS,
  JEV_MODEL_ID,
} from "@matrix-os/contracts";
import { Hono } from "hono";
import { KyselyPGlite } from "kysely-pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JevEvaluationRepository } from "../../packages/gateway/src/jev/repository.js";
import { createJevRoutes } from "../../packages/gateway/src/jev/routes.js";
import { createJevService } from "../../packages/gateway/src/jev/service.js";
import { createFundedRelay, resolveFundedRelayConfig } from "../../packages/proxy/src/funded-relay.js";

describe("Jev local Gateway to funded relay", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  it("uses one owner credential, one upstream evaluation, and one exact settlement", async () => {
    const now = new Date("2026-09-22T10:00:00.000Z");
    const identity = {
      tokenId: "credential_123", ownerId: "owner_a", machineId: "machine_123", runtimeSlot: "primary",
      audience: "matrix-funded-relay" as const, scope: "ai:invoke" as const,
      expiresAt: "2026-09-22T10:15:00.000Z",
    };
    const policy = {
      enabled: true, globalRevision: 2, runtimeRevision: 3, allowedModelIds: [JEV_MODEL_ID],
      monthlyBudgetMicrousd: 100_000, checkedAt: now.toISOString(), staleAfter: "2026-09-22T10:01:00.000Z",
    };
    const funding = {
      asOf: now.toISOString(), periodStart: "2026-09-01T00:00:00.000Z", monthlyBudgetMicrousd: 100_000,
      settledThisMonthMicrousd: 0, reservedMicrousd: 5_000, reservedThisMonthMicrousd: 5_000,
      promotionalBalanceMicrousd: 100_000, addonBalanceMicrousd: 0, creditBalanceMicrousd: 100_000,
      remainingBalanceMicrousd: 95_000, remainingBudgetMicrousd: 95_000,
    };
    const platformClient = {
      check: vi.fn(async () => ({ contractVersion: 1 as const, authorized: true as const, identity, policy })),
      authorize: vi.fn(async (input: { requestId: string }) => ({
        contractVersion: 1 as const, authorized: true as const, identity, policy, funding,
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
        tokenId: "credential_123", startedAt: now.toISOString(), expiresAt: "2026-09-22T10:30:00.000Z",
        status: "in_flight" as const,
      })),
      release: vi.fn(),
      finalize: vi.fn(async (input: { actualCostMicrousd?: number }) => ({
        contractVersion: 1 as const, reservationId: "reservation_123", requestId: "request_123",
        tokenId: "credential_123", actualCostMicrousd: input.actualCostMicrousd ?? 5_000,
        releasedMicrousd: 4_988, remainingBalanceMicrousd: 99_988, remainingBudgetMicrousd: 99_988,
        funding: { ...funding, reservedMicrousd: 0, reservedThisMonthMicrousd: 0 },
        settledAt: now.toISOString(), status: "settled" as const, finalizationMode: "exact" as const,
      })),
    };
    const upstream = vi.fn(async () => new Response(JSON.stringify({
      model: JEV_MODEL_ID,
      answers: Object.fromEntries(JEV_EMAIL_TRIAGE_ANSWER_IDS.map((id) => [
        id, { type: "boolean", probability: 0.5 },
      ])),
      usage: { inputTokens: 275, outputTokens: 20 },
      providerMetadata: { gateway: { gatewayCost: "0.00001155" } },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const config = resolveFundedRelayConfig({
      MATRIX_FUNDED_AI_ENABLED: "1", MATRIX_FUNDED_AI_RESERVATION_MODE: "usage",
      CLOUDFLARE_AI_GATEWAY_URL: "https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/matrix/anthropic",
      CLOUDFLARE_AI_GATEWAY_TOKEN: "cloudflare-token-12345678901234567890",
      AI_GATEWAY_API_KEY: "vercel-gateway-key-12345678901234567890",
      PLATFORM_INTERNAL_URL: "https://platform.internal.example",
      AI_RELAY_CONTROL_TOKEN: "platform-control-token-123456789012345",
      AI_RELAY_METADATA_SECRET: "metadata-secret-12345678901234567890",
    })!;
    const relay = createFundedRelay({
      ...config,
      fetch: upstream as typeof fetch,
      platformClient,
      now: () => now,
      requestIdFactory: () => "request_123",
    });
    const relayApp = new Hono();
    relay.register(relayApp);

    const pglite = await KyselyPGlite.create();
    const repository = new JevEvaluationRepository(pglite.dialect, { now: () => now });
    await repository.bootstrap();
    const credentialProvider = {
      enabled: true as const,
      maxRunMs: 60_000,
      getCredential: vi.fn(async () => ({
        token: `sk-matrix-funded-credential_123.${"s".repeat(43)}`,
        tokenId: "credential_123",
        expiresAt: identity.expiresAt,
        relayBaseUrl: "https://relay.matrix-os.com",
        maxRunMs: 60_000,
      })),
      invalidate: vi.fn(),
      close: vi.fn(),
    };
    const service = createJevService({
      store: repository,
      credentialProvider,
      fetchFn: async (_url, init) => relayApp.request(new Request("http://relay.local/v1/evaluate", init)),
    });
    const gateway = new Hono();
    gateway.route("/api/jev", createJevRoutes({ service, resolveOwnerId: () => "owner_a" }));
    close = async () => {
      await relay.close();
      await repository.destroy();
    };

    const response = await gateway.request("/api/jev/evaluate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recipe: "email-triage-v1", state: "hello", idempotencyKey: "thread:abc123" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ model: JEV_MODEL_ID, answers: expect.arrayContaining([
      expect.objectContaining({ id: "urgent", probability: 0.5 }),
    ]) });
    await vi.waitFor(() => expect(platformClient.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "exact", actualCostMicrousd: 12 }),
      expect.any(AbortSignal),
    ));
    expect(upstream).toHaveBeenCalledTimes(1);
    const upstreamBody = JSON.parse(String(upstream.mock.calls[0]?.[1]?.body));
    expect(upstreamBody.questions).toEqual(Object.fromEntries(
      Object.entries(JEV_EMAIL_TRIAGE_INSTRUCTIONS).map(([id, instructions]) => [id, { type: "boolean", instructions }]),
    ));
  });
});
