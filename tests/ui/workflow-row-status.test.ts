import { expect, it } from "vitest";
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
