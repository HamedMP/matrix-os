import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFundedRelay, resolveFundedRelayConfig } from "../../packages/proxy/src/funded-relay.js";
import type { FundedPlatformClient } from "../../packages/proxy/src/funded-relay-platform-client.js";
import { createAiFundedPolicyRepository } from "../../packages/platform/src/ai-funded-policy-repository.js";
import { createAiFundedRelayRoutes } from "../../packages/platform/src/ai-funded-policy-routes.js";
import { initializeCustomerFundedStarterPolicy } from "../../packages/platform/src/customer-funded-starter-policy.js";
import { upsertBillingEntitlement, type PlatformDB } from "../../packages/platform/src/db.js";
import { buildFreeEntitlement } from "../../packages/platform/src/free-tier/free-entitlement.js";
import { FREE_MANAGED_MODEL_ID } from "../../packages/platform/src/free-tier/funded-policy.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "../platform/platform-db-test-helper.js";
import { insertFreeMetalRuntime } from "../platform/free-funded-test-helper.js";

/**
 * Free runtimes pay for Matrix AI from a prepaid hold: the relay asks for usage billing with no
 * postpaid policy, the platform holds what the owner can afford under the daily ceiling and month
 * budget, and settlement debits at most that hold. Paid runtimes stay on zero-hold postpaid.
 * Ported from PR #3437 with the free container runtime swapped for a free metal runtime (ENG-520 P7).
 */

const MODEL = FREE_MANAGED_MODEL_ID;
const NOW = new Date("2026-09-10T12:00:00.000Z");
const RELAY_TOKEN = "relay-control-token-1234567890123456789";
const IDENTITY = {
  tokenId: "credential_123", ownerId: "owner_123", machineId: "machine_123", runtimeSlot: "primary",
  audience: "matrix-funded-relay", scope: "ai:invoke", expiresAt: "2026-09-10T12:15:00.000Z",
};
const CREDENTIAL = `sk-matrix-funded-credential_123.${"s".repeat(43)}`;
const relays: ReturnType<typeof createFundedRelay>[] = [];

function relayConfig() {
  return resolveFundedRelayConfig({
    MATRIX_FUNDED_AI_ENABLED: "true", MATRIX_FUNDED_AI_RESERVATION_MODE: "usage",
    CLOUDFLARE_AI_GATEWAY_URL: "https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/preview/anthropic",
    CLOUDFLARE_AI_GATEWAY_TOKEN: "cloudflare-gateway-token-123456789012345",
    CLOUDFLARE_WORKERS_AI_TOKEN: "cloudflare-workers-ai-token-123456789012345",
    PLATFORM_INTERNAL_URL: "https://platform.example.com",
    AI_RELAY_CONTROL_TOKEN: RELAY_TOKEN,
    AI_RELAY_METADATA_SECRET: "metadata-secret-12345678901234567890123",
  })!;
}

/** A Workers AI stream whose exact usage prices at 24 microdollars (the shape the GLM relay tests use). */
function workersAiStream(): string {
  const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 10 } };
  const chunk = (value: object) => `data: ${JSON.stringify({ id: "response_1", model: MODEL, ...value })}\n\n`;
  return chunk({ choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }] })
    + chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
    + `data: ${JSON.stringify({ response: "", usage })}\n\n` + "data: [DONE]\n\n";
}

/** A complete stream whose final usage never arrives. */
function streamWithoutUsage(): string {
  const chunk = (value: object) => `data: ${JSON.stringify({ id: "response_1", model: MODEL, ...value })}\n\n`;
  return chunk({ choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }] })
    + chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + "data: [DONE]\n\n";
}

function chat(app: Hono, credential: string) {
  return app.request("/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }], stream: true, max_tokens: 256 }),
  });
}

const closeRelays = () => Promise.all(relays.splice(0).map((relay) => relay.close()));
afterEach(closeRelays);

