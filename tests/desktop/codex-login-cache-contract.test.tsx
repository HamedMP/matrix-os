// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CanonicalProviderCatalogSchema, ProviderWorkflowV2Schema, type ProviderWorkflow } from "@matrix-os/contracts";
import { ProviderSettingsController } from "../../packages/ui/src/agents-providers/provider-settings-controller";
import { useHarnessWorkflowController } from "../../packages/ui/src/agents-providers/use-harness-workflow-controller";
import { createDesktopProviderWorkflowClient } from "../../desktop/src/renderer/src/features/settings/provider-workflow-transport";
import { useChatProviderCatalog } from "../../desktop/src/renderer/src/features/chat/chat-provider-catalog";
import { startDesktopProviderCatalogCoordinator, stopDesktopProviderCatalogCoordinator } from "../../desktop/src/renderer/src/features/chat/provider-catalog-coordinator";
import { invalidateDesktopProviderCatalog } from "../../desktop/src/renderer/src/features/chat/provider-catalog-invalidation";
import { desktopProviderIdentityKey } from "../../desktop/src/renderer/src/lib/provider-settings-identity";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import type { ApiClient } from "../../desktop/src/renderer/src/lib/api";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat";
import { disconnectedSnapshot } from "../ui/chat-provider-settings-fixture";

// A public DTO fake, not the unmerged native producer. No native login start is enabled here.
const option = { id: "openai_device_code", providerId: "openai", authKind: "subscription", method: "device_code",
  billingKind: "subscription", executionKind: "native", availability: "available" } as const;
const receipt = ProviderWorkflowV2Schema.parse({ id: "native_codex_receipt", harnessInstanceId: "codex_default", kind: "login", state: "succeeded",
  expiresAt: "2099-01-01T00:00:00.000Z", terminalSessionId: null, deviceCode: null, authorizationUrl: null, safeFailure: null, connectionOption: option });
