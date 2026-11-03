import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserSetupTransport, createHostedBrowserSetupTransport } from "../../packages/ui/src/browser/setup-transport.js";
afterEach(() => vi.unstubAllGlobals());
describe("shared Browser setup transport", () => {
  it("requires the advertised native capability and never calls an older Desktop bridge", async () => {
    const gatewayFetch = vi.fn(async () => ({ status: "ready", retryAvailable: false }));
    const legacy = createHostedBrowserSetupTransport({ gatewayFetch });
    expect(legacy.requiresDesktopUpdate).toBe(true);
    await expect(legacy.status(new AbortController().signal)).rejects.toThrow("Desktop update required");
    expect(gatewayFetch).not.toHaveBeenCalled();
    const current = createHostedBrowserSetupTransport({ gatewayFetch, browserSetup: true });
    expect(current.requiresDesktopUpdate).toBe(false);
    await expect(current.status(new AbortController().signal)).resolves.toEqual({ status: "ready", retryAvailable: false });
    expect(gatewayFetch).toHaveBeenCalledWith("/api/browser/setup", {}, 10_000);
  });
  it("uses fixed authenticated scoped endpoints, empty retry body, timeout and no redirects", async () => {
    const fetcher = vi.fn(async () => Response.json({ status: "installing", retryAvailable: false })); vi.stubGlobal("fetch", fetcher);
    const client = createBrowserSetupTransport("https://app.matrix-os.com/vm/main-computer");
    await client.status(new AbortController().signal); await client.retry(new AbortController().signal);
    expect(fetcher).toHaveBeenNthCalledWith(1, "https://app.matrix-os.com/vm/main-computer/api/browser/setup", expect.objectContaining({ credentials: "include", method: "GET", redirect: "error", signal: expect.any(AbortSignal) }));
    expect(fetcher).toHaveBeenNthCalledWith(2, "https://app.matrix-os.com/vm/main-computer/api/browser/setup/retry", expect.objectContaining({ method: "POST", body: "{}" }));
  });
  it("retains legacy viewer admission for runtimes without setup API but never retries through a missing API", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    const client = createBrowserSetupTransport("https://app.matrix-os.com/vm/pr-2526");
    expect(await client.status(new AbortController().signal)).toEqual({ status: "ready", retryAvailable: false });
    await expect(client.retry(new AbortController().signal)).rejects.toThrow("Browser setup unavailable");
  });
  it("bounds a chunked native-status response before parsing", async () => {
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("x".repeat(4097))); }, cancel }))));
    await expect(createBrowserSetupTransport("https://app.matrix-os.com").status(new AbortController().signal)).rejects.toThrow("Browser setup unavailable");
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
