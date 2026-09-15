import { describe, expect, it } from "vitest";

import {
  MatrixBillingRedirectSchema,
  MatrixBillingStatusSchema,
  parseBillingRedirectUrl,
} from "@matrix-os/contracts";

describe("public billing status contract", () => {
  it("accepts provider-neutral entitlement metadata", () => {
    const result = MatrixBillingStatusSchema.parse({
      entitlement: {
        source: "stripe",
        planSlug: "matrix_builder",
        status: "active",
        maxRuntimeSlots: 1,
        includedRuntimeSlots: 1,
        addonRuntimeSlots: 0,
        allowedPlanSlugs: ["matrix_starter", "matrix_builder"],
        allowedSelections: [
          { planSlug: "matrix_starter", regionSlug: "region_fsn1" },
          { planSlug: "matrix_builder", regionSlug: "region_ash" },
        ],
        portalAvailable: true,
        billingInterval: "monthly",
        recurringPrice: {
          unitAmountMinor: 2000,
          currency: "usd",
          interval: "monthly",
          intervalCount: 1,
          quantity: 1,
        },
        runtimePlacement: {
          regionSlug: "region_ash",
          label: "Ashburn, Virginia",
          countryLabel: "United States",
          networkZone: "us-east",
        },
        gracePeriodEndsAt: null,
        trialStartedAt: null,
        trialEndsAt: null,
        trialConvertedAt: null,
        firstTrialPaymentFailedAt: null,
        effectiveFrom: "2026-08-31T00:00:00.000Z",
        effectiveUntil: null,
        updatedAt: "2026-08-31T00:00:00.000Z",
      },
      access: { runtimeProxyAllowed: true, reason: "active" },
      trialOffer: { eligible: false, durationDays: 3 },
    });

    expect(result.entitlement?.allowedPlanSlugs).toEqual([
      "matrix_starter",
      "matrix_builder",
    ]);
    expect(result.entitlement?.allowedSelections).toEqual([
      { planSlug: "matrix_starter", regionSlug: "region_fsn1" },
      { planSlug: "matrix_builder", regionSlug: "region_ash" },
    ]);
    expect(result.entitlement?.recurringPrice?.unitAmountMinor).toBe(2000);
    expect(result.entitlement?.runtimePlacement?.label).toBe("Ashburn, Virginia");
  });

  it("rejects provider and payment-processor identifiers", () => {
    const common = {
      source: "stripe",
      planSlug: "matrix_builder",
      status: "active",
      maxRuntimeSlots: 1,
      includedRuntimeSlots: 1,
      addonRuntimeSlots: 0,
      allowedPlanSlugs: ["matrix_builder"],
      allowedSelections: [{ planSlug: "matrix_builder", regionSlug: "region_ash" }],
      portalAvailable: true,
      recurringPrice: null,
      runtimePlacement: null,
      gracePeriodEndsAt: null,
      effectiveFrom: "2026-08-31T00:00:00.000Z",
      effectiveUntil: null,
      updatedAt: "2026-08-31T00:00:00.000Z",
    };

    for (const leakedField of [
      { clerkUserId: "user_secret" },
      { defaultServerType: "cpx31" },
      { allowedServerTypes: ["cpx31"] },
      { stripeSubscriptionId: "sub_secret" },
      { stripePriceId: "price_secret" },
      { serverType: "cpx31" },
      { provider: "hetzner" },
    ]) {
      expect(() => MatrixBillingStatusSchema.parse({
        entitlement: { ...common, ...leakedField },
        access: { runtimeProxyAllowed: true, reason: "active" },
        trialOffer: { eligible: false, durationDays: 3 },
      })).toThrow();
    }
  });
});

describe("billing redirect contract", () => {
  const httpsUrl = "https://billing.stripe.com/p/session/live_abc123";

  it("accepts a normal Stripe HTTPS redirect", () => {
    expect(MatrixBillingRedirectSchema.parse({ url: httpsUrl })).toEqual({ url: httpsUrl });
    expect(parseBillingRedirectUrl({ url: httpsUrl })).toBe(httpsUrl);
  });

  it("rejects redirects that could navigate a client somewhere unsafe", () => {
    for (const url of [
      "/billing/portal",
      "billing.stripe.com/p/session",
      "http://billing.stripe.com/p/session",
      // eslint-disable-next-line no-script-url
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "",
      `https://billing.stripe.com/p/${"a".repeat(2048)}`,
      // Embedded credentials render an attacker-controlled authority while
      // still parsing as https.
      "https://evil.example@billing.stripe.com/p/session",
      "https://billing.stripe.com:pass@evil.example/p/session",
    ]) {
      expect(MatrixBillingRedirectSchema.safeParse({ url }).success, url).toBe(false);
      expect(parseBillingRedirectUrl({ url }), url).toBeNull();
    }
  });

  it("rejects malformed or missing redirect bodies without throwing", () => {
    for (const body of [null, undefined, {}, { url: 42 }, { url: null }, "https://ok.example"]) {
      expect(parseBillingRedirectUrl(body)).toBeNull();
    }
  });

  it("rejects unexpected fields so a regressed response cannot smuggle data", () => {
    expect(
      MatrixBillingRedirectSchema.safeParse({ url: httpsUrl, redirect: "https://evil.example" })
        .success,
    ).toBe(false);
  });

  // Native Mobile parses the portal response with this schema directly
  // (apps/mobile/lib/requests/settings.ts). Client-level coverage, including the
  // guarantee that a rejected redirect never reaches Linking.openURL, lives in
  // apps/mobile/__tests__/billing-portal-redirect.test.ts.
  it("rejects the unsafe redirects Native Mobile previously accepted", () => {
    for (const url of ["http://billing.stripe.com/p/session", "billing.stripe.com/p"]) {
      expect(MatrixBillingRedirectSchema.safeParse({ url }).success).toBe(false);
    }
  });

  it("pins the length bound at exactly 2048 characters", () => {
    const prefix = "https://billing.stripe.com/p/";
    const maxUrl = prefix + "a".repeat(2048 - prefix.length);
    expect(maxUrl).toHaveLength(2048);
    expect(parseBillingRedirectUrl({ url: maxUrl })).toBe(maxUrl);

    // One character over must be rejected, so the bound is pinned rather than
    // merely "long strings fail".
    const overUrl = `${maxUrl}a`;
    expect(overUrl).toHaveLength(2049);
    expect(parseBillingRedirectUrl({ url: overUrl })).toBeNull();
  });
});
