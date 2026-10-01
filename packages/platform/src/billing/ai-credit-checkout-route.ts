import type { Context, Handler } from "hono";
import { createHash } from "node:crypto";
import { getActiveUserMachineByClerkId, type PlatformDB } from "../db.js";
import { AiCreditCheckoutRequestSchema, findAiCreditPackage, type AiCreditCheckoutConfig } from "../ai-credit-checkout.js";
import { AiCreditCheckoutStoreError, finalizeAiCreditCheckoutClaim, getClaimByRequestId,
  prepareAiCreditCheckoutClaim } from "../ai-credit-checkout-store.js";
import { isAiCreditCheckoutRouteHealthy } from "../ai-credit-checkout-readiness.js";
import type { AiFundedPolicyRepository } from "../ai-funded-policy-repository.js";
import type { FundedModelProbeService } from "../ai-funded-model-probes.js";
import { resolveBillingReturnUrl } from "./checkout-support.js";
import { MAX_STRIPE_API_TIMEOUT_MS, type StripeBillingClient } from "./stripe-client.js";

/** Registration supplies the same owner/auth/config dependencies as billing. */
export function createAiCreditCheckoutHandler(options: {
  db: PlatformDB;
  stripe: StripeBillingClient;
  env: NodeJS.ProcessEnv;
  checkout: AiCreditCheckoutConfig;
  fundedAiRepository?: Pick<AiFundedPolicyRepository, "getCheckoutFundingSummary">;
  fundedModelProbes?: FundedModelProbeService;
  resolveClerkUserId: (c: Context) => Promise<string | null>;
  now: () => Date;
  unavailableResponse: { error: string; code: string };
}): Handler {
  return async (c) => {
    const clerkUserId = await options.resolveClerkUserId(c);
    if (!clerkUserId) return c.json({ error: "Unauthorized" }, 401);
    if (!options.fundedAiRepository) return c.json(options.unavailableResponse, 503);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (err: unknown) {
      if (err instanceof SyntaxError) return c.json({ error: "Invalid request" }, 400);
      throw err;
    }
    const parsed = AiCreditCheckoutRequestSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "Invalid request" }, 400);
    try {
      if (options.stripe.apiTimeoutMs > MAX_STRIPE_API_TIMEOUT_MS) {
        throw new Error("stripe_timeout_exceeds_budget");
      }
      const machine = await getActiveUserMachineByClerkId(options.db, clerkUserId, parsed.data.runtimeSlot);
      if (!machine || machine.status !== "running" || machine.activationState !== "authorized") {
        return c.json({ error: "Computer is unavailable", code: "runtime_unavailable" }, 409);
      }
      const idempotencyKey = `matrix-ai-credit:${createHash("sha256")
        .update(`${clerkUserId}\0${machine.machineId}\0${parsed.data.requestId}`)
        .digest("hex")}`;
      const persisted = await getClaimByRequestId(options.db, parsed.data.requestId);
      if (persisted && (persisted.owner_id !== clerkUserId || persisted.machine_id !== machine.machineId
        || persisted.runtime_slot !== machine.runtimeSlot || persisted.package_id !== parsed.data.packageId
        || persisted.idempotency_key !== idempotencyKey)) {
        throw new AiCreditCheckoutStoreError("conflict");
      }
      const selectedPackage = findAiCreditPackage(options.checkout, parsed.data.packageId);
      if (!persisted && !selectedPackage) return c.json(options.unavailableResponse, 503);
      if (!persisted && !await isAiCreditCheckoutRouteHealthy({
        repository: options.fundedAiRepository,
        identity: { ownerId: clerkUserId, machineId: machine.machineId, runtimeSlot: machine.runtimeSlot },
        modelProbes: options.fundedModelProbes,
        now: options.now,
        signal: c.req.raw.signal,
      })) return c.json(options.unavailableResponse, 503);
      if (c.req.raw.signal.aborted) return c.json(options.unavailableResponse, 503);
      const claim = persisted ?? await prepareAiCreditCheckoutClaim(options.db, {
        idempotencyKey, requestId: parsed.data.requestId, ownerId: clerkUserId,
        machineId: machine.machineId, runtimeSlot: machine.runtimeSlot,
        packageId: selectedPackage!.id, priceId: selectedPackage!.priceId,
        amountMicrousd: selectedPackage!.amountMicrousd, amountCents: selectedPackage!.amountCents,
        currency: selectedPackage!.currency, automaticTax: options.checkout.enabled && options.checkout.automaticTax,
      }, options.now());
      if (c.req.raw.signal.aborted) return c.json(options.unavailableResponse, 503);
      if (claim.checkout_url) return c.json({ url: claim.checkout_url }, 200);
      const session = await options.stripe.createAiCreditCheckoutSession({
        idempotencyKey: claim.idempotency_key,
        requestId: claim.request_id,
        clerkUserId: claim.owner_id,
        machineId: claim.machine_id,
        runtimeSlot: claim.runtime_slot,
        packageId: claim.package_id,
        priceId: claim.stripe_price_id,
        amountMicrousd: Number(claim.amount_microusd),
        automaticTax: claim.automatic_tax,
        successUrl: resolveBillingReturnUrl(options.env, "success"),
        cancelUrl: resolveBillingReturnUrl(options.env, "canceled"),
      });
      const finalized = await finalizeAiCreditCheckoutClaim(
        options.db, claim.request_id, session, options.now().toISOString(),
      );
      return c.json({ url: finalized.checkout_url }, 200);
    } catch (err: unknown) {
      if (err instanceof AiCreditCheckoutStoreError) {
        if (err.code === "rate_limited") return c.json({ error: "Too many requests" }, 429);
        if (err.code === "conflict") return c.json({ error: "Checkout already active" }, 409);
      }
      console.error("[billing] AI credit checkout failed:", err instanceof Error ? err.name : typeof err);
      return c.json(options.unavailableResponse, 503);
    }
  };
}
