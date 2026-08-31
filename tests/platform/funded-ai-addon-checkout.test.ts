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
    await repository.updateGlobalPolicy({
      expectedRevision: 0,
      enabled: true,
      allowedModelIds: ["anthropic/claude-sonnet-5"],
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

  async function createCheckout(env: NodeJS.ProcessEnv = checkoutEnv, requestId = completedMetadata().matrix_ai_credit_request_id) {
    return app(identity.ownerId, env).request("/billing/ai-credit/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ packageId: "usd_5", runtimeSlot: "primary", requestId }),
    });
  }

  async function deliver(event: StripeWebhookEvent) {
    webhookEvent = event;
    return app().request("/billing/webhooks/stripe", {
      method: "POST", headers: { "stripe-signature": "signed" }, body: "{}",
    });
  }

  async function purchaseCredit() {
    expect((await createCheckout()).status).toBe(200);
    expect((await deliver(completedEvent())).status).toBe(200);
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
    expect((await createCheckout()).status).toBe(200);
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
    ["wrong amount", { amount_total: 499 }],
    ["wrong subtotal", { amount_subtotal: 499 }],
    ["wrong currency", { currency: "eur" }],
    ["wrong owner", { client_reference_id: "user_other" }],
    ["wrong machine", { metadata: { ...completedMetadata(), matrix_machine_id: "machine_other" } }],
    ["wrong mode", { mode: "subscription" }],
  ])("rejects %s completion without persisting a receipt or credit", async (_label, patch) => {
    expect((await createCheckout()).status).toBe(200);
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

  it("uses the immutable checkout claim after feature disable or price rotation and treats tax as additional", async () => {
    const taxEnv = { ...checkoutEnv, MATRIX_AI_CREDIT_STRIPE_TAX_REGISTRATIONS_VERIFIED: "true" };
    expect((await createCheckout(taxEnv)).status).toBe(200);
    webhookEvent = completedEvent({ amount_subtotal: 500, amount_total: 550 });
    const disabledEnv = { ...checkoutEnv, MATRIX_FUNDED_AI_ADDON_CHECKOUT_ENABLED: "false", STRIPE_PRICE_AI_CREDIT_USD_5: "price_rotated" };
    const retry = await createCheckout(disabledEnv);
    expect(retry.status).toBe(200);
    expect(stripe.createAiCreditCheckoutSession).toHaveBeenCalledTimes(1);
    const response = await app(identity.ownerId, disabledEnv).request("/billing/webhooks/stripe", {
      method: "POST", headers: { "stripe-signature": "signed" }, body: "{}",
    });
    expect(response.status).toBe(200);
    await expect(repository.getFundingSummary(identity)).resolves.toMatchObject({ creditBalanceMicrousd: 5_000_000 });
  });

  it("waits for asynchronous payment success and never grants failed or unpaid Checkout", async () => {
    expect((await createCheckout()).status).toBe(200);
    webhookEvent = completedEvent({ payment_status: "unpaid" });
    expect((await app().request("/billing/webhooks/stripe", {
      method: "POST", headers: { "stripe-signature": "signed" }, body: "{}",
    })).status).toBe(200);
    expect(await db.executor.selectFrom("ai_funded_credit_ledger").selectAll().execute()).toEqual([]);

    webhookEvent = completedEvent({ payment_status: "paid" });
    webhookEvent.id = "evt_ai_async_success";
    webhookEvent.type = "checkout.session.async_payment_succeeded";
    expect((await app().request("/billing/webhooks/stripe", {
      method: "POST", headers: { "stripe-signature": "signed" }, body: "{}",
    })).status).toBe(200);
    expect(await db.executor.selectFrom("ai_funded_credit_ledger").selectAll().execute()).toHaveLength(1);
  });

  it("records asynchronous failure and expiry without ever granting credit", async () => {
    expect((await createCheckout()).status).toBe(200);
    webhookEvent = completedEvent({ payment_status: "unpaid" });
    webhookEvent.id = "evt_ai_async_failed";
    webhookEvent.type = "checkout.session.async_payment_failed";
    expect((await app().request("/billing/webhooks/stripe", {
      method: "POST", headers: { "stripe-signature": "signed" }, body: "{}",
    })).status).toBe(200);
    webhookEvent = completedEvent({ status: "expired", payment_status: "unpaid" });
    webhookEvent.id = "evt_ai_expired";
    webhookEvent.type = "checkout.session.expired";
    expect((await app().request("/billing/webhooks/stripe", {
      method: "POST", headers: { "stripe-signature": "signed" }, body: "{}",
    })).status).toBe(200);
    expect(await db.executor.selectFrom("ai_funded_credit_ledger").selectAll().execute()).toEqual([]);
    expect(await db.executor.selectFrom("ai_credit_checkout_claims").select("status").executeTakeFirst())
      .toEqual({ status: "expired" });
  });

  it("reuses an active attempt and durably rate limits repeated Checkout creation", async () => {
    expect((await createCheckout()).status).toBe(200);
    const second = await createCheckout(checkoutEnv, "2cdca480-3baa-42ae-a77b-e1a0cb51f1ea");
    expect(second.status).toBe(200);
    expect(stripe.createAiCreditCheckoutSession).toHaveBeenCalledTimes(1);

    await db.executor.updateTable("ai_credit_checkout_claims").set({ status: "expired" }).execute();
    vi.mocked(stripe.createAiCreditCheckoutSession).mockImplementation(async (input) => ({
      id: `cs_${input.requestId.replaceAll("-", "")}`,
      url: `https://checkout.stripe.test/${input.requestId}`,
    }));
    for (let index = 1; index < 5; index += 1) {
      const response = await createCheckout(checkoutEnv, `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
      expect(response.status).toBe(200);
      await db.executor.updateTable("ai_credit_checkout_claims").set({ status: "expired" })
        .where("request_id", "=", `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`).execute();
    }
    const limited = await createCheckout(checkoutEnv, "00000000-0000-4000-8000-000000000099");
    expect(limited.status).toBe(429);
  });

  it("atomically reverses refunded credit, records consumed-credit debt, and restores a won dispute", async () => {
    const credential = await repository.issueRuntimeCredential(identity);
    expect((await createCheckout()).status).toBe(200);
    expect((await app().request("/billing/webhooks/stripe", {
      method: "POST", headers: { "stripe-signature": "signed" }, body: "{}",
    })).status).toBe(200);

    webhookEvent = disputeEvent("charge.dispute.created", "under_review", "evt_dispute_created");
    expect((await app().request("/billing/webhooks/stripe", {
      method: "POST", headers: { "stripe-signature": "signed" }, body: "{}",
    })).status).toBe(200);
    expect(await db.executor.selectFrom("ai_funded_credit_restrictions").selectAll().executeTakeFirst()).toMatchObject({ frozen: true });
    await expect(repository.getFundingSummary(identity)).resolves.toMatchObject({ creditBalanceMicrousd: 0 });

    webhookEvent = disputeEvent("charge.dispute.closed", "won", "evt_dispute_won");
    expect((await app().request("/billing/webhooks/stripe", {
      method: "POST", headers: { "stripe-signature": "signed" }, body: "{}",
    })).status).toBe(200);
    await expect(repository.getFundingSummary(identity)).resolves.toMatchObject({ creditBalanceMicrousd: 5_000_000 });
    expect(await db.executor.selectFrom("ai_funded_credit_restrictions").selectAll().executeTakeFirst()).toMatchObject({ frozen: false, debt_microusd: 0 });

    await db.executor.updateTable("ai_funded_runtime_balances").set({
      credit_balance_microusd: 0, addon_balance_microusd: 0,
    }).where("machine_id", "=", identity.machineId).execute();
    webhookEvent = refundedEvent();
    expect((await app().request("/billing/webhooks/stripe", {
      method: "POST", headers: { "stripe-signature": "signed" }, body: "{}",
    })).status).toBe(200);
    expect(await db.executor.selectFrom("ai_funded_credit_restrictions").selectAll().executeTakeFirst()).toMatchObject({
      frozen: true, debt_microusd: 5_000_000,
    });
    await expect(repository.authorize({
      credential: credential.credential.token,
      requestId: "refund_blocked_spend",
      modelId: "anthropic/claude-sonnet-5",
      maxCostMicrousd: 1,
    })).rejects.toMatchObject({ code: "access_disabled" });
  });

  it("ignores unrelated Stripe refunds without trapping subscription webhook delivery", async () => {
    webhookEvent = {
      id: "evt_unrelated_refund", type: "charge.refunded", created: 1_788_172_700,
      data: { object: { id: "ch_subscription", payment_intent: "pi_subscription", amount_refunded: 1_000, currency: "eur" } },
    };
    const response = await app().request("/billing/webhooks/stripe", {
      method: "POST", headers: { "stripe-signature": "signed" }, body: "{}",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, ignored: true });
    expect(await db.executor.selectFrom("ai_funded_credit_ledger").selectAll().execute()).toEqual([]);
  });

  it("does not regress a won dispute when created or opposite terminal events arrive late", async () => {
    await purchaseCredit();
    expect((await deliver(disputeEvent("charge.dispute.created", "under_review", "evt_won_created"))).status).toBe(200);
    expect((await deliver(disputeEvent("charge.dispute.closed", "won", "evt_won_closed"))).status).toBe(200);
    expect((await deliver(disputeEvent("charge.dispute.created", "needs_response", "evt_won_late_created"))).status).toBe(200);
    expect((await deliver(disputeEvent("charge.dispute.closed", "lost", "evt_won_late_lost"))).status).toBe(200);

    expect(await db.executor.selectFrom("ai_credit_checkout_claims")
      .select(["dispute_status", "reversed_microusd"]).executeTakeFirst()).toEqual({
      dispute_status: "won", reversed_microusd: 0,
    });
    await expect(repository.getFundingSummary(identity)).resolves.toMatchObject({ creditBalanceMicrousd: 5_000_000 });
    expect(await db.executor.selectFrom("ai_funded_credit_restrictions").selectAll().executeTakeFirst())
      .toMatchObject({ frozen: false, debt_microusd: 0 });
  });

  it("does not regress a lost dispute when created or opposite terminal events arrive late", async () => {
    await purchaseCredit();
    expect((await deliver(disputeEvent("charge.dispute.created", "under_review", "evt_lost_created"))).status).toBe(200);
    expect((await deliver(disputeEvent("charge.dispute.closed", "lost", "evt_lost_closed"))).status).toBe(200);
    expect((await deliver(disputeEvent("charge.dispute.created", "needs_response", "evt_lost_late_created"))).status).toBe(200);
    expect((await deliver(disputeEvent("charge.dispute.closed", "won", "evt_lost_late_won"))).status).toBe(200);

    expect(await db.executor.selectFrom("ai_credit_checkout_claims")
      .select(["dispute_status", "reversed_microusd"]).executeTakeFirst()).toEqual({
      dispute_status: "lost", reversed_microusd: 5_000_000,
    });
    await expect(repository.getFundingSummary(identity)).resolves.toMatchObject({ creditBalanceMicrousd: 0 });
    expect(await db.executor.selectFrom("ai_funded_credit_restrictions").selectAll().executeTakeFirst())
      .toMatchObject({ frozen: true });
  });

  it("keeps refund reversal but clears zero-debt dispute freeze when a refunded dispute is won", async () => {
    await purchaseCredit();
    expect((await deliver(disputeEvent("charge.dispute.created", "under_review", "evt_refunded_created"))).status).toBe(200);
    expect((await deliver(refundedEvent())).status).toBe(200);
    expect((await deliver(disputeEvent("charge.dispute.closed", "won", "evt_refunded_won"))).status).toBe(200);

    expect(await db.executor.selectFrom("ai_credit_checkout_claims")
      .select(["dispute_status", "refunded_at", "reversed_microusd", "reversal_debt_microusd"])
      .executeTakeFirst()).toEqual({
      dispute_status: "won",
      refunded_at: "2026-08-31T10:00:00.000Z",
      reversed_microusd: 5_000_000,
      reversal_debt_microusd: 0,
    });
    await expect(repository.getFundingSummary(identity)).resolves.toMatchObject({ creditBalanceMicrousd: 0 });
    expect(await db.executor.selectFrom("ai_funded_credit_restrictions").selectAll().executeTakeFirst())
      .toMatchObject({ frozen: false, debt_microusd: 0 });
  });

  it.each(["won", "lost"] as const)(
    "freezes an already-refunded runtime for a later dispute, then settles %s monotonically and idempotently",
    async (resolution) => {
      await purchaseCredit();
      expect((await deliver(refundedEvent())).status).toBe(200);
      expect(await db.executor.selectFrom("ai_funded_credit_restrictions").selectAll().executeTakeFirst())
        .toMatchObject({ frozen: false, debt_microusd: 0 });

      const created = disputeEvent(
        "charge.dispute.created",
        "under_review",
        `evt_refund_first_${resolution}_created`,
      );
      expect((await deliver(created)).status).toBe(200);
      expect(await db.executor.selectFrom("ai_funded_credit_restrictions").selectAll().executeTakeFirst())
        .toMatchObject({ frozen: true, debt_microusd: 0 });
      await expect((await deliver(created)).json()).resolves.toEqual({ received: true, duplicate: true });
      expect((await deliver(disputeEvent(
        "charge.dispute.created",
        "needs_response",
        `evt_refund_first_${resolution}_created_retry`,
      ))).status).toBe(200);

      expect((await deliver(disputeEvent(
        "charge.dispute.closed",
        resolution,
        `evt_refund_first_${resolution}_closed`,
      ))).status).toBe(200);
      expect((await deliver(disputeEvent(
        "charge.dispute.created",
        "needs_response",
        `evt_refund_first_${resolution}_late_created`,
      ))).status).toBe(200);

      expect(await db.executor.selectFrom("ai_credit_checkout_claims")
        .select(["dispute_status", "refunded_at", "reversed_microusd", "reversal_debt_microusd"])
        .executeTakeFirst()).toEqual({
        dispute_status: resolution,
        refunded_at: "2026-08-31T10:00:00.000Z",
        reversed_microusd: 5_000_000,
        reversal_debt_microusd: 0,
      });
      await expect(repository.getFundingSummary(identity)).resolves.toMatchObject({ creditBalanceMicrousd: 0 });
      expect(await db.executor.selectFrom("ai_funded_credit_restrictions").selectAll().executeTakeFirst())
        .toMatchObject({ frozen: resolution === "lost", debt_microusd: 0 });
      expect(await db.executor.selectFrom("ai_funded_credit_ledger").selectAll().execute()).toHaveLength(2);
    },
  );
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
        payment_intent: "pi_ai_5",
        amount_subtotal: 500,
        amount_total: 500,
        currency: "usd",
        client_reference_id: identity.ownerId,
        metadata: completedMetadata(),
        ...patch,
      },
    },
  };
}

function disputeEvent(type: string, status: string, id: string): StripeWebhookEvent {
  return {
    id, type, created: 1_788_172_500,
    data: { object: { id: `dp_${id}`, charge: "ch_ai_5", payment_intent: "pi_ai_5", status } },
  };
}

function refundedEvent(): StripeWebhookEvent {
  return {
    id: "evt_refund", type: "charge.refunded", created: 1_788_172_600,
    data: { object: { id: "ch_ai_5", payment_intent: "pi_ai_5", amount_refunded: 500, currency: "usd" } },
  };
}
