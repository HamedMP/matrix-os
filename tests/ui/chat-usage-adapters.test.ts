import { expect, it, vi } from "vitest";
import { createWebChatUsageClient } from "../../shell/src/lib/chat-usage-transport.js";
import { createDesktopChatUsageClient } from "../../desktop/src/renderer/src/features/settings/chat-usage-transport.js";
const location = vi.hoisted(() => ({ gateway: "" }));
vi.mock("../../shell/src/lib/gateway", () => ({ getGatewayUrl: () => location.gateway }));
const policy = { enabled: false, sampleRateBps: 1000, modelId: "@cf/meta/classifier", recipient: "Cloudflare Workers AI",
  disclosureVersion: "chat-usage-v1", retentionDays: 30 };
it("web uses same-origin authenticated bounded requests with abort and identity checks", async () => {
  let current = true;
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(policy), { headers: { "Content-Type": "application/json" } }));
  const client = createWebChatUsageClient({ fetcher, isIdentityCurrent: () => current });
  await client.policy(new AbortController().signal);
  expect(fetcher).toHaveBeenCalledWith("/api/chat-usage/policy", expect.objectContaining({ credentials: "include", cache: "no-store", signal: expect.any(AbortSignal) }));
  current = false; await expect(client.policy(new AbortController().signal)).rejects.toThrow(); expect(fetcher).toHaveBeenCalledOnce();
});
it("web rejects oversized and failed responses without echoing bodies", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response("private", { headers: { "Content-Length": "9999999" } }));
  const client = createWebChatUsageClient({ fetcher, isIdentityCurrent: () => true });
  await expect(client.policy(new AbortController().signal)).rejects.toThrow(/^Chat usage is unavailable\.$/);
  fetcher.mockResolvedValue(new Response("private", { status: 503 }));
  await expect(client.policy(new AbortController().signal)).rejects.toThrow(/^Chat usage is unavailable\.$/);
});
it("web preserves the explicit computer prefix instead of reading the primary runtime", async () => {
  location.gateway = "https://matrix.example/vm/staff-pilot/~runtime/pr-1";
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(policy)));
  try {
    await createWebChatUsageClient({ fetcher, isIdentityCurrent: () => true }).policy(new AbortController().signal);
    expect(fetcher).toHaveBeenCalledWith(`${location.gateway}/api/chat-usage/policy`, expect.any(Object));
  } finally { location.gateway = ""; }
});
it("desktop uses the supplied runtime-scoped authenticated client and guards late responses", async () => {
  let current = true;
  const api = { get: vi.fn().mockResolvedValue(policy), put: vi.fn().mockResolvedValue(policy), delete: vi.fn().mockResolvedValue({ deleted: true, enabled: false }) };
  const client = createDesktopChatUsageClient(api as never, () => current);
  await client.configure({ enabled: false, sampleRateBps: 1000 }, new AbortController().signal);
  expect(api.put).toHaveBeenCalledWith("/api/chat-usage/policy", { enabled: false, sampleRateBps: 1000 }, expect.objectContaining({ maxBytes: 262144, timeoutMs: 10000, signal: expect.any(AbortSignal), omitErrorBody: true }));
  api.get.mockImplementation(async () => { current = false; return policy; });
  await expect(client.policy(new AbortController().signal)).rejects.toThrow();
});
