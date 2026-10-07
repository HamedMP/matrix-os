import { expect, it, vi } from "vitest";
import { createDesktopChatgptPlanClient } from "../../desktop/src/renderer/src/features/settings/local-chatgpt-plan-client.js";
const status = { state: "disconnected", scope: "this_device", models: [], grant: { revision: 0, enabled: false, background: false }, bridgeConnected: false, revocation: "none" };
it("scopes native sign-in and Bot consent to the exact Computer session without API keys", async () => {
  const invoke = vi.fn().mockResolvedValue(status);
  const client = createDesktopChatgptPlanClient({ runtimeSlot: "primary", authGeneration: 3 }, () => true, invoke);
  const signal = new AbortController().signal;
  await client.connect({ purpose: "personal_local" }, signal);
  await client.setGrant({ enabled: true, background: false }, signal);
  expect(invoke.mock.calls).toEqual([
    ["chatgpt-plan:connect", { runtimeSlot: "primary", authGeneration: 3, purpose: "personal_local" }],
    ["chatgpt-plan:set-grant", { runtimeSlot: "primary", authGeneration: 3, enabled: true, background: false }],
  ]);
});
it("rejects late owner/session receipts and malformed DTOs", async () => {
  let current = true;
  const invoke = vi.fn(async () => { current = false; return status; });
  const client = createDesktopChatgptPlanClient({ runtimeSlot: "primary", authGeneration: 3 }, () => current, invoke);
  await expect(client.status(new AbortController().signal)).rejects.toThrow("ChatGPT connection is unavailable");
  const malformed = createDesktopChatgptPlanClient({ runtimeSlot: "primary", authGeneration: 3 }, () => true, vi.fn().mockResolvedValue({ ...status, accessToken: "private" }));
  await expect(malformed.status(new AbortController().signal)).rejects.toThrow("ChatGPT connection is unavailable");
});
it("does not dispatch from a canceled or obsolete Computer", async () => {
  const invoke = vi.fn(); const controller = new AbortController(); controller.abort();
  const client = createDesktopChatgptPlanClient({ runtimeSlot: "primary", authGeneration: 3 }, () => true, invoke);
  await expect(client.connect({ purpose: "personal_local" }, controller.signal)).rejects.toThrow();
  expect(invoke).not.toHaveBeenCalled();
});
