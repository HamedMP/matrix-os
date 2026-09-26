// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { projectProviderSettings } from "../../packages/gateway/src/ai-providers/provider-settings-projector.js";
import { providerSettingsCanonicalFixture } from "../gateway/provider-settings-test-support.js";
import { ConnectionChoices } from "../../packages/ui/src/agents-providers/ConnectionChoices.js";
import { AiProviderSnapshotV3Schema, type ProviderAccessSource } from "@matrix-os/contracts";

afterEach(cleanup);

async function projected(kind: "pi" | "opencode", fresh = false, savedKey = false, removed = false) {
  const now = new Date();
  const canonical = providerSettingsCanonicalFixture();
  canonical.refreshedAt = now.toISOString();
  canonical.drivers.push({ ...canonical.drivers[1]!, id: kind, installState: "installed", health: "ready" });
  const key = canonical.accessSources.find((source) => source.id === "owner_anthropic_profile")!;
  key.id = "owner_anthropic_key";
  key.fundingKind = "owner_api_key";
  for (const instance of canonical.instances) if (instance.accessSourceId === "owner_anthropic_profile") instance.accessSourceId = key.id;
  for (const model of canonical.models) {
    model.eligibleAccessSourceIds = model.eligibleAccessSourceIds.map((id) => id === "owner_anthropic_profile" ? key.id : id);
    for (const policy of model.dataPolicies) if (policy.accessSourceId === "owner_anthropic_profile") policy.accessSourceId = key.id;
  }
  AiProviderSnapshotV3Schema.parse(canonical);
  key.checkedAt = now.toISOString(); key.staleAfter = new Date(+now + 60_000).toISOString();
  canonical.accounts[0]!.authMethod = "api_key";
  canonical.accounts[0]!.checkedAt = key.checkedAt; canonical.accounts[0]!.staleAfter = key.staleAfter;
  const native: ProviderAccessSource = {
    id: `harness_${kind}_anthropic`, kind: "harness_profile", harness: kind, fundingKind: "owner_account",
    providerId: "anthropic", accountId: null, displayName: `${kind} account`, eligibleModelIds: ["claude-sonnet-5"],
    readiness: { state: "unknown", checkedAt: null, staleAfter: null, action: "retry", safeReason: "unknown" },
    localObservation: { state: "present_unverified", checkedAt: now.toISOString(), staleAfter: new Date(+now + (fresh ? 60_000 : -1)).toISOString() },
    usage: { kind: "unavailable", authority: "unavailable", state: "not_applicable", scope: "access_source", reason: "provider_does_not_report", asOf: null },
  };
  const snapshot = await projectProviderSettings({ canonical, now, supportedActions: ["set_route", "set_harness_enabled"],
    config: { schemaVersion: 1, revision: 1, accountProfiles: [], gatewayPolicy: null, receipts: [], harnesses: [{
      id: kind, driverId: kind, harness: kind, displayName: kind, accentColor: null, enabled: true,
      enablementOrigin: "owner_configuration", selectedAccountId: savedKey ? "owner_anthropic" : null,
      accessSourceId: savedKey ? key.id : native.id,
      route: { kind: "configurable", providerId: "anthropic", modelId: "claude-sonnet-5" },
    }] }, genericModelCatalog: { providers: [], accessSources: removed ? [] : [native], failures: [] },
  });
  snapshot.atomicConnectSupported = true;
  return snapshot;
}

function mount(snapshot: Awaited<ReturnType<typeof projected>>, refresh: () => Promise<typeof snapshot | null>) {
  const mutate = vi.fn().mockResolvedValue(true);
  render(<ConnectionChoices snapshot={snapshot} harness={snapshot.harnesses[0]!} gatewaySource={null}
    gatewaySelected={false} canSetRoute disabled={false} onMutate={mutate} onRefreshForConnection={refresh} />);
  return mutate;
}

it.each(["pi", "opencode"] as const)("projects the saved %s native binding independently of expired operational eligibility", async (kind) => {
  const snapshot = await projected(kind);
  expect(snapshot.harnesses[0]).toMatchObject({ configuredAccessSourceId: `harness_${kind}_anthropic`, accessSourceId: null, enabled: false, authState: "unknown" });
  mount(snapshot, vi.fn());
  expect(screen.getByRole("button", { name: /Own account/ })).toHaveAttribute("aria-pressed", "true");
});

