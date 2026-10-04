// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createWebProviderWorkflowClient, loadWebAiCreditHistory, openWebProviderWorkflowAuthorization } from "../../shell/src/lib/provider-workflow-transport.js";
vi.mock("../../shell/src/lib/gateway.js", () => ({ getGatewayUrl: () => "/vm/review" }));
const page = { entries: [], nextCursor: null };
describe("web provider workflow transport", () => {
  it("invokes default browser fetch with the global receiver for workflows and history", async () => {
    const browserFetch = vi.fn(function(this: unknown, path: RequestInfo | URL, init?: RequestInit) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Promise.resolve(Response.json(String(path).startsWith("/billing/") ? page : []));
    });
    vi.stubGlobal("fetch", browserFetch);
    try {
      await expect(createWebProviderWorkflowClient().capabilities(new AbortController().signal)).resolves.toEqual([]);
      await expect(loadWebAiCreditHistory({runtimeSlot: "primary", cursor: null, signal: new AbortController().signal})).resolves.toEqual(page);
      await expect(createWebProviderWorkflowClient({fetcher: browserFetch}).capabilities(new AbortController().signal)).resolves.toEqual([]);
      expect(browserFetch).toHaveBeenCalledTimes(3);
      expect(browserFetch.mock.calls[0][1]).toMatchObject({credentials: "include", cache: "no-store"});
    } finally { vi.unstubAllGlobals(); }
  });
  it("distinguishes a confirmed key rejection from an uncertain transport failure", async () => {
    const input = { harnessInstanceId: "codex", providerId: "openai" as const, apiKey: "synthetic-key" };
    const rejected = createWebProviderWorkflowClient({ fetcher: vi.fn().mockResolvedValue(
      Response.json({ error: { code: "rejected", message: "safe rejection" } }, { status: 400 }),
    ) });
    await expect(rejected.submitKey(input, new AbortController().signal)).rejects.toMatchObject({ reason: "rejected" });
    const uncertain = createWebProviderWorkflowClient({ fetcher: vi.fn().mockRejectedValue(new TypeError("private network details")) });
    await expect(uncertain.submitKey(input, new AbortController().signal)).rejects.toMatchObject({
      reason: "unavailable", message: "Provider action is unavailable.",
    });
  });
  it("preserves an owner-only denial for an actionable UI state", async () => {
    const client = createWebProviderWorkflowClient({ fetcher: vi.fn().mockResolvedValue(
      Response.json({ error: { code: "forbidden", message: "private" } }, { status: 403 }),
    ) });
    await expect(client.capabilities(new AbortController().signal)).rejects.toMatchObject({
      reason: "forbidden", message: "Provider action is unavailable.",
    });
  });
  it("allows bounded key verification and native saving to finish after twenty seconds", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), milliseconds);
      return controller.signal;
    });
    try {
      const fetcher = vi.fn<typeof fetch>((_path, options) => new Promise((resolve, reject) => {
        options!.signal!.addEventListener("abort", () => reject(new Error("Timed out")), { once: true });
        setTimeout(() => resolve(Response.json({ verified: true })), 20_000);
      }));
      const outcome = createWebProviderWorkflowClient({ fetcher }).submitKey({
        harnessInstanceId: "codex", providerId: "openai", apiKey: "synthetic-key",
      }, new AbortController().signal).then(() => true, () => false);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await outcome).toBe(true);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });
  it.each([[401, "unauthorized"], [403, "forbidden"]] as const)("classifies plain-text HTTP %s independently of response JSON", async (status, reason) => {
    const fetcher = vi.fn().mockResolvedValue(new Response("Access denied", { status }));
    await expect(createWebProviderWorkflowClient({ fetcher }).capabilities(new AbortController().signal)).rejects.toMatchObject({ reason });
  });
  it("binds workflows to the captured gateway with caller cancellation and no cache", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json([]));
    const caller = new AbortController();
    await createWebProviderWorkflowClient({ fetcher }).capabilities(caller.signal);
    expect(fetcher.mock.calls[0][0]).toBe("/vm/review/api/ai/provider-settings/workflows/capabilities?connectionVersion=2");
    expect(fetcher.mock.calls[0][1]).toMatchObject({ cache: "no-store", credentials: "include" });
    caller.abort();
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it("rejects late history after identity changes", async () => {
    let current = true;
    const fetcher = vi.fn<typeof fetch>(async () => { current = false; return Response.json(page); });
    await expect(loadWebAiCreditHistory({ runtimeSlot: "pr-123", cursor: null, signal: new AbortController().signal,
      fetcher, isIdentityCurrent: () => current })).rejects.toThrow();
    expect(fetcher.mock.calls[0][0]).toBe("/billing/ai-credit/history?runtimeSlot=pr-123&limit=20");
  });
  it("rejects invalid cursor before networking and private response fields", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ ...page, ownerId: "private" }));
    const base = { runtimeSlot: "primary", signal: new AbortController().signal, fetcher };
    await expect(loadWebAiCreditHistory({ ...base, cursor: "bad" })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    await expect(loadWebAiCreditHistory({ ...base, cursor: null })).rejects.toThrow();
  });
  it("only opens allowlisted native authorization URLs", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    expect(openWebProviderWorkflowAuthorization("https://evil.example/sign-in")).toBe(false);
    expect(openWebProviderWorkflowAuthorization("https://auth.openai.com/codex/device")).toBe(false);
    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith("about:blank", "_blank");
  });
  it("severs the blank popup opener and applies no-referrer before external navigation", () => {
    const doc = document.implementation.createHTMLDocument();
    const popup = { opener: window, document: doc, location: { replace: vi.fn(() => {
      expect(popup.opener).toBeNull();
      expect(doc.querySelector('meta[name="referrer"]')?.getAttribute("content")).toBe("no-referrer");
    }) }, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    expect(openWebProviderWorkflowAuthorization("https://auth.openai.com/codex/device")).toBe(true);
    expect(popup.location.replace).toHaveBeenCalledOnce();
  });

  it("never navigates externally when opener isolation fails", () => {
    const popup = { opener: window, location: { replace: vi.fn() }, close: vi.fn() };
    Object.defineProperty(popup, "opener", { set() { throw new Error("denied"); } });
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    expect(openWebProviderWorkflowAuthorization("https://auth.openai.com/codex/device")).toBe(false);
    expect(popup.location.replace).not.toHaveBeenCalled();
    expect(popup.close).toHaveBeenCalledOnce();
  });
  it.each([401, 403])("does not classify HTTP %s denial as a retryable outage", async status => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ error: { code: "unknown" } }, { status }));
    await expect(createWebProviderWorkflowClient({ fetcher }).capabilities(new AbortController().signal))
      .rejects.toMatchObject({ reason: status === 401 ? "unauthorized" : "forbidden" });
  });

});
