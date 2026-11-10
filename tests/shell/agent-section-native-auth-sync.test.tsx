// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProviderSettingsSnapshotSchema } from "@matrix-os/contracts";
import nativeInput from "../fixtures/claude-native-authenticated-off.json";

const state = vi.hoisted(() => ({
  gateway: "http://owner.local", runtime: "primary", getSnapshot: vi.fn(), mutate: vi.fn(),
}));
vi.mock("@/lib/gateway", () => ({ getGatewayUrl: () => state.gateway }));
vi.mock("@/lib/ai-credit-checkout", () => ({
  currentAiCreditRuntimeSlot: () => state.runtime, openWebAiCreditCheckout: vi.fn(),
}));
vi.mock("@/lib/provider-settings-transport", () => ({
  createProviderSettingsTransport: () => ({ getSnapshot: state.getSnapshot, mutate: state.mutate }),
  openWebProviderAgentSetup: vi.fn(),
}));
vi.mock("@matrix-os/ui", async importOriginal => ({
  ...(await importOriginal<typeof import("@matrix-os/ui")>()),
  AgentsProvidersView: () => null,
}));
import { AgentSection } from "../../shell/src/components/settings/sections/AgentSection";
import { PROVIDER_SETTINGS_CHANGED_EVENT } from "../../shell/src/lib/canonical-provider-setup";

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime("2026-11-06T10:00:00Z");
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  state.gateway = "http://owner.local"; state.runtime = "primary";
  state.getSnapshot.mockReset(); state.mutate.mockReset();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
function snapshot(email: string | null) {
  const value = ProviderSettingsSnapshotSchema.parse(structuredClone(nativeInput));
  value.refreshedAt = new Date().toISOString();
  const account = value.accounts[0]!;
  account.lastCheckedAt = value.refreshedAt;
  account.authState = email ? "authenticated" : "unknown";
  account.connectionDetails = email ? { email } : undefined;
  return value;
}
async function settle(ms = 0) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }

it("invalidates an open Web Chat catalog when Settings first discovers an earlier Terminal login", async () => {
  state.getSnapshot.mockResolvedValue(snapshot("terminal@example.test"));
  const changed = vi.fn(); window.addEventListener(PROVIDER_SETTINGS_CHANGED_EVENT, changed);
  try {
    render(<AgentSection automaticCreditRefreshEnabled />); await settle();
    expect(changed).toHaveBeenCalledOnce();
    expect(state.mutate).not.toHaveBeenCalled();
  } finally { window.removeEventListener(PROVIDER_SETTINGS_CHANGED_EVENT, changed); }
});

it("notifies Web Chat after external auth changes, ignores timestamp renewal and rejects a late other-Computer result", async () => {
  state.getSnapshot.mockResolvedValue(snapshot(null));
  const changed = vi.fn(); window.addEventListener(PROVIDER_SETTINGS_CHANGED_EVENT, changed);
  try {
    render(<AgentSection automaticCreditRefreshEnabled />); await settle(); changed.mockClear();
    await settle(1000); state.getSnapshot.mockResolvedValue(snapshot("terminal@example.test"));
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(changed).toHaveBeenCalledOnce();
    await settle(1000); state.getSnapshot.mockResolvedValue(snapshot("terminal@example.test"));
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(changed).toHaveBeenCalledOnce();
    let release: ((value: ReturnType<typeof snapshot>) => void) | undefined;
    state.getSnapshot.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await settle(1000); await act(async () => { window.dispatchEvent(new Event("focus")); });
    // The new Computer's own first read is intentionally pending: only the
    // old Computer's late response is being tested here.
    state.getSnapshot.mockImplementationOnce(() => new Promise(() => {}));
    state.gateway = "http://other.local"; state.runtime = "preview";
    await act(async () => { release!(snapshot("late@example.test")); });
    expect(changed).toHaveBeenCalledOnce(); expect(state.mutate).not.toHaveBeenCalled();
  } finally { window.removeEventListener(PROVIDER_SETTINGS_CHANGED_EVENT, changed); }
});