it.each(["pi", "opencode"] as const)("refreshes the saved %s native profile instead of selecting the competing ready API key", async (kind) => {
  const snapshot = await projected(kind);
  const refresh = vi.fn().mockResolvedValue(await projected(kind, true));
  const mutate = mount(snapshot, refresh);
  fireEvent.click(screen.getByRole("button", { name: /Own account/ }));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  await waitFor(() => expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ accessSourceId: `harness_${kind}_anthropic`, accountId: null })));
  expect(mutate).not.toHaveBeenCalledWith(expect.objectContaining({ accessSourceId: "owner_anthropic_key" }));
});

it("does not substitute the ready API key when refreshing the saved profile fails", async () => {
  const refresh = vi.fn().mockResolvedValue(null);
  const mutate = mount(await projected("pi"), refresh);
  fireEvent.click(screen.getByRole("button", { name: /Own account/ }));
  await waitFor(() => expect(screen.getByRole("alert")).toBeVisible());
  expect(refresh).toHaveBeenCalledOnce();
  expect(mutate).not.toHaveBeenCalled();
});

it("preserves an intentionally configured ready API key instead of selecting a native profile", async () => {
  const snapshot = await projected("pi", false, true);
  const refresh = vi.fn();
  const mutate = mount(snapshot, refresh);
  fireEvent.click(screen.getByRole("button", { name: /Own account/ }));
  await waitFor(() => expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ accessSourceId: "owner_anthropic_key", accountId: "owner_anthropic" })));
  expect(refresh).not.toHaveBeenCalled();
});

it("retains removed saved intent as read-only evidence and never substitutes another account", async () => {
  const snapshot = await projected("pi", false, false, true);
  expect(snapshot.harnesses[0]).toMatchObject({ configuredAccessSourceId: "harness_pi_anthropic", accessSourceId: null, enabled: false });
  const refresh = vi.fn();
  const mutate = mount(snapshot, refresh);
  fireEvent.click(screen.getByRole("button", { name: /Own account/ }));
  await waitFor(() => expect(screen.getByRole("alert")).toBeVisible());
  expect(mutate).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
});

it("does not guess a legacy saved binding from an expired profile and a ready key", async () => {
  const snapshot = await projected("pi");
  delete snapshot.harnesses[0]!.configuredAccessSourceId;
  const refresh = vi.fn();
  const mutate = mount(snapshot, refresh);
  fireEvent.click(screen.getByRole("button", { name: /Own account/ }));
  await waitFor(() => expect(screen.getByRole("alert")).toBeVisible());
  expect(mutate).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
});

it.each(["missing profile", "changed binding", "wrong harness", "wrong account", "wrong model", "expired", "future", "denied"])("denies %s after the real projected refresh without an API-key fallback", async (negative) => {
  const fresh = await projected("pi", true);
  const native = fresh.accessSources.find((source) => source.kind === "harness_profile")!;
  if (negative === "missing profile") fresh.accessSources = fresh.accessSources.filter((source) => source !== native);
  if (negative === "changed binding") fresh.harnesses[0]!.configuredAccessSourceId = "owner_anthropic_key";
  if (negative === "wrong harness") native.harness = "opencode";
  if (negative === "wrong account") native.accountId = "other_account";
  if (negative === "wrong model") native.eligibleModelIds = [];
  if (negative === "expired") native.localObservation!.staleAfter = new Date(Date.now() - 1).toISOString();
  if (negative === "future") native.localObservation!.checkedAt = new Date(Date.now() + 30_000).toISOString();
  if (negative === "denied") native.readiness.state = "auth_required";
  const refresh = vi.fn().mockResolvedValue(fresh);
  const mutate = mount(await projected("pi"), refresh);
  fireEvent.click(screen.getByRole("button", { name: /Own account/ }));
  await waitFor(() => expect(screen.getByRole("alert")).toBeVisible());
  expect(refresh).toHaveBeenCalledOnce();
  expect(mutate).not.toHaveBeenCalled();
});
