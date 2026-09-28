// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  currentAiCreditRuntimeSlot,
  openWebAiCreditCheckout,
} from "../../shell/src/lib/ai-credit-checkout.js";

afterEach(() => {
  window.history.replaceState({}, "", "/");
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("web AI credit checkout", () => {
  it("waits for cold readiness and a bounded payment-session response without retrying", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
      return controller.signal;
    });
    const fetcher = vi.fn<typeof fetch>((_url, init) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(Response.json({ url: "https://checkout.stripe.com/c/pay/cs_cold" })), 18_000);
      init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal?.reason); }, { once: true });
    }));
    const navigate = vi.fn();
    const completed = openWebAiCreditCheckout({ packageId: "usd_5", requestId: crypto.randomUUID(), fetcher, navigate })
      .then(() => true, () => false);
    await vi.advanceTimersByTimeAsync(18_000);
    expect(await completed).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith("https://checkout.stripe.com/c/pay/cs_cold");
  });

  it("cancels the actual checkout fetch when its caller leaves and never navigates", async () => {
    const caller = new AbortController();
    let requestSignal: AbortSignal | null | undefined;
    const fetcher = vi.fn<typeof fetch>((_url, init) => {
      requestSignal = init?.signal;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    const navigate = vi.fn();
    const result = openWebAiCreditCheckout({ packageId: "usd_5", requestId: crypto.randomUUID(),
      fetcher, navigate, signal: caller.signal }).then(() => true, () => false);
    caller.abort();
    expect(requestSignal?.aborted).toBe(true);
    expect(await result).toBe(false);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("cancels a stalled checkout at the bounded total deadline without retrying", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
      return controller.signal;
    });
    let requestSignal: AbortSignal | null | undefined;
    const fetcher = vi.fn<typeof fetch>((_url, init) => {
      requestSignal = init?.signal;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    const navigate = vi.fn();
    const result = openWebAiCreditCheckout({ packageId: "usd_5", requestId: crypto.randomUUID(), fetcher, navigate })
      .then(() => true, () => false);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(requestSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(requestSignal?.aborted).toBe(true);
    expect(await result).toBe(false);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("rejects a late checkout response after caller cancellation", async () => {
    const caller = new AbortController();
    let resolveResponse!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>(() => new Promise(resolve => { resolveResponse = resolve; }));
    const navigate = vi.fn();
    const result = openWebAiCreditCheckout({ packageId: "usd_5", requestId: crypto.randomUUID(),
      fetcher, navigate, signal: caller.signal }).then(() => true, () => false);
    caller.abort();
    resolveResponse(Response.json({ url: "https://checkout.stripe.com/c/pay/cs_late" }));
    expect(await result).toBe(false);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
  });

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
