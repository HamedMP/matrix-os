import { expect, it, vi } from "vitest";
import { ProviderSettingsSnapshotSchema } from "@matrix-os/contracts";
import { projectDesktopCreditDiagnostic, readDesktopCreditDiagnostic } from "../../desktop/src/renderer/src/features/settings/credit-diagnostic";
const at = "2026-10-13T08:00:00.000Z";
function snapshot() {
  return ProviderSettingsSnapshotSchema.parse({ contractVersion: 1, projectionOf: { contract: "AiProviderSnapshotV3", contractVersion: 3, revision: 1 }, revision: 1, refreshedAt: at, access: { mode: "writable" }, supportedActions: [],
    harnessCatalog: ["hermes", "openclaw", "pi", "opencode"].map(harness => ({ harness, displayName: "Harness", installState: "missing", available: false, runnable: false, setupAction: "none", safeReason: "runtime_not_supported" })),
    modelProviders: [{ id: "anthropic", displayName: "Provider", models: [{ id: "anthropic/claude-sonnet-5", displayName: "Model", enabled: true }] }],
    accessSources: [{ id: "source_matrix", kind: "matrix_gateway", fundingKind: "matrix_included", providerId: "anthropic", accountId: null, displayName: "Matrix", readiness: { state: "unavailable", checkedAt: at, staleAfter: null, action: "retry", safeReason: "provider_unavailable" }, eligibleModelIds: ["anthropic/claude-sonnet-5"], usage: { kind: "unavailable", authority: "unavailable", state: "unavailable", scope: "owner_entitlement", reason: "ledger_not_available", asOf: at } }], accounts: [], harnesses: [], gatewayPolicy: null });
}
it("reports the same parsed credit reason without identity, amounts or provider text", async () => {
  const result = await projectDesktopCreditDiagnostic(snapshot());
  expect(result).toMatchObject({ policyPresent: false, inventoryPresent: false, rawEnabledCatalogModelCount: 1, sources: [{ usageKind: "unavailable", usageState: "unavailable", reason: "ledger_not_available", safeReason: "provider_unavailable", asOf: at }] });
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain("source_matrix"); expect(serialized).not.toContain('"Provider"'); expect(serialized).not.toContain('"Model"');
});
const target = { machineId: "11111111-1111-4111-8111-111111111111", runtimeSlot: "pv-123-fixture", backendSource: "a".repeat(40) };
const version = "v2026.10.13-pr123-123-1-aaaaaaa";
const system = () => ({ runtime: { machineId: target.machineId, runtimeSlot: target.runtimeSlot, handle: "fixture" }, version, runningVersion: version,
  release: { schemaVersion: 1, kind: "matrix-os-host-bundle", version, gitCommit: target.backendSource } });
function context() { return { identityKey: "private-identity-key", handle: "fixture", runtimeSlot: target.runtimeSlot,
  generation: 1, authGeneration: 1, snapshot: snapshot(), selectedHarnessId: null as string | null }; }
it("corroborates the accepted snapshot with only two normal System reads", async () => {
  const get = vi.fn(async (_path: string) => system()); const current = context();
  const result = await readDesktopCreditDiagnostic({ api: { get }, target, signal: new AbortController().signal, getContext: () => current });
  expect(get.mock.calls.map(call => call[0])).toEqual(["/api/system/info", "/api/system/info"]);
  expect(result).toMatchObject({ backendSource: target.backendSource, selectedSource: "unknown", sources: [{ reason: "ledger_not_available" }] });
  for (const secret of [target.machineId, "fixture", "private-identity-key", "source_matrix"]) expect(JSON.stringify(result)).not.toContain(secret);
});
it.each(["machineId", "handle", "runtimeSlot"])("refuses foreign System %s", async field => {
  const current = context(); const get = vi.fn(async () => ({ ...system(), runtime: { ...system().runtime, [field]: field === "machineId" ? "22222222-2222-4222-8222-222222222222" : "foreign" } }));
  await expect(readDesktopCreditDiagnostic({ api: { get }, target, signal: new AbortController().signal, getContext: () => current })).rejects.toMatchObject({ code: "foreign_runtime" });
  expect(get).toHaveBeenCalledTimes(1);
});
it.each(["identityKey", "generation", "authGeneration", "snapshot", "selectedHarnessId"])("rejects a changed %s after an asynchronous read", async field => {
  const current = context(); const get = vi.fn(async () => {
    if (field === "snapshot") current.snapshot = snapshot();
    else if (field === "selectedHarnessId") current.selectedHarnessId = "other";
    else if (field === "identityKey") current.identityKey = "foreign";
    else current[field]++;
    return system();
  });
  await expect(readDesktopCreditDiagnostic({ api: { get }, target, signal: new AbortController().signal, getContext: () => current })).rejects.toMatchObject({ code: "identity_changed" });
  expect(get).toHaveBeenCalledTimes(1);
});
it("refuses a different installed source and a foreign second read", async () => {
  const current = context();
  for (const last of [{ ...system(), release: { ...system().release, gitCommit: "b".repeat(40) } }, { ...system(), runtime: { ...system().runtime, handle: "foreign" } }]) {
    const get = vi.fn().mockResolvedValueOnce(system()).mockResolvedValueOnce(last);
    await expect(readDesktopCreditDiagnostic({ api: { get }, target, signal: new AbortController().signal, getContext: () => current })).rejects.toBeInstanceOf(Error);
  }
});
it("never reauthenticates or exposes an error after a rejected normal read", async () => {
  const get = vi.fn(async () => { throw new Error("private bearer cookie sentinel"); }); const current = context();
  await expect(readDesktopCreditDiagnostic({ api: { get }, target, signal: new AbortController().signal, getContext: () => current })).rejects.toThrow("Credit diagnostic unavailable");
  expect(get).toHaveBeenCalledTimes(1);
});

