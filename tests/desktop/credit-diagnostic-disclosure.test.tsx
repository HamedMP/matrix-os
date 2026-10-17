// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CreditDiagnosticDisclosure } from "../../desktop/src/renderer/src/features/settings/CreditDiagnosticDisclosure";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { desktopProviderIdentityKey } from "../../desktop/src/renderer/src/lib/provider-settings-identity";
import { ProviderSettingsSnapshotSchema } from "@matrix-os/contracts";
const at = "2026-10-13T08:00:00.000Z";
const target = { machineId: "11111111-1111-4111-8111-111111111111", runtimeSlot: "pv-123-fixture", backendSource: "a".repeat(40) };
const version = "v2026.10.13-pr123-123-1-aaaaaaa";
function fixture() {
  useConnection.setState({ status: "signed-in", handle: "fixture", userId: "private-owner", platformHost: "https://private-host.example", runtimeSlot: target.runtimeSlot, authGeneration: 1 });
  const snapshot = ProviderSettingsSnapshotSchema.parse({ contractVersion: 1, projectionOf: { contract: "AiProviderSnapshotV3", contractVersion: 3, revision: 1 }, revision: 1, refreshedAt: at, access: { mode: "writable" }, supportedActions: [],
    harnessCatalog: ["hermes", "openclaw", "pi", "opencode"].map(harness => ({ harness, displayName: "Private harness", installState: "missing", available: false, runnable: false, setupAction: "none", safeReason: "runtime_not_supported" })), modelProviders: [{ id: "anthropic", displayName: "Private provider", models: [] }],
    accessSources: [{ id: "private-source", kind: "matrix_gateway", fundingKind: "matrix_included", providerId: "anthropic", accountId: null, displayName: "Private label", readiness: { state: "unavailable", checkedAt: at, staleAfter: null, action: "retry", safeReason: "provider_unavailable" }, eligibleModelIds: [], usage: { kind: "unavailable", authority: "unavailable", state: "unavailable", scope: "owner_entitlement", reason: "ledger_not_available", asOf: at } }], accounts: [], harnesses: [], gatewayPolicy: null });
  const get = vi.fn(async (_path: string) => ({ runtime: { machineId: target.machineId, runtimeSlot: target.runtimeSlot, handle: "fixture" }, version, runningVersion: version,
    release: { schemaVersion: 1, kind: "matrix-os-host-bundle", version, gitCommit: target.backendSource } }));
  return { api: { get }, snapshot, selectedHarnessId: null, identityKey: desktopProviderIdentityKey(useConnection.getState()), target };
}
function openDisclosure() { const details = screen.getByText("Credit diagnostic").closest("details")!; details.open = true; fireEvent(details, new Event("toggle")); return details; }
afterEach(() => { cleanup(); vi.restoreAllMocks(); useConnection.setState(useConnection.getInitialState(), true); });
it("reads only on opening, exposes whitelist text, and never refreshes the provider snapshot", async () => {
  const props = fixture(); render(<CreditDiagnosticDisclosure {...props} />);
  expect(props.api.get).not.toHaveBeenCalled(); openDisclosure();
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("ledger_not_available"));
  expect(props.api.get.mock.calls.map(call => call[0])).toEqual(["/api/system/info", "/api/system/info"]);
  for (const privateText of ["private-owner", "private-host", "private-source", "Private label", target.machineId]) expect(screen.getByRole("status").textContent).not.toContain(privateText);
});
it("discards a pending read when the accepted snapshot is replaced without automatically retrying", async () => {
  const props = fixture(); let release!: (value: unknown) => void; const system = await props.api.get("fixture"); props.api.get.mockClear();
  props.api.get.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const view = render(<CreditDiagnosticDisclosure {...props} />); openDisclosure();
  view.rerender(<CreditDiagnosticDisclosure {...props} snapshot={{ ...props.snapshot, revision: 2 }} />);
  await act(async () => { release(system); });
  expect(screen.getByRole("status").textContent).not.toContain("ledger_not_available"); expect(props.api.get).toHaveBeenCalledTimes(1);
});
it("clears an observed receipt after a credential generation change", async () => {
  const props = fixture(); render(<CreditDiagnosticDisclosure {...props} />); openDisclosure();
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("ledger_not_available"));
  act(() => useConnection.setState({ authGeneration: 2 }));
  expect(screen.getByRole("status").textContent).not.toContain("ledger_not_available");
});
