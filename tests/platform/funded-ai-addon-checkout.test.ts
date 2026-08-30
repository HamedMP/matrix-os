import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createAiFundedPolicyRepository } from "../../packages/platform/src/ai-funded-policy-repository.js";
import {
  createBillingRoutes,
  type StripeBillingClient,
  type StripeWebhookEvent,
} from "../../packages/platform/src/billing-routes.js";
import { loadAiCreditCheckoutConfig } from "../../packages/platform/src/ai-credit-checkout.js";
import { getBillingWebhookEvent, insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./platform-db-test-helper.js";

const checkoutEnv = {
  MATRIX_FUNDED_AI_ADDON_CHECKOUT_ENABLED: "true",
  STRIPE_SECRET_KEY: "configured",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
  STRIPE_PRICE_AI_CREDIT_USD_5: "price_ai_5",
  STRIPE_PRICE_AI_CREDIT_USD_10: "price_ai_10",
  STRIPE_PRICE_AI_CREDIT_USD_25: "price_ai_25",
};

const identity = {
  ownerId: "user_alice",
  machineId: "machine_alice",
  runtimeSlot: "primary",
} as const;

describe("funded AI add-on checkout", () => {
  let db: PlatformDB;
  let stripe: StripeBillingClient;
  let repository: ReturnType<typeof createAiFundedPolicyRepository>;
  let webhookEvent: StripeWebhookEvent;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await insertUserMachine(db, {
      machineId: identity.machineId,
      clerkUserId: identity.ownerId,
      handle: "alice",
      runtimeSlot: identity.runtimeSlot,
      status: "running",
      imageVersion: "v1",
      provisionedAt: "2026-08-31T09:00:00.000Z",
      activationState: "authorized",
    });
    repository = createAiFundedPolicyRepository({
      db,
      credentialHashSecret: "h".repeat(32),
      now: () => new Date("2026-08-31T10:00:00.000Z"),
    });
    await repository.setRuntimePolicy({
      identity,
      expectedRevision: 0,
      enabled: true,
      allowedModelIds: ["anthropic/claude-sonnet-5"],
      monthlyBudgetMicrousd: 50_000_000,
      expiresAt: null,
    });
    stripe = {
      apiTimeoutMs: 10_000,
      createCheckoutSession: vi.fn(),
      createAiCreditCheckoutSession: vi.fn().mockResolvedValue({
        url: "https://checkout.stripe.com/c/pay/cs_test",
        id: "cs_ai_5",
      }),
      retrieveCheckoutSession: vi.fn(),
      createPortalSession: vi.fn(),
      constructWebhookEvent: vi.fn(() => webhookEvent),
    };
    webhookEvent = completedEvent();
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
  });

  function app(userId: string | null = identity.ownerId, env: NodeJS.ProcessEnv = checkoutEnv) {
    const hono = new Hono();
    hono.route("/billing", createBillingRoutes({
      db,
      stripe,
      env,
      resolveClerkUserId: () => Promise.resolve(userId),
      now: () => new Date("2026-08-31T10:00:00.000Z"),
      fundedAiRepository: repository,
    }));
    return hono;
  }

  it("loads a complete, bounded, server-owned package catalog or disables checkout", () => {
    expect(loadAiCreditCheckoutConfig(checkoutEnv)).toEqual({
      enabled: true,
      automaticTax: false,
      packages: [
        { id: "usd_5", amountUsd: 5, amountMicrousd: 5_000_000, amountCents: 500, currency: "usd", priceId: "price_ai_5" },
        { id: "usd_10", amountUsd: 10, amountMicrousd: 10_000_000, amountCents: 1_000, currency: "usd", priceId: "price_ai_10" },
        { id: "usd_25", amountUsd: 25, amountMicrousd: 25_000_000, amountCents: 2_500, currency: "usd", priceId: "price_ai_25" },
      ],
    });
    expect(loadAiCreditCheckoutConfig({ ...checkoutEnv, STRIPE_PRICE_AI_CREDIT_USD_10: undefined }))
      .toEqual({ enabled: false });
    expect(loadAiCreditCheckoutConfig({
      ...checkoutEnv,
      MATRIX_AI_CREDIT_STRIPE_TAX_REGISTRATIONS_VERIFIED: "true",
    })).toMatchObject({ enabled: true, automaticTax: true });
    expect(() => loadAiCreditCheckoutConfig({ ...checkoutEnv, STRIPE_PRICE_AI_CREDIT_USD_10: "price_ai_5" }))
      .toThrow(/misconfigured/i);
  });

  it("derives the exact owner runtime and creates payment Checkout from a package id only", async () => {
    const response = await app().request("/billing/ai-credit/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        packageId: "usd_5",
        runtimeSlot: "primary",
        requestId: "77f105df-6e24-4e13-a881-af9ce20d6a63",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ url: "https://checkout.stripe.com/c/pay/cs_test" });
    expect(stripe.createAiCreditCheckoutSession).toHaveBeenCalledWith({
      idempotencyKey: `matrix-ai-credit:${createHash("sha256")
        .update(["user_alice", "machine_alice", "77f105df-6e24-4e13-a881-af9ce20d6a63"].join("\0"))
        .digest("hex")}`,
      requestId: "77f105df-6e24-4e13-a881-af9ce20d6a63",
      clerkUserId: identity.ownerId,
      machineId: identity.machineId,
      runtimeSlot: identity.runtimeSlot,
      packageId: "usd_5",
      priceId: "price_ai_5",
      amountMicrousd: 5_000_000,
      automaticTax: false,
      successUrl: "https://app.matrix-os.com/?billing=success&checkout=success",
      cancelUrl: "https://app.matrix-os.com/?billing=canceled",
    });
  });

  it("rejects client-supplied money, unknown packages, missing auth, and non-running runtimes", async () => {
    const clientMoney = await app().request("/billing/ai-credit/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ packageId: "usd_5", requestId: crypto.randomUUID(), amount: 1, priceId: "price_attacker" }),
    });
    expect(clientMoney.status).toBe(400);
    expect(stripe.createAiCreditCheckoutSession).not.toHaveBeenCalled();

    const unknown = await app().request("/billing/ai-credit/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ packageId: "usd_500", requestId: crypto.randomUUID() }),
    });
    expect(unknown.status).toBe(400);
    expect((await app(null).request("/billing/ai-credit/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ packageId: "usd_5", requestId: crypto.randomUUID() }),
    })).status).toBe(401);

    await db.executor.updateTable("user_machines").set({ status: "suspended" })
      .where("machine_id", "=", identity.machineId).execute();
    expect((await app().request("/billing/ai-credit/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ packageId: "usd_5", requestId: crypto.randomUUID() }),
    })).status).toBe(409);
  });

  it("atomically records one signed receipt and grants exact non-expiring add-on credit once", async () => {
    const first = await app().request("/billing/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": "signed" },
      body: "{}",
    });
    const duplicate = await app().request("/billing/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": "signed" },
      body: "{}",
    });

    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual({ received: true, duplicate: true });
    expect(await getBillingWebhookEvent(db, webhookEvent.id)).toMatchObject({ status: "processed" });
    expect(await db.executor.selectFrom("ai_funded_credit_ledger").selectAll().execute()).toEqual([
      expect.objectContaining({
        entry_id: "addon:cs_ai_5",
        owner_id: identity.ownerId,
        machine_id: identity.machineId,
        runtime_slot: identity.runtimeSlot,
        kind: "addon_grant",
        amount_microusd: 5_000_000,
        source_reference: "cs_ai_5",
        expires_at: null,
      }),
    ]);
    await expect(repository.getFundingSummary(identity)).resolves.toMatchObject({
      addonBalanceMicrousd: 5_000_000,
      creditBalanceMicrousd: 5_000_000,
    });
  });

  it.each([
    ["unpaid", { payment_status: "unpaid" }],
    ["expired", { status: "expired" }],
    ["wrong amount", { amount_total: 499 }],
    ["wrong currency", { currency: "eur" }],
    ["wrong owner", { client_reference_id: "user_other" }],
    ["wrong machine", { metadata: { ...completedMetadata(), matrix_machine_id: "machine_other" } }],
    ["wrong mode", { mode: "subscription" }],
  ])("rejects %s completion without persisting a receipt or credit", async (_label, patch) => {
    webhookEvent = completedEvent(patch);
    const response = await app().request("/billing/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": "signed" },
      body: "{}",
    });

    expect(response.status).toBe(500);
    expect(await getBillingWebhookEvent(db, webhookEvent.id)).toBeUndefined();
    expect(await db.executor.selectFrom("ai_funded_credit_ledger").selectAll().execute()).toEqual([]);
  });
});

function completedMetadata() {
  return {
    matrix_checkout_kind: "ai_credit_addon",
    matrix_owner_id: identity.ownerId,
    matrix_machine_id: identity.machineId,
    matrix_runtime_slot: identity.runtimeSlot,
    matrix_ai_credit_package_id: "usd_5",
    matrix_ai_credit_request_id: "77f105df-6e24-4e13-a881-af9ce20d6a63",
    matrix_ai_credit_price_id: "price_ai_5",
    matrix_ai_credit_microusd: "5000000",
  };
}

function completedEvent(patch: Record<string, unknown> = {}): StripeWebhookEvent {
  return {
    id: "evt_ai_5",
    type: "checkout.session.completed",
    created: 1_788_172_400,
    data: {
      object: {
        id: "cs_ai_5",
        mode: "payment",
        status: "complete",
        payment_status: "paid",
        amount_total: 500,
        currency: "usd",
        client_reference_id: identity.ownerId,
        metadata: completedMetadata(),
        ...patch,
      },
    },
  };
}
