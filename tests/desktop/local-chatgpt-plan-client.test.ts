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

const diagnostic = { phase: "vault_protection", category: "protection_unavailable", at: "2026-10-16T00:00:00.000Z", correlationId: "00000000-0000-4000-8000-000000000001" };
it("retains strict safe diagnostics and discards them on invalid response, success, abort or identity replacement", async () => {
  let current = true;
  const invoke = vi.fn().mockResolvedValue({ kind: "status_failure", diagnostic });
  const client = createDesktopChatgptPlanClient({ runtimeSlot: "primary", authGeneration: 3 }, () => current, invoke);
  const controller = new AbortController();
  await expect(client.status(controller.signal)).rejects.toThrow("ChatGPT connection is unavailable");
  expect(client.getLastDiagnostic()).toEqual(diagnostic);
  expect(Object.isFrozen(client.getLastDiagnostic())).toBe(true);
  invoke.mockResolvedValueOnce({ kind: "status_failure", diagnostic: { ...diagnostic, privateToken: "private" } });
  await expect(client.status(controller.signal)).rejects.toThrow("ChatGPT connection is unavailable");
  expect(client.getLastDiagnostic()).toBeNull();
  await expect(client.status(controller.signal)).rejects.toThrow();
  controller.abort(); expect(client.getLastDiagnostic()).toBeNull();
  await expect(client.status(new AbortController().signal)).rejects.toThrow();
  current = false; expect(client.getLastDiagnostic()).toBeNull();
  expect(invoke).toHaveBeenCalledTimes(4);
});
it("does not consume late failure metadata or let an obsolete request clear the current diagnostic", async () => {
  let resolve!: (value: unknown) => void;
  const invoke = vi.fn().mockImplementationOnce(() => new Promise(done => { resolve = done; }))
    .mockResolvedValue({ kind: "status_failure", diagnostic });
  const client = createDesktopChatgptPlanClient({ runtimeSlot: "primary", authGeneration: 3 }, () => true, invoke);
  const old = new AbortController();
  const first = client.status(old.signal).catch(() => undefined);
  await expect(client.status(new AbortController().signal)).rejects.toThrow();
  const receipt = client.getLastDiagnostic();
  old.abort(); resolve({ kind: "status_failure", diagnostic: { ...diagnostic, phase: "catalog" } });
  await first;
  expect(client.getLastDiagnostic()).toBe(receipt);
});
it("drops an older same-client failure envelope after a newer successful status", async () => {
  let resolve!: (value: unknown) => void;
  const invoke = vi.fn().mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockResolvedValue(status);
  const client = createDesktopChatgptPlanClient({ runtimeSlot: "primary", authGeneration: 3 }, () => true, invoke);
  const first = client.status(new AbortController().signal).catch(() => undefined);
  expect(await client.status(new AbortController().signal)).toEqual(status);
  resolve({ kind: "status_failure", diagnostic }); await first;
  expect(client.getLastDiagnostic()).toBeNull();
});
it("classifies an ordinary IPC rejection locally without upstream details or extra IPC", async () => {
  const invoke = vi.fn().mockRejectedValue(Object.assign(new Error("private URL/path/token"), { name: "PrivateAccount" }));
  const client = createDesktopChatgptPlanClient({ runtimeSlot: "primary", authGeneration: 3 }, () => true, invoke);
  await expect(client.status(new AbortController().signal)).rejects.toThrow("ChatGPT connection is unavailable");
  const receipt = client.getLastDiagnostic();
  expect(receipt).toMatchObject({ phase: "transport", category: "unavailable", at: expect.any(String), correlationId: expect.stringMatching(/^[a-f0-9-]{36}$/) });
  expect(receipt).not.toHaveProperty("authGenerationMatches");
  expect(JSON.stringify(receipt)).not.toMatch(/private|URL|path|token|PrivateAccount/);
  expect(invoke).toHaveBeenCalledOnce();
  expect(client.getLastDiagnostic()).toBe(receipt); expect(invoke).toHaveBeenCalledOnce();
});
