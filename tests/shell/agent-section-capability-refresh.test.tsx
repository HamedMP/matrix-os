// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProviderSettingsSnapshotSchema } from "@matrix-os/contracts";
import nativeInput from "../fixtures/claude-native-authenticated-off.json";

// Keep the Web adapter, shared view, controller and cadence real. Only the
// owner-scoped service boundary is synthetic; every read renews native proof.
const service = vi.hoisted(() => ({
  gateway: "http://owner.local", email: "first@example.test" as string | null,
  getSnapshot: vi.fn(), mutate: vi.fn(), capabilities: vi.fn(), connections: vi.fn(),
  refreshConnections: vi.fn(), authorizeConnection: vi.fn(),
}));
vi.mock("@/lib/gateway", () => ({ getGatewayUrl: () => service.gateway }));
vi.mock("@/lib/ai-credit-checkout", () => ({ currentAiCreditRuntimeSlot: () => "primary", openWebAiCreditCheckout: vi.fn() }));
vi.mock("@/lib/provider-settings-transport", () => ({
  createProviderSettingsTransport: () => ({ getSnapshot: service.getSnapshot, mutate: service.mutate }),
  openWebProviderAgentSetup: vi.fn(),
}));
vi.mock("@/lib/provider-workflow-transport", () => ({
  createWebProviderWorkflowClient: () => ({ capabilities: service.capabilities, start: vi.fn(), get: vi.fn(), cancel: vi.fn(), logs: vi.fn(), submitKey: vi.fn(),
    botConnections: { connections: service.connections, refreshConnections: service.refreshConnections, authorizeConnection: service.authorizeConnection } }),
  createWebMatrixAnthropicClient: () => undefined,
  loadWebAiCreditHistory: vi.fn(), openWebProviderWorkflowAuthorization: vi.fn(),
}));
vi.mock("@/lib/platform-speech-client", () => ({ createBrowserSpeechClient: () => undefined }));
import { AgentSection } from "../../shell/src/components/settings/sections/AgentSection";

function snapshot() {
  const value = ProviderSettingsSnapshotSchema.parse(structuredClone(nativeInput));
  value.refreshedAt = new Date().toISOString();
  const account = value.accounts[0]!;
  account.lastCheckedAt = value.refreshedAt;
  account.authState = service.email ? "authenticated" : "unauthenticated";
  account.displayName = service.email ?? "Claude account";
  account.connectionDetails = service.email ? { email: service.email } : undefined;
  return value;
}
async function advance(ms = 0) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime("2026-11-07T10:00:00Z");
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  service.gateway = "http://owner.local"; service.email = "first@example.test";
  service.getSnapshot.mockReset().mockImplementation(async () => snapshot());
  service.mutate.mockReset(); service.capabilities.mockReset().mockResolvedValue([]);
  service.connections.mockReset().mockResolvedValue({ connections: [] });
  service.refreshConnections.mockReset(); service.authorizeConnection.mockReset();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("renews Web native proof every 20 seconds without repeating workflow or Bot discovery, then explicitly refreshes once", async () => {
  render(<AgentSection automaticCreditRefreshEnabled />); await advance();
  fireEvent.click(screen.getByRole("button", { name: /^Claude/ })); await advance();
  expect(service.capabilities).toHaveBeenCalledOnce(); expect(service.connections).toHaveBeenCalledOnce();
  const originalProof = service.getSnapshot.mock.results[0]!.value;
  for (let index = 0; index < 6; index++) await advance(20_000);
  expect(service.getSnapshot).toHaveBeenCalledTimes(7);
  expect((await service.getSnapshot.mock.results[6]!.value).refreshedAt).not.toBe((await originalProof).refreshedAt);
  expect(service.capabilities).toHaveBeenCalledOnce(); expect(service.connections).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Refresh provider status" })); await advance();
  expect(service.getSnapshot).toHaveBeenLastCalledWith(expect.any(AbortSignal), { refresh: true });
  expect(service.capabilities).toHaveBeenCalledTimes(2); expect(service.connections).toHaveBeenCalledTimes(2);
  expect(service.mutate).not.toHaveBeenCalled(); expect(service.authorizeConnection).not.toHaveBeenCalled();
});

it("refreshes discovery for Terminal logout, login and account replacement while preserving owner configuration", async () => {
  render(<AgentSection automaticCreditRefreshEnabled />); await advance();
  fireEvent.click(screen.getByRole("button", { name: /^Claude/ })); await advance();
  const before = await service.getSnapshot.mock.results[0]!.value;
  for (const [index, email] of [null, "first@example.test", "second@example.test"].entries()) {
    service.email = email; await advance(20_000);
    expect(service.capabilities).toHaveBeenCalledTimes(index + 2);
    expect(service.connections).toHaveBeenCalledTimes(index + 2);
    const after = await service.getSnapshot.mock.results[index + 1]!.value;
    expect(after.harnesses).toEqual(before.harnesses); expect(after.gatewayPolicy).toEqual(before.gatewayPolicy);
  }
  await advance(20_000);
  expect(service.capabilities).toHaveBeenCalledTimes(4); expect(service.connections).toHaveBeenCalledTimes(4);
  expect(service.mutate).not.toHaveBeenCalled(); expect(service.authorizeConnection).not.toHaveBeenCalled();
});

it("loads capabilities for a new Computer and aborts the old capability request", async () => {
  const signals: AbortSignal[] = [];
  service.capabilities.mockImplementation(async (signal: AbortSignal) => { signals.push(signal); return []; });
  const view = render(<AgentSection automaticCreditRefreshEnabled />); await advance();
  service.gateway = "http://other.local";
  view.rerender(<AgentSection automaticCreditRefreshEnabled />); await advance();
  expect(service.capabilities).toHaveBeenCalledTimes(2); expect(signals[0]!.aborted).toBe(true);
  await advance(20_000); expect(service.capabilities).toHaveBeenCalledTimes(2);
});

it("shows Terminal login after an early Web focus without waiting for the 20-second cadence", async () => {
  service.email = null;
  service.getSnapshot.mockImplementation(async () => {
    const value = snapshot();
    // Keep the saved execution route unverified; only fresh native account
    // evidence may update the shared authentication indicator.
    Object.assign(value.harnesses[0]!, { authState: "unknown", accessSourceId: null,
      selectedAccountId: null, configuredAccessSourceId: "owner_anthropic_profile" });
    return value;
  });
  render(<AgentSection automaticCreditRefreshEnabled />); await advance();
  expect(screen.getByRole("button", { name: /^Claude.*Not connected/ })).toBeVisible();
  service.email = "terminal@example.test";
  await advance(100); await act(async () => { window.dispatchEvent(new Event("focus")); });
  await advance(400);
  expect(service.getSnapshot).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("button", { name: /^Claude.*Connected/ })).toBeVisible();
  expect(service.mutate).not.toHaveBeenCalled(); expect(service.authorizeConnection).not.toHaveBeenCalled();
});
