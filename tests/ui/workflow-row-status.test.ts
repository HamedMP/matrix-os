import { expect, it, vi } from "vitest";
import { updateWorkflowRowStatus, resolvedWorkflowRowStatus } from "../../packages/ui/src/agents-providers/workflow-row-status";

it("tracks parallel row operations and clears only the exact completed row", () => {
  const connecting = updateWorkflowRowStatus({}, "codex", "Connecting");
  expect(updateWorkflowRowStatus(connecting, "hermes", null)).toBe(connecting);
  const parallel = updateWorkflowRowStatus(connecting, "hermes", "Installing");
  expect(parallel).toEqual({ codex: "Connecting", hermes: "Installing" });
  expect(updateWorkflowRowStatus(parallel, "codex", null)).toEqual({ hermes: "Installing" });
  expect(connecting).toEqual({ codex: "Connecting" });
});

it("caps status entries while allowing existing rows to finish", () => {
  const full = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`row-${index}`, "Connecting"]));
  expect(Object.keys(updateWorkflowRowStatus(full, "extra", "Installing"))).toHaveLength(32);
  expect(updateWorkflowRowStatus(full, "row-0", "Couldn't connect")["row-0"]).toBe("Couldn't connect");
  expect(Object.keys(updateWorkflowRowStatus(full, "row-0", null))).toHaveLength(31);
});

it.each(["Couldn't connect", undefined])('retains an authoritative connected row over a stale receipt status %s', status => {
  const harness = { installState: 'installed', authState: 'authenticated', enabled: true } as import('@matrix-os/contracts').ProviderHarnessInstance;
  expect(resolvedWorkflowRowStatus(harness, undefined, status)).toBe('Connected');
  expect(resolvedWorkflowRowStatus(harness, undefined, 'Connecting')).toBe('Connecting');
});
it('does not infer a connection after an unsuccessful initial login or missing installation', () => {
  const harness = { installState: 'installed', authState: 'unauthenticated', enabled: true } as import('@matrix-os/contracts').ProviderHarnessInstance;
  expect(resolvedWorkflowRowStatus(harness, undefined, "Couldn't connect")).toBe("Couldn't connect");
  expect(resolvedWorkflowRowStatus({ ...harness, installState: 'missing' }, undefined, "Couldn't connect")).toBe('Not installed');
});


it("distinguishes expired Hermes observations from logout without admitting stale credentials", async () => {
  const { hasConfiguredConnection } = await import("../../packages/ui/src/agents-providers/harness-connection");
  const checked = Date.parse("2026-10-05T03:00:00Z");
  const localObservation = { state: "present_unverified" as const, checkedAt: new Date(checked).toISOString(), staleAfter: new Date(checked + 5000).toISOString() };
  const source = { id: "native_hermes", kind: "harness_profile", harness: "hermes", providerId: "openai-codex", accountId: null,
    readiness: { state: "unknown" }, localObservation } as import("@matrix-os/contracts").ProviderAccessSource;
  const harness = { harness: "hermes", installState: "installed", authState: "unknown", enabled: true, configuredEnabled: true,
    route: { kind: "configurable", providerId: "openai-codex", modelId: "openai-codex:gpt-5.6-sol" }, accessSourceId: source.id, localObservation } as import("@matrix-os/contracts").ProviderHarnessInstance;
  const clock = vi.spyOn(Date, "now").mockReturnValue(checked + 4999);
  try {
    expect(resolvedWorkflowRowStatus(harness, source)).toBe("Connected");
    clock.mockReturnValue(checked + 5001);
    expect(resolvedWorkflowRowStatus(harness, source)).toBe("Checking connection");
    expect(hasConfiguredConnection(harness, source)).toBe(false);
    for (const authState of ["expired", "unauthenticated", "failed"] as const)
      expect(resolvedWorkflowRowStatus({ ...harness, authState }, source)).toBe("Not connected");
    expect(resolvedWorkflowRowStatus(harness, { ...source, readiness: { ...source.readiness, state: "expired" } })).toBe("Not connected");
    expect(resolvedWorkflowRowStatus({ ...harness, accessSourceId: "another" }, source)).toBe("Not connected");
  } finally { clock.mockRestore(); }
});
