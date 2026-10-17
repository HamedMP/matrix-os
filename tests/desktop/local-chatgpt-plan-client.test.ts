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

const connected = { ...status, state: "connected", account: { id: "11111111-1111-4111-8111-111111111111", label: "Synthetic owner" },
  grant: { revision: 1, enabled: true, background: false }, bridgeConnected: true };
it("notifies once when an existing connection attempt gains qualified device authority", async () => {
  const changed = vi.fn();
  const invoke = vi.fn().mockResolvedValueOnce(status).mockResolvedValueOnce({ ...status, state: "connecting" }).mockResolvedValue(connected);
  const client = createDesktopChatgptPlanClient({ runtimeSlot: "primary", authGeneration: 3 }, () => true, invoke, changed);
  const signal = new AbortController().signal;
  await client.status(signal);
  await client.connect({ purpose: "personal_local" }, signal);
  expect(changed).not.toHaveBeenCalled();
  await client.status(signal);
  await client.status(signal);
  expect(changed).toHaveBeenCalledOnce();
});
it("does not refresh catalog discovery for initial status, failed login or cancellation", async () => {
  const changed = vi.fn();
  const invoke = vi.fn().mockResolvedValueOnce(connected).mockResolvedValueOnce({ ...status, state: "connecting" })
    .mockResolvedValueOnce({ ...status, state: "error" }).mockResolvedValueOnce(status);
  const client = createDesktopChatgptPlanClient({ runtimeSlot: "primary", authGeneration: 3 }, () => true, invoke, changed);
  const signal = new AbortController().signal;
  await client.status(signal);
  expect(changed).not.toHaveBeenCalled();
  await client.connect({ purpose: "personal_local" }, signal);
  // Losing a previously usable connection must fence its old catalog authority.
  expect(changed).toHaveBeenCalledOnce();
  await client.status(signal); await client.cancel(signal);
  expect(changed).toHaveBeenCalledOnce();
});
it("does not let an older status overwrite post-mutation notification state", async () => {
  let release!: (value: unknown) => void;
  const changed = vi.fn();
  const invoke = vi.fn().mockResolvedValueOnce(status)
    .mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValue(connected);
  const client = createDesktopChatgptPlanClient({ runtimeSlot: "primary", authGeneration: 3 }, () => true, invoke, changed);
  const signal = new AbortController().signal;
  await client.status(signal);
  const old = client.status(signal);
  await client.connect({ purpose: "personal_local" }, signal);
  release(status); await old;
  await client.status(signal);
  expect(changed).toHaveBeenCalledOnce();
});
it("does not notify a new Computer from a late successful device receipt", async () => {
  let current = true;
  const changed = vi.fn();
  const invoke = vi.fn(async () => { current = false; return connected; });
  const client = createDesktopChatgptPlanClient({ runtimeSlot: "primary", authGeneration: 3 }, () => current, invoke, changed);
  await expect(client.connect({ purpose: "personal_local" }, new AbortController().signal)).rejects.toThrow();
  expect(changed).not.toHaveBeenCalled();
});
