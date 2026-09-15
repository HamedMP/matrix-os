jest.mock("@/lib/storage", () => ({
  HOSTED_GATEWAY_URL: "https://app.matrix-os.com",
}));

// The @matrix-os/contracts barrel reaches chat-sharing.ts -> ESM-only micromark,
// which Jest cannot transform here. That is unrelated to billing, so re-export
// the real billing schema module directly rather than stubbing the validation
// under test.
jest.mock("@matrix-os/contracts", () => require("../../../packages/contracts/src/billing-public"));

import { Linking } from "react-native";

import { createMobileBillingPortal } from "@/lib/requests/settings";

const portalResponse = (body: unknown) => ({
  ok: true,
  json: jest.fn().mockResolvedValue(body),
}) as unknown as Response;

describe("Native Mobile billing portal redirect", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it("returns a normal Stripe HTTPS redirect", async () => {
    const url = "https://billing.stripe.com/p/session/live_abc123";
    jest.spyOn(global, "fetch").mockResolvedValue(portalResponse({ url }));

    await expect(createMobileBillingPortal("clerk-token")).resolves.toBe(url);
  });

  it.each([
    ["a relative path", "/billing/portal"],
    ["a plaintext URL", "http://billing.stripe.com/p/session"],
    // eslint-disable-next-line no-script-url
    ["an executable scheme", "javascript:alert(1)"],
    ["a data URL", "data:text/html,<script>alert(1)</script>"],
    ["an overlong URL", `https://billing.stripe.com/p/${"a".repeat(2048)}`],
  ])("rejects %s instead of returning it", async (_label, url) => {
    jest.spyOn(global, "fetch").mockResolvedValue(portalResponse({ url }));

    await expect(createMobileBillingPortal("clerk-token")).rejects.toThrow();
  });

  it("rejects a missing redirect URL", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(portalResponse({}));

    await expect(createMobileBillingPortal("clerk-token")).rejects.toThrow();
  });

  // The billing screen calls `await Linking.openURL(await openPortal())`, so a
  // rejected redirect must reject before openURL is ever reached.
  it("never passes an unsafe redirect to Linking.openURL", async () => {
    const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined as never);
    jest.spyOn(global, "fetch").mockResolvedValue(
      // eslint-disable-next-line no-script-url
      portalResponse({ url: "javascript:alert(1)" }),
    );

    await expect(
      (async () => {
        await Linking.openURL(await createMobileBillingPortal("clerk-token"));
      })(),
    ).rejects.toThrow();
    expect(openURL).not.toHaveBeenCalled();
  });

  it("does not expose the upstream response in the surfaced error", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(
      // eslint-disable-next-line no-script-url
      portalResponse({ url: "javascript:alert(1)" }),
    );

    // Assert the exact generic message rather than the absence of a pattern:
    // a "does not match" assertion also passes for an unrelated rejection.
    await expect(createMobileBillingPortal("clerk-token")).rejects.toThrow(
      "Billing portal unavailable. Try again.",
    );
  });
});
