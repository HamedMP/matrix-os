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
  expect(screen.getByRole("button", { name: authState === "failed" ? /Check failed/ : /Sign in/ })).toBeVisible();
});

it("keeps an unknown installation distinct from a failed installation", () => {
  show({ ...harness, installState: "unknown", enabled: false, configuredEnabled: true });
  expect(screen.getByRole("button", { name: /Hermes.*Check connection/ })).toBeVisible();
});
it("does not obscure an explicit sign-in requirement with historical local evidence", () => {
  show({ ...harness, authState: "unauthenticated", localObservation: { state: "present_unverified", checkedAt: new Date(Date.now()-10000).toISOString(), staleAfter: new Date(Date.now()-5000).toISOString() } });
  expect(screen.getByRole("button", { name: /Hermes.*Sign in/ })).toBeVisible();
});

it.each(["failed_auth", "invalid_source", "offline", "degraded"] as const)("preserves %s for a saved enabled route that is currently blocked", (failure) => {
  const value = { ...harness, enabled: false, configuredEnabled: true, accessSourceId: "native" };
  if (failure === "failed_auth") value.authState = "failed";
  if (failure === "offline" || failure === "degraded") value.connectivity = failure;
  show(value, failure === "invalid_source" ? [{ id: "native", readiness: { state: "invalid" } } as ProviderAccessSource] : []);
  expect(screen.getByRole("button", { name: /Hermes.*Check failed/ })).toBeVisible();
});
