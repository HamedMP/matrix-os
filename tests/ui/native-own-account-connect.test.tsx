// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderAccessSource, ProviderHarnessInstance, ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { ConnectionChoices } from "../../packages/ui/src/agents-providers/ConnectionChoices";

function fixture(kind: "pi" | "opencode") {
  const now = Date.now();
  const harness: ProviderHarnessInstance = {
    id: kind, harness: kind, displayName: kind, accentColor: null, enabled: false,
    version: "1", installState: "installed", authState: "unknown", connectivity: "unknown",
    loginMethods: [], recommendedLoginMethod: null, accountIds: [], selectedAccountId: null,
    accessSourceId: null, route: { kind: "configurable", providerId: "anthropic", modelId: "claude-fable-5" },
    activeChatCount: 0,
  };
  const source: ProviderAccessSource = {
    id: `native_${kind}`, kind: "harness_profile", harness: kind, fundingKind: "owner_account",
    providerId: "anthropic", accountId: null, displayName: `${kind} account`, eligibleModelIds: ["claude-fable-5"],
    readiness: { state: "unknown", checkedAt: new Date(now).toISOString(), staleAfter: new Date(now + 60_000).toISOString(), action: "open_terminal", safeReason: null },
    localObservation: { state: "present_unverified", checkedAt: new Date(now).toISOString(), staleAfter: new Date(now + 60_000).toISOString() },
    usage: { kind: "unavailable", authority: "unavailable", state: "not_applicable", scope: "access_source", reason: "provider_does_not_report", asOf: null },
  };
  const snapshot: ProviderSettingsSnapshot = {
    contractVersion: 1, projectionOf: { contract: "AiProviderSnapshotV3", contractVersion: 3, revision: 1 },
    revision: 1, refreshedAt: new Date(now).toISOString(), access: { mode: "writable" },
    configurationHarnessKinds: [kind], harnessCatalog: [], harnesses: [harness], accounts: [], accessSources: [source],
    modelProviders: [{ id: "anthropic", displayName: "Anthropic", models: [{ id: "claude-fable-5", displayName: "Claude Fable 5", enabled: true }] }],
    gatewayPolicy: null, supportedActions: ["set_route", "set_harness_enabled"], atomicConnectSupported: true,
  };
  return { harness, source, snapshot };
}

