// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createWebProviderWorkflowClient, loadWebAiCreditHistory, openWebProviderWorkflowAuthorization } from "../../shell/src/lib/provider-workflow-transport.js";
vi.mock("../../shell/src/lib/gateway.js", () => ({ getGatewayUrl: () => "/vm/review" }));
const page = { entries: [], nextCursor: null };
describe("web provider workflow transport", () => {
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
    const fetcher = vi.fn(async () => { current = false; return Response.json(page); });
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
    expect(openWebProviderWorkflowAuthorization("https://auth.openai.com/codex/device")).toBe(true);
    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith("https://auth.openai.com/codex/device", "_blank", "noopener,noreferrer");
  });
});