const seed = createCanonicalProviderCatalogFixture();
const row = seed.instances[0]!;
const ready = CanonicalProviderCatalogSchema.parse({ ...seed,
  drivers: [...seed.drivers, { ...seed.drivers[0], kind: "claude_code" }, { ...seed.drivers[0], kind: "pi" }],
  instances: [row, { ...row, id: "native_codex_second", defaultSelection: { ...row.defaultSelection, instanceId: "native_codex_second" } },
    { ...row, id: "unrelated_claude", driverKind: "claude_code", defaultSelection: { ...row.defaultSelection, instanceId: "unrelated_claude" } },
    { ...row, id: "independent_device_plan", driverKind: "pi", defaultSelection: { ...row.defaultSelection, instanceId: "independent_device_plan" } }],
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const controllers: ProviderSettingsController[] = [];
afterEach(() => {
  cleanup(); controllers.splice(0).forEach(controller => controller.dispose());
  stopDesktopProviderCatalogCoordinator(); useConnection.setState(useConnection.getInitialState(), true); vi.restoreAllMocks();
});

async function boundary() {
  const completion = deferred<unknown>(), catalogRead = deferred<typeof ready>(), advisory = deferred<unknown>();
  const trace: string[] = [];
  let catalogReads = 0;
  const get = vi.fn((path: string) => {
    trace.push(path);
    if (path.startsWith("/api/chat-providers?")) return ++catalogReads === 2 ? catalogRead.promise : Promise.resolve(ready);
    if (path === "/api/ai/provider-settings/workflows/v2/native_codex_receipt") return completion.promise;
    throw new Error(`Unexpected synthetic route: ${path}`);
  });
  const api = { get } as unknown as ApiClient;
  useConnection.setState({ status: "signed-in", handle: "fixture_computer", userId: "fixture_owner", platformHost: "https://fixture.invalid", runtimeSlot: "primary", authGeneration: 7, api });
  const identity = desktopProviderIdentityKey(useConnection.getState());
  const current = () => desktopProviderIdentityKey(useConnection.getState()) === identity;
  const snapshot = disconnectedSnapshot();
  const getSnapshot = vi.fn().mockResolvedValueOnce(snapshot).mockReturnValue(advisory.promise);
  const controller = new ProviderSettingsController({ identityKey: identity, transport: { getSnapshot, mutate: vi.fn() },
    onCatalogChanged: (intent, previous, accepted) => invalidateDesktopProviderCatalog(identity, intent, previous, accepted) });
  controllers.push(controller); await controller.refresh({ refresh: false });
  startDesktopProviderCatalogCoordinator();
  const chat = renderHook(() => useChatProviderCatalog(ready));
  await waitFor(() => expect(chat.result.current.hasTrustedCatalog).toBe(true));
  const client = createDesktopProviderWorkflowClient(api, current);
  const onRefreshAfterLogin = async (accepted: ProviderWorkflow) => {
    if (!current()) return;
    await controller.refreshForConnection(accepted);
  };
  const workflow = renderHook(() => useHarnessWorkflowController({ harness: snapshot.harnesses.find(h => h.harness === "codex")!,
    capability: { harnessInstanceId: "codex_default", harness: "codex", displayName: "Codex", installState: "installed",
      loginMethods: [], apiKeyProviders: [], install: false, uninstall: false, logs: false },
    client, operationId: receipt.id, disabled: false, onRefresh: vi.fn(), onRefreshAfterLogin, onOpenTerminal: vi.fn() }));
  await waitFor(() => expect(trace.some(path => path.includes("/workflows/v2/"))).toBe(true));
  return { completion, catalogRead, advisory, trace, getSnapshot, controller, identity, chat, workflow,
    readCount: () => catalogReads };
}

it("reprojects only native Codex routes before advisory Settings settles and makes mounted Chat ready without reopening", async () => {
  const b = await boundary();
  await act(async () => b.completion.resolve(receipt));
  expect(b.readCount()).toBe(2);
  expect(useConnection.getState().providerCatalogAffectedInstanceIds).toEqual(["codex_fixture", "native_codex_second"]);
  expect(b.chat.result.current.catalog.instances.map(i => i.availability)).toEqual(["unavailable", "unavailable", "available", "available"]);
  expect(b.trace.filter(p => p.startsWith("/api/chat-providers?")).every(p => !p.includes("refresh=true"))).toBe(true);
  expect(b.getSnapshot.mock.calls[1]![1]).toEqual({ refresh: false });
  await act(async () => b.catalogRead.resolve(ready));
  expect(b.chat.result.current.hasTrustedCatalog).toBe(true);
  expect(b.chat.result.current.catalog.instances[0]!.availability).toBe("available");
  await act(async () => b.advisory.resolve(disconnectedSnapshot()));
  await act(async () => { await b.controller.refreshForConnection(receipt); });
  expect(b.readCount()).toBe(2);
});

it("retains a confirmed Codex catalog refresh when only advisory Settings fails", async () => {
  const b = await boundary();
  await act(async () => b.completion.resolve(receipt));
  await act(async () => b.advisory.reject(new Error("Synthetic advisory failure")));
  expect(b.controller.getState().error).toBe("Provider settings are unavailable.");
  await act(async () => b.catalogRead.resolve(ready));
  expect(b.chat.result.current.hasTrustedCatalog).toBe(true);
  expect(b.chat.result.current.catalog.instances[0]!.availability).toBe("available");
  expect(b.readCount()).toBe(2);
});

it.each(["failed", "cancelled", "expired", "pending", "running"] as const)("does not invalidate on a native Codex %s receipt", async state => {
  const b = await boundary();
  await act(async () => b.completion.resolve({ ...receipt, state }));
  await waitFor(() => expect(b.workflow.result.current.operation?.state).toBe(state));
  expect(useConnection.getState().providerCatalogGeneration).toBe(0);
  expect(b.readCount()).toBe(1);
  expect(b.chat.result.current.hasTrustedCatalog).toBe(true);
  expect(b.getSnapshot).toHaveBeenCalledOnce();
});

it.each([{ handle: "another_computer" }, { userId: "another_owner" }, { runtimeSlot: "other_runtime" },
  { authGeneration: 8 }, { platformHost: "https://another.invalid" }, { status: "signed-out" as const }])(
  "rejects an old Codex completion after identity changes to %j", async change => {
    const b = await boundary();
    act(() => useConnection.setState(change));
    const generation = useConnection.getState().providerCatalogGeneration;
    const reads = b.readCount();
    await act(async () => b.completion.resolve(receipt));
    expect(useConnection.getState().providerCatalogGeneration).toBe(generation);
    expect(b.readCount()).toBe(reads);
    expect(b.getSnapshot).toHaveBeenCalledOnce();
  },
);

it("rejects late Codex inventory after moving to another runtime", async () => {
  const b = await boundary();
  await act(async () => b.completion.resolve(receipt));
  act(() => useConnection.setState({ runtimeSlot: "other_runtime" }));
  await waitFor(() => expect(b.chat.result.current.hasTrustedCatalog).toBe(true));
  const current = b.chat.result.current.catalog;
  await act(async () => b.catalogRead.resolve({ ...ready, revision: "obsolete_catalog" }));
  expect(b.chat.result.current.catalog).toBe(current);
  expect(b.chat.result.current.catalog.revision).not.toBe("obsolete_catalog");
});