function mount(kind: "pi" | "opencode", alter?: (source: ProviderAccessSource) => void,
  refresh?: () => Promise<ProviderSettingsSnapshot | null>, selected = false) {
  const value = fixture(kind);
  alter?.(value.source);
  if (selected) { value.harness.accessSourceId = value.source.id; value.harness.enabled = true; }
  const onMutate = vi.fn().mockResolvedValue(true);
  // The actual disabled Chat catalog deliberately has no setup actions.
  const onSetupHarness = vi.fn().mockResolvedValue(false);
  render(<ConnectionChoices {...value} gatewaySource={null} gatewaySelected={false}
    canSetRoute disabled={false} onMutate={onMutate} onSetupHarness={onSetupHarness}
    {...{ onRefreshForConnection: refresh }} />);
  return { ...value, onMutate, onSetupHarness };
}

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("native own-account connection", () => {
  it.each(["pi", "opencode"] as const)("atomically connects disabled %s through its exact fresh observed native profile", async (kind) => {
    const { onMutate, onSetupHarness, source } = mount(kind);
    fireEvent.click(screen.getByRole("button", { name: /Own account/ }));
    await waitFor(() => expect(onMutate).toHaveBeenCalledWith({ type: "set_route", harnessInstanceId: kind,
      route: { kind: "configurable", providerId: "anthropic", modelId: "claude-fable-5" },
      accessSourceId: source.id, accountId: null, enableHarness: true }));
    expect(onSetupHarness).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([
    ["expired", (s: ProviderAccessSource) => { s.localObservation!.staleAfter = new Date(Date.now() - 1).toISOString(); }],
    ["missing", (s: ProviderAccessSource) => { delete s.localObservation; }],
    ["wrong harness", (s: ProviderAccessSource) => { s.harness = "opencode"; }],
    ["wrong account", (s: ProviderAccessSource) => { s.accountId = "other_account"; }],
    ["missing model", (s: ProviderAccessSource) => { s.eligibleModelIds = []; }],
    ["denied", (s: ProviderAccessSource) => { s.readiness.state = "auth_required"; }],
    ["future observation", (s: ProviderAccessSource) => { s.localObservation!.checkedAt = new Date(Date.now() + 30_000).toISOString(); }],
    ["absent profile", (s: ProviderAccessSource) => { s.localObservation!.state = "absent"; }],
  ] as const)("does not activate %s native evidence", async (_name, alter) => {
    const { onMutate, onSetupHarness } = mount("pi", alter);
    fireEvent.click(screen.getByRole("button", { name: /Own account/ }));
    await waitFor(() => expect(onSetupHarness).toHaveBeenCalledOnce());
    expect(onMutate).not.toHaveBeenCalled();
  });

  it("expires a mounted native connection option without activating stale evidence", async () => {
    vi.useFakeTimers();
    const { onMutate, onSetupHarness } = mount("pi", (source) => {
      source.localObservation!.staleAfter = new Date(Date.now() + 50).toISOString();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(51); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Own account/ })); });
    expect(onSetupHarness).toHaveBeenCalledOnce();
    expect(onMutate).not.toHaveBeenCalled();
  });

  it.each(["pi", "opencode"] as const)("refreshes stale %s evidence once before the exact atomic connection", async (kind) => {
    const fresh = fixture(kind).snapshot;
    const refresh = vi.fn().mockResolvedValue(fresh);
    const { onMutate, onSetupHarness } = mount(kind, (s) => {
      s.localObservation!.staleAfter = new Date(Date.now() - 1).toISOString();
    }, refresh);
    fireEvent.click(screen.getByRole("button", { name: /Own account/ }));
    await waitFor(() => expect(onMutate).toHaveBeenCalledWith(expect.objectContaining({
      type: "set_route", harnessInstanceId: kind, accessSourceId: `native_${kind}`, enableHarness: true,
    })));
    expect(refresh).toHaveBeenCalledOnce();
    expect(onSetupHarness).not.toHaveBeenCalled();
  });

  it.each(["absent", "wrong harness", "wrong account", "wrong model", "changed source", "unavailable"])("denies %s after the refresh without setup or mutation", async (negative) => {
    const fresh = fixture("pi").snapshot;
    const source = fresh.accessSources[0]!;
    if (negative === "absent") source.localObservation!.state = "absent";
    if (negative === "wrong harness") source.harness = "opencode";
    if (negative === "wrong account") source.accountId = "other";
    if (negative === "wrong model") source.eligibleModelIds = [];
    if (negative === "changed source") source.id = "other_source";
    const refresh = vi.fn().mockResolvedValue(negative === "unavailable" ? null : fresh);
    const { onMutate, onSetupHarness } = mount("pi", (s) => {
      s.localObservation!.staleAfter = new Date(Date.now() - 1).toISOString();
    }, refresh);
    fireEvent.click(screen.getByRole("button", { name: /Own account/ }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole("alert")).toBeVisible());
    expect(onMutate).not.toHaveBeenCalled();
    expect(onSetupHarness).not.toHaveBeenCalled();
  });

  it("keeps the saved own-account selection visible after observation expiry", () => {
    mount("opencode", (s) => { s.localObservation!.staleAfter = new Date(Date.now() - 1).toISOString(); }, undefined, true);
    expect(screen.getByRole("button", { name: /Own account/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Selected")).toBeVisible();
  });

  it("does not apply a refreshed connection after its component unmounts", async () => {
    let resolve!: (value: ProviderSettingsSnapshot) => void;
    const refresh = vi.fn(() => new Promise<ProviderSettingsSnapshot>((done) => { resolve = done; }));
    const { onMutate } = mount("pi", (s) => { s.localObservation!.staleAfter = new Date(Date.now() - 1).toISOString(); }, refresh);
    fireEvent.click(screen.getByRole("button", { name: /Own account/ }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    cleanup();
    await act(async () => { resolve(fixture("pi").snapshot); });
    expect(onMutate).not.toHaveBeenCalled();
  });
});
