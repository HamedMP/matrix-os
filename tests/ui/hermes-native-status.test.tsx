// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProviderHarnessInstance, ProviderAccessSource } from "@matrix-os/contracts";
import { HarnessRail } from "../../packages/ui/src/agents-providers/HarnessRail.js";
const harness = { id: "owner_hermes", harness: "hermes", displayName: "Hermes", enabled: true, configuredEnabled: true,
  installState: "installed", version: null, authState: "unknown", connectivity: "unknown", accessSourceId: null } as ProviderHarnessInstance;
function show(value: ProviderHarnessInstance, sources: ProviderAccessSource[] = []) {
  render(<HarnessRail harnesses={[value]} sources={sources} selectedId={null} disabled={false} canEnable={() => false}
    onSelect={() => {}} onEnable={() => {}} renderDetails={() => null} />);
}
afterEach(() => { cleanup(); vi.useRealTimers(); });
it("shows unknown as a check connection action, not a failed check", () => {
  show(harness); expect(screen.getByRole("button", { name: /Hermes.*Check connection/ })).toBeVisible();
});
it("retains historical native local evidence after expiry without promoting authentication", () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-26T00:00:00Z"));
  show({ ...harness, localObservation: { state: "present_unverified", checkedAt: new Date().toISOString(), staleAfter: new Date(Date.now()+5000).toISOString() } });
  expect(screen.getByRole("button", { name: /Hermes.*Local login found; access not verified/ })).toBeVisible();
  act(() => vi.advanceTimersByTime(5001));
  expect(screen.getByRole("button", { name: /Hermes.*Local login last found; access not verified/ })).toBeVisible();
});
it.each(["failed", "expired"] as const)("preserves explicit %s over local positive evidence", (authState) => {
  show({ ...harness, authState, localObservation: { state: "present_unverified", checkedAt: new Date().toISOString(), staleAfter: new Date(Date.now()+5000).toISOString() } });
  expect(screen.getByRole("button", { name: /Hermes.*Needs attention/ })).toBeVisible();
  expect(screen.queryByRole("button", {name: /Hermes.*Connected/})).not.toBeInTheDocument();
});

it("keeps an unknown installation distinct from a failed installation", () => {
  show({ ...harness, installState: "unknown", enabled: false, configuredEnabled: true });
  expect(screen.getByRole("button", { name: /Hermes.*Check connection/ })).toBeVisible();
});
it("does not obscure an explicit sign-in requirement with historical local evidence", () => {
  show({ ...harness, authState: "unauthenticated", localObservation: { state: "present_unverified", checkedAt: new Date(Date.now()-10000).toISOString(), staleAfter: new Date(Date.now()-5000).toISOString() } });
  expect(screen.getByRole("button", { name: /Hermes.*Not connected/ })).toBeVisible();
});

it.each(["failed_auth", "invalid_source"] as const)("preserves %s for a saved enabled route that is currently blocked", (failure) => {
  const value = { ...harness, enabled: false, configuredEnabled: true, accessSourceId: "native" };
  if (failure === "failed_auth") value.authState = "failed";
  value.connectivity = "offline";
  show(value, failure === "invalid_source" ? [{ id: "native", readiness: { state: "invalid" } } as ProviderAccessSource] : []);
  expect(screen.getByRole("button", { name: /Hermes.*Needs attention/ })).toBeVisible();
  expect(screen.queryByRole("button", {name: /Hermes.*Connected/})).not.toBeInTheDocument();
});
it.each([false, true])("requests a connection check for unavailable or stale access when enabled=%s without inventing an authentication failure", (enabled) => {
  show({ ...harness, harness: "claude", displayName: "Claude", enabled,
    configuredEnabled: true, connectivity: enabled ? "degraded" : "offline",
    routeAvailability: "available", configuredAccessSourceId: "matrix_included", accessSourceId: null,
    localObservation: { state: "present_unverified", checkedAt: new Date(Date.now()-10000).toISOString(), staleAfter: new Date(Date.now()-5000).toISOString() },
  }, [{ id: "matrix_included", readiness: { state: "unavailable", safeReason: "provider_unavailable", action: "retry" } } as ProviderAccessSource]);
  expect(screen.getByRole("button", { name: /Claude.*Check connection/ })).toBeVisible();
  expect(screen.queryByText(/Local login/)).not.toBeInTheDocument();
  expect(screen.queryByText("Connected")).not.toBeInTheDocument();
});
it.each([false, true])("keeps explicit authentication failure authoritative when offline and enabled=%s", (enabled) => {
  show({ ...harness, enabled, connectivity: "offline", authState: "failed" });
  expect(screen.getByRole("button", { name: /Hermes.*Needs attention/ })).toBeVisible();
  expect(screen.queryByRole("button", {name: /Hermes.*Connected/})).not.toBeInTheDocument();
});

function observedReadyRoute(ageMs = 0) {
  const value: ProviderHarnessInstance = { ...harness, authState: "authenticated", connectivity: "online",
    accessSourceId: "owner_anthropic_profile", route: { kind: "configurable", providerId: "anthropic", modelId: "claude-sonnet-5" },
    localObservation: { state: "present_unverified", checkedAt: new Date(Date.now()-ageMs).toISOString(), staleAfter: new Date(Date.now()-ageMs+5000).toISOString() } };
  const source = { id: value.accessSourceId, kind: "provider_account", readiness: { state: "ready" } } as ProviderAccessSource;
  return { value, source };
}
it.each([0, 10_000])("preserves authoritative Connected over local evidence aged %sms", (ageMs) => {
  const { value, source } = observedReadyRoute(ageMs);
  show(value, [source]);
  expect(screen.getByRole("button", { name: /Hermes.*Connected/ })).toBeVisible();
  expect(screen.queryByText(/Local login/)).not.toBeInTheDocument();
});
it.each(["auth_unknown", "offline", "degraded", "unsupported_source", "source_unknown", "source_invalid", "source_expired", "source_stale", "source_unavailable", "disabled", "install_unknown", "missing_source"] as const)("never promotes local evidence to Connected when %s", (state) => {
  const { value, source } = observedReadyRoute();
  if (state === "auth_unknown") value.authState = "unknown";
  if (state === "offline" || state === "degraded") value.connectivity = state;
  if (state === "unsupported_source") source.kind = "matrix_gateway";
  if (state.startsWith("source_")) source.readiness.state = state.slice(7) as ProviderAccessSource["readiness"]["state"];
  if (state === "disabled") value.enabled = false;
  if (state === "install_unknown") value.installState = "unknown";
  if (state === "missing_source") value.accessSourceId = null;
  show(value, state === "missing_source" ? [] : [source]);
  expect(screen.queryByRole("button", { name: /Hermes.*Connected/ })).not.toBeInTheDocument();
});
