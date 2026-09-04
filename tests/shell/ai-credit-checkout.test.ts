// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  currentAiCreditRuntimeSlot,
  openWebAiCreditCheckout,
} from "../../shell/src/lib/ai-credit-checkout.js";

afterEach(() => {
  window.history.replaceState({}, "", "/");
  vi.restoreAllMocks();
});

describe("web AI credit checkout", () => {
  it("posts one package and request UUID for the active runtime, then navigates to HTTPS Stripe Checkout", async () => {
    window.history.replaceState({}, "", "/vm/alice?runtime=studio");
    const fetcher = vi.fn(async () => Response.json({
      url: "https://checkout.stripe.com/c/pay/cs_ai_10",
    }));
    const navigate = vi.fn();

    await openWebAiCreditCheckout({
      packageId: "usd_10",
      runtimeSlot: currentAiCreditRuntimeSlot(),
      requestId: "77f105df-6e24-4e13-a881-af9ce20d6a63",
      fetcher,
      navigate,
    });

    expect(fetcher).toHaveBeenCalledWith("/billing/ai-credit/checkout", expect.objectContaining({
      method: "POST",
      credentials: "include",
      signal: expect.any(AbortSignal),
      body: JSON.stringify({
        packageId: "usd_10",
        runtimeSlot: "studio",
        requestId: "77f105df-6e24-4e13-a881-af9ce20d6a63",
      }),
    }));
    expect(navigate).toHaveBeenCalledWith("https://checkout.stripe.com/c/pay/cs_ai_10");
  });

  it("fails safely on oversized, malformed, non-HTTPS, and non-Stripe responses", async () => {
    const cases = [
      new Response("x".repeat(9_000), { headers: { "content-length": "9000" } }),
      Response.json({ url: "not a url" }),
      Response.json({ url: "http://checkout.stripe.com/c/pay/cs_bad" }),
      Response.json({ url: "https://evil.example/steal" }),
    ];
    for (const response of cases) {
      await expect(openWebAiCreditCheckout({
        packageId: "usd_5",
        requestId: crypto.randomUUID(),
        fetcher: vi.fn(async () => response),
        navigate: vi.fn(),
      })).rejects.toMatchObject({ message: "Checkout is unavailable." });
    }
  });
});