function managedSnapshot() {
  const value = snapshot();
  value.accessSources[0]!.usage = { kind: "managed_credit", authority: "matrix_ledger", state: "current", scope: "owner_entitlement", currency: "USD",
    usedMicrousd: 0, remainingMicrousd: 1234567, limitMicrousd: 5000000, periodStartedAt: at, resetsAt: null, asOf: at,
    credit: { promotionalBalanceMicrousd: 1234567, addonBalanceMicrousd: 0, creditBalanceMicrousd: 1234567, reservedMicrousd: 0, remainingBalanceMicrousd: 1234567 },
    budget: { monthlyBudgetMicrousd: 5000000, settledThisMonthMicrousd: 0, reservedThisMonthMicrousd: 0, remainingBudgetMicrousd: 5000000 },
    chatAvailability: { contractVersion: 1, asOf: at, eligibleBalanceMicrousd: 1234567, availableBalanceMicrousd: 1234567 } };
  return value;
}
it("reduces actual managed credit to booleans and excludes sensitive source text and every amount", async () => {
  const result = await projectDesktopCreditDiagnostic(managedSnapshot(), Date.parse(at));
  expect(result.sources[0]).toMatchObject({ rawAvailableBalancePositive: true, displayedChatCreditAvailable: true, displayedChatCreditPositive: true });
  for (const privateText of ["1234567", "5000000", "source_matrix", "claude-sonnet", '"USD"', '"Provider"', '"Model"']) expect(JSON.stringify(result)).not.toContain(privateText);
});
it.each(["budget_zero", "stale", "future", "expired"])("uses existing displayed credit gates for %s", async variant => {
  const value = managedSnapshot(); const usage = value.accessSources[0]!.usage;
  if (usage.kind !== "managed_credit") throw new Error("fixture");
  if (variant === "budget_zero") { usage.budget.remainingBudgetMicrousd = 0; usage.budget.reservedThisMonthMicrousd = 5000000; usage.remainingMicrousd = 0; }
  if (variant === "stale") usage.state = "stale";
  const now = Date.parse(at) + (variant === "future" ? -1 : variant === "expired" ? 300001 : 0);
  const result = await projectDesktopCreditDiagnostic(value, now);
  expect(result.sources[0]).toMatchObject({ rawAvailableBalancePositive: true, displayedChatCreditAvailable: variant === "budget_zero", displayedChatCreditPositive: variant === "budget_zero" ? false : null });
});
it("distinguishes omitted inventory from a present empty inventory", async () => {
  const value = snapshot();
  expect(await projectDesktopCreditDiagnostic(value)).toMatchObject({ inventoryPresent: false, rawEnabledInventoryModelCount: null });
  value.matrixModelInventory = [];
  expect(await projectDesktopCreditDiagnostic(value)).toMatchObject({ inventoryPresent: true, rawEnabledInventoryModelCount: 0, selectedSource: "unknown" });
});
it("refuses invalid projection data without exposing raw schema errors or content", async () => {
  const value = { ...snapshot(), accessSources: [{ prompt: "private prompt bearer cookie" }] } as never;
  await expect(projectDesktopCreditDiagnostic(value)).rejects.toThrow("Credit diagnostic unavailable");
});
it("checks context immediately after hashing and aborts before a second System read", async () => {
  const current = context(); const get = vi.fn(async () => system());
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  const spy = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => { const value = await digest(...args); current.authGeneration++; return value; });
  try {
    await expect(readDesktopCreditDiagnostic({ api: { get }, target, signal: new AbortController().signal, getContext: () => current })).rejects.toMatchObject({ code: "identity_changed" });
    expect(get).toHaveBeenCalledTimes(1);
  } finally { spy.mockRestore(); }
});
