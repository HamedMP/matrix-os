import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../desktop/src/renderer/src/lib/api";
import { createApiClient } from "../../desktop/src/renderer/src/lib/api";
import { createDesktopProviderWorkflowClient, loadDesktopAiCreditHistory, openDesktopProviderWorkflowAuthorization } from "../../desktop/src/renderer/src/features/settings/provider-workflow-transport";

describe("Electron provider workflow transport", () => {
  it("preserves only the safe rejection code through the real API client", async () => {
    const api = createApiClient({ baseUrl: "https://matrix.invalid", getRuntimeSlot: () => "primary",
      fetchFn: async () => Response.json({ error: { code: "rejected", message: "private provider text" } }, { status: 400 }) });
    await expect(createDesktopProviderWorkflowClient(api, () => true).submitKey({
      harnessInstanceId: "codex", providerId: "openai", apiKey: "synthetic-key",
    }, new AbortController().signal)).rejects.toMatchObject({ reason: "rejected", message: "Provider action is unavailable." });
  });
  it("preserves owner-only denial without expiring a valid Matrix session", async () => {
    const onUnauthorized = vi.fn();
    const api = createApiClient({ baseUrl: "https://matrix.invalid", getRuntimeSlot: () => "pr-test",
      onUnauthorized, fetchFn: async () => Response.json({ error: { code: "forbidden", message: "private" } }, { status: 403 }) });
    await expect(createDesktopProviderWorkflowClient(api, () => true).capabilities(new AbortController().signal))
      .rejects.toMatchObject({ reason: "forbidden", message: "Provider action is unavailable." });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
  it("allows native credential saving to finish beyond the read timeout", async () => {
    vi.useFakeTimers();
    try {
      const post = vi.fn((_path, _body, options) => new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error("Timed out")), options.timeoutMs);
        setTimeout(() => { clearTimeout(deadline); resolve({ verified: true }); }, 20_000);
      }));
      const api = { post } as unknown as ApiClient;
      const outcome = createDesktopProviderWorkflowClient(api, () => true).submitKey({
        harnessInstanceId: "codex", providerId: "openai", apiKey: "synthetic-key",
      }, new AbortController().signal).then(() => true, () => false);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await outcome).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it("uses scoped API and rejects results after owner/computer switches", async () => {
    let current = true;
    const get = vi.fn(async () => { current = false; return []; });
    const api = { get } as unknown as ApiClient;
    const signal = new AbortController().signal;
    await expect(createDesktopProviderWorkflowClient(api, () => current).capabilities(signal)).rejects.toThrow();
    expect(get).toHaveBeenCalledWith("/api/ai/provider-settings/workflows/capabilities?connectionVersion=2", expect.objectContaining({ signal, maxBytes: 65536, timeoutMs: 15000 }));
  });
  it("reads history for the exact runtime and validates the response", async () => {
    const get = vi.fn().mockResolvedValue({ entries: [], nextCursor: null });
    const api = { get, forRuntime: vi.fn().mockReturnValue({ get }) } as unknown as ApiClient;
    const signal = new AbortController().signal;
    expect(await loadDesktopAiCreditHistory({ api, runtimeSlot: "pr-1", cursor: null, signal, isIdentityCurrent: () => true })).toEqual({ entries: [], nextCursor: null });
    expect(api.get).toHaveBeenCalledWith("/billing/ai-credit/history?runtimeSlot=pr-1&limit=20", expect.objectContaining({ signal }));
  });
  it("does not append gateway routing parameters to the strict platform history query", async () => {
    const fetchFn = vi.fn(async (url: string) => {
      const query = new URL(url).searchParams;
      if (query.has("runtime")) return Response.json({ error: "Invalid request" }, { status: 400 });
      expect(query.get("runtimeSlot")).toBe("pr-1");
      return Response.json({ entries: [], nextCursor: null });
    });
    const api = createApiClient({ baseUrl: "https://matrix.invalid", getRuntimeSlot: () => "pr-1", fetchFn });
    await expect(loadDesktopAiCreditHistory({ api, runtimeSlot: "pr-1", cursor: null,
      signal: new AbortController().signal, isIdentityCurrent: () => true })).resolves.toEqual({ entries: [], nextCursor: null });
  });
  it("will not open an untrusted authorization target", async () => {
    const openExternal = vi.fn();
    expect(await openDesktopProviderWorkflowAuthorization("https://auth.openai.com.evil.example/", openExternal)).toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
    expect(await openDesktopProviderWorkflowAuthorization("https://auth.openai.com/codex/device", openExternal)).toBe(true);
    expect(openExternal).toHaveBeenCalledWith("https://auth.openai.com/codex/device");
  });
});