describe("relay billing choice", () => {
  function setup(input: { prepaid: boolean; authorization?: object; failed?: boolean }) {
    const control = {
      check: vi.fn(async () => ({ identity: IDENTITY, ...(input.prepaid ? { customerBilling: "prepaid" } : {}) })),
      authorize: vi.fn(async (request: { requestId: string; modelId: string; maxCostMicrousd: number }) => ({
        identity: IDENTITY,
        reservation: input.prepaid
          ? { reservationId: "reservation_1", requestId: request.requestId, modelId: request.modelId, reservedMicrousd: 500,
            billingMode: "usage", maxCostMicrousd: request.maxCostMicrousd, ...input.authorization }
          : { reservationId: "reservation_1", requestId: request.requestId, modelId: request.modelId, reservedMicrousd: 0,
            billingMode: "usage", billingPolicy: "postpaid", maxCostMicrousd: request.maxCostMicrousd, ...input.authorization },
      })),
      start: vi.fn(async (request: { executionId?: string }) => ({ executionId: request.executionId,
        reservationId: "reservation_1", requestId: "request_1", tokenId: IDENTITY.tokenId })),
      release: vi.fn(async () => ({})), terminal: vi.fn(async () => ({})), finalize: vi.fn(async () => ({})),
    };
    const fetchMock = vi.fn(async () => input.failed
      ? Response.json({ errors: [{ message: "Too many requests" }] }, { status: 429 })
      : new Response(workersAiStream(), { headers: { "content-type": "text/event-stream" } }));
    const relay = createFundedRelay({ ...relayConfig(), fetch: fetchMock, now: () => NOW,
      requestIdFactory: () => "request_1", platformClient: control as unknown as FundedPlatformClient });
    relays.push(relay);
    const app = new Hono(); relay.register(app);
    return { control, fetchMock, app };
  }

  it("keeps a paid runtime on zero-hold postpaid billing", async () => {
    const { control, app } = setup({ prepaid: false });
    const response = await chat(app, CREDENTIAL);
    expect(response.status).toBe(200); await response.text();
    expect(control.authorize).toHaveBeenCalledWith(expect.objectContaining({ billingMode: "usage", billingPolicy: "postpaid" }),
      expect.any(AbortSignal));
  });

  it("asks a free runtime's request for a prepaid usage hold and settles it without a customer-charge waiver", async () => {
    const { control, app } = setup({ prepaid: true });
    const response = await chat(app, CREDENTIAL);
    expect(response.status).toBe(200); await response.text();
    const request = control.authorize.mock.calls[0]![0] as Record<string, unknown>;
    expect(request).toMatchObject({ billingMode: "usage" });
    expect(request).not.toHaveProperty("billingPolicy");
    await vi.waitFor(() => expect(control.finalize).toHaveBeenCalledWith({ reservationId: "reservation_1",
      tokenId: IDENTITY.tokenId, mode: "exact", actualCostMicrousd: 24 }, expect.any(AbortSignal)));
  });

  it.each([
    { billingPolicy: "postpaid", reservedMicrousd: 0 }, { reservedMicrousd: 0 }, { billingMode: undefined },
    { reservedMicrousd: 10_000_000_000 },
  ])("does not dispatch a free request against a contradictory prepaid authorization (%j)", async (authorization) => {
    const { control, fetchMock, app } = setup({ prepaid: true, authorization });
    expect((await chat(app, CREDENTIAL)).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(control.release).toHaveBeenCalled();
  });
});

describe("free Matrix AI end to end through the relay and the platform", () => {
  let db: PlatformDB;
  beforeEach(async () => { ({ db } = await createTestPlatformDb()); });
  // Settlement runs after the response, so close the relay before the database goes away.
  afterEach(async () => { await closeRelays(); await destroyTestPlatformDb(db); });

  async function freeOwner(input: { dailyFundedSpendMicrousd: number; monthlyBudgetMicrousd?: number }) {
    const clock = { now: NOW };
    const repo = createAiFundedPolicyRepository({ db, credentialHashSecret: "h".repeat(32), now: () => clock.now,
      freeFunding: { dailyFundedSpendMicrousd: input.dailyFundedSpendMicrousd } });
    await db.executor.updateTable("ai_funded_global_policy")
      .set({ enabled: true, allowed_model_ids: JSON.stringify([MODEL]), revision: 1 })
      .where("policy_id", "=", "default").execute();
    const identity = { ownerId: "user_freechat", machineId: "metal-freechat", runtimeSlot: "primary" };
    await insertFreeMetalRuntime(db, { machineId: identity.machineId, clerkUserId: identity.ownerId, handle: "freechat", at: NOW });
    await db.transaction((trx) => initializeCustomerFundedStarterPolicy(trx, identity.machineId, { now: NOW.toISOString(), env: {
      MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: "true", MATRIX_FUNDED_AI_RUNTIME_ENABLED: "true",
      AI_FUNDED_CREDENTIAL_HASH_SECRET: "h".repeat(32),
    } }));
    if (input.monthlyBudgetMicrousd !== undefined) {
      await db.executor.updateTable("ai_funded_runtime_policies").set({ monthly_budget_microusd: input.monthlyBudgetMicrousd })
        .where("machine_id", "=", identity.machineId).execute();
    }
    const credential = (await repo.issueRuntimeCredential(identity)).credential;
    const platformApp = new Hono().route("/internal/ai/funded", createAiFundedRelayRoutes({ relayControlToken: RELAY_TOKEN, repository: repo }));
    let gate: Promise<void> | null = null;
    let withoutUsage = false;
    const generations = vi.fn(async () => {
      if (gate) await gate;
      return new Response(withoutUsage ? streamWithoutUsage() : workersAiStream(), { headers: { "content-type": "text/event-stream" } });
    });
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.startsWith("https://platform.example.com/")) {
        return platformApp.request(target.slice("https://platform.example.com".length), init);
      }
      return generations();
    });
    const relay = createFundedRelay({ ...relayConfig(), fetch: fetchMock as typeof fetch, now: () => clock.now });
    relays.push(relay);
    const app = new Hono(); relay.register(app);
    return {
      repo, identity, credential, app, generations,
      hold(until: Promise<void>) { gate = until; },
      loseUsage() { withoutUsage = true; },
    };
  }

  const reservations = (machineId: string) => db.executor.selectFrom("ai_funded_usage_reservations")
    .select(["status", "reserved_microusd", "actual_microusd", "authorization_response"]).where("machine_id", "=", machineId).execute();

  it("holds, settles at the exact cost, and leaves postpaid refused for free runtimes", async () => {
    const owner = await freeOwner({ dailyFundedSpendMicrousd: 100_000_000 });
    const response = await chat(owner.app, owner.credential.token);
    expect(response.status).toBe(200); await response.text();
    await vi.waitFor(async () => expect((await reservations(owner.identity.machineId))[0]?.status).toBe("settled"));
    const [settled] = await reservations(owner.identity.machineId);
    expect(Number(settled!.reserved_microusd)).toBeGreaterThan(0);
    expect(Number(settled!.actual_microusd)).toBe(24);
    expect(JSON.parse(settled!.authorization_response).reservation).not.toHaveProperty("billingPolicy");
    expect(await owner.repo.getFundingSummary(owner.identity)).toMatchObject({ reservedMicrousd: 0, settledThisMonthMicrousd: 24 });
    await expect(owner.repo.authorize({ credential: owner.credential.token, requestId: "direct_postpaid", modelId: MODEL,
      maxCostMicrousd: 1_000, billingMode: "usage", billingPolicy: "postpaid" })).rejects.toMatchObject({ code: "access_disabled" });
  });

  it("uses paid zero-hold admission immediately after a free owner upgrades with the same credential", async () => {
    const owner = await freeOwner({ dailyFundedSpendMicrousd: 100_000_000 });
    const first = await chat(owner.app, owner.credential.token);
    expect(first.status).toBe(200);
    await first.text();
    await vi.waitFor(async () => expect((await reservations(owner.identity.machineId))[0]?.status).toBe("settled"));

    await upsertBillingEntitlement(db, {
      ...buildFreeEntitlement(owner.identity.ownerId, NOW), source: "stripe", planSlug: "matrix_starter",
      status: "active", stripeSubscriptionId: "sub_upgraded",
    });
    const second = await chat(owner.app, owner.credential.token);
    expect(second.status).toBe(200);
    await second.text();
    const rows = await reservations(owner.identity.machineId);
    expect(rows.map(row => JSON.parse(row.authorization_response).reservation)).toContainEqual(expect.objectContaining({
      billingPolicy: "postpaid", reservedMicrousd: 0,
    }));
  });

  it("refuses a free request over the daily funded spend ceiling before any inference", async () => {
    const owner = await freeOwner({ dailyFundedSpendMicrousd: 1 });
    const response = await chat(owner.app, owner.credential.token);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "busy" } });
    expect(owner.generations).not.toHaveBeenCalled();
  });

  it("caps the debit at a month budget smaller than the cost and absorbs the overrun", async () => {
    const owner = await freeOwner({ dailyFundedSpendMicrousd: 100_000_000, monthlyBudgetMicrousd: 10 });
    const response = await chat(owner.app, owner.credential.token);
    expect(response.status).toBe(200); await response.text();
    await vi.waitFor(async () => expect((await reservations(owner.identity.machineId))[0]?.status).toBe("settled"));
    expect(await owner.repo.getFundingSummary(owner.identity)).toMatchObject({ settledThisMonthMicrousd: 10, remainingBudgetMicrousd: 0 });
    const next = await chat(owner.app, owner.credential.token);
    expect(next.status).not.toBe(200);
    expect(owner.generations).toHaveBeenCalledTimes(1);
  });

  it("keeps the hold reserved and the owner blocked when the relay never sees final usage", async () => {
    const owner = await freeOwner({ dailyFundedSpendMicrousd: 100_000_000 });
    owner.loseUsage();
    const response = await chat(owner.app, owner.credential.token);
    expect(response.status).toBe(200); await response.text();
    // The relay reports the unknown outcome to the platform's terminal handler.
    await vi.waitFor(async () => {
      const row = await db.executor.selectFrom("ai_funded_usage_reservations").selectAll()
        .where("machine_id", "=", owner.identity.machineId).executeTakeFirstOrThrow();
      expect(row.terminal_outcome).not.toBeNull();
    });
    const row = await db.executor.selectFrom("ai_funded_usage_reservations").selectAll()
      .where("machine_id", "=", owner.identity.machineId).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: "in_flight", actual_microusd: null, customer_charge_release: null,
      execution_admission_release: null });
    expect(await owner.repo.getFundingSummary(owner.identity)).toMatchObject({ reservedMicrousd: Number(row.reserved_microusd) });
    expect((await chat(owner.app, owner.credential.token)).status).toBe(429);
    expect(owner.generations).toHaveBeenCalledTimes(1);
  });

  it("lets a free owner have one funded request in flight", async () => {
    const owner = await freeOwner({ dailyFundedSpendMicrousd: 100_000_000 });
    let release!: () => void;
    owner.hold(new Promise<void>((resolve) => { release = resolve; }));
    const first = chat(owner.app, owner.credential.token);
    let secondStatus: number | string = "none";
    try {
      await vi.waitFor(() => expect(owner.generations).toHaveBeenCalledTimes(1), { timeout: 5_000 });
      const second = await Promise.race([chat(owner.app, owner.credential.token),
        new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 5_000))]);
      secondStatus = typeof second === "string" ? second : second.status;
    } finally {
      release();
    }
    const done = await first;
    expect(done.status).toBe(200); await done.text();
    expect(secondStatus).toBe(429);
    expect(owner.generations).toHaveBeenCalledTimes(1);
    await vi.waitFor(async () => expect((await reservations(owner.identity.machineId)).map((row) => row.status)).toEqual(["settled"]));
  });
});
