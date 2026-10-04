// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProviderSettingsSnapshot, ProviderUsage } from "@matrix-os/contracts";
import { AgentsProvidersView } from "../../packages/ui/src/agents-providers/AgentsProvidersView";
afterEach(cleanup);
function fixture(): ProviderSettingsSnapshot {
  return {
    harnesses: [{ id: "hermes", harness: "hermes", displayName: "Hermes", installState: "installed", authState: "unknown", connectivity: "unknown", enabled: false, configuredEnabled: false, accessSourceId: "native", accountIds: [], selectedAccountId: null, loginMethods: ["terminal"], route: { kind: "configurable", providerId: "openai-codex", modelId: "openai-codex:test" } }],
    accounts: [], accessSources: [{ id: "native", kind: "harness_profile", harness: "hermes", providerId: "openai-codex", accountId: null, displayName: "Native subscription", fundingKind: "owner_subscription", eligibleModelIds: ["openai-codex:test"], usage: { kind: "unavailable", authority: "unavailable", state: "unavailable", scope: "account", reason: "provider_does_not_report", asOf: null } satisfies ProviderUsage, readiness: { state: "unknown" }, localObservation: { state: "present_unverified", checkedAt: "2026-01-01T00:00:00Z", staleAfter: "2026-01-01T00:00:05Z" } }],
    modelProviders: [{ id: "openai-codex", displayName: "ChatGPT", models: [{ id: "openai-codex:test", displayName: "Test", enabled: true }] }], gatewayPolicy: null, configurationHarnessKinds: ["hermes"], supportedActions: ["set_harness_enabled"], access: { mode: "writable" }, refreshedAt: "2026-01-01T00:00:08Z",
  } as unknown as ProviderSettingsSnapshot;
}
it.each(["unchanged", "route", "source", "account", "readonly", "credential", "capability", "configured_source"])("reconnects a saved Off connection only after fresh exact validation (%s)", async change => {
  const initial = fixture(); const fresh = fixture();
  if (change === "route") fresh.harnesses[0]!.route.modelId = "other";
  if (change === "configured_source") fresh.harnesses[0]!.configuredAccessSourceId = "other";
  if (change === "source") fresh.harnesses[0]!.accessSourceId = "other";
  if (change === "account") fresh.harnesses[0]!.selectedAccountId = "other";
  if (change === "readonly") fresh.access.mode = "read_only";
  if (change === "credential") fresh.accessSources[0]!.localObservation!.state = "absent";
  if (change === "capability") fresh.supportedActions = [];
  const mutate = vi.fn().mockResolvedValue(true); const refresh = vi.fn().mockResolvedValue(fresh);
  const client = { capabilities: vi.fn().mockResolvedValue([{ harnessInstanceId: "hermes", harness: "hermes", displayName: "Hermes", installState: "installed", loginMethods: ["existing_codex"], apiKeyProviders: [], install: false, uninstall: false, logs: false }]), start: vi.fn(), get: vi.fn(), cancel: vi.fn(), logs: vi.fn(), submitKey: vi.fn() };
  render(<AgentsProvidersView snapshot={initial} selectedHarnessId="hermes" onSelectHarness={vi.fn()} onRefresh={vi.fn()} onRefreshForConnection={refresh} onMutate={mutate} onOpenTerminal={vi.fn()} onOpenBrowser={vi.fn()} onAddCredit={vi.fn()} workflowClient={client as never} />);
  const row = screen.getByRole("button", { name: /^Hermes/ });
  if (row.getAttribute("aria-expanded") !== "true") fireEvent.click(row);
  const connect = await screen.findByRole("button", { name: "Connect saved connection" });
  expect(mutate).not.toHaveBeenCalled();
  fireEvent.click(connect);
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  await waitFor(() => expect(connect).toBeEnabled());
  if (change === "unchanged") expect(mutate).toHaveBeenCalledExactlyOnceWith({ type: "set_harness_enabled", harnessInstanceId: "hermes", enabled: true });
  else expect(mutate).not.toHaveBeenCalled();
  expect(client.start).not.toHaveBeenCalled();
});
