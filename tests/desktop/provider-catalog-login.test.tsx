// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CanonicalProviderCatalogSchema, type ProviderWorkflow } from "@matrix-os/contracts";
import { ProviderSettingsController } from "../../packages/ui/src/agents-providers/provider-settings-controller";
import { useHarnessWorkflowController } from "../../packages/ui/src/agents-providers/use-harness-workflow-controller";
import { DesktopGetStartedAgentLogin } from "../../desktop/src/renderer/src/features/get-started/DesktopGetStartedAgentLogin";
import { GetStartedAgentDetails } from "../../packages/ui/src/get-started/agent-login";
import { HarnessWorkflowPanel } from "../../packages/ui/src/agents-providers/HarnessWorkflowPanel";
import { useChatProviderCatalog } from "../../desktop/src/renderer/src/features/chat/chat-provider-catalog";
import { startDesktopProviderCatalogCoordinator, stopDesktopProviderCatalogCoordinator } from "../../desktop/src/renderer/src/features/chat/provider-catalog-coordinator";
import { invalidateDesktopProviderCatalog, invalidateDesktopChatgptPlanCatalog } from "../../desktop/src/renderer/src/features/chat/provider-catalog-invalidation";
import { createDesktopChatgptPlanClient } from "../../desktop/src/renderer/src/features/settings/local-chatgpt-plan-client";
import { ordinaryPlanCatalog, planId } from "../ui/ordinary-chatgpt-plan-fixture";
import { desktopProviderIdentityKey } from "../../desktop/src/renderer/src/lib/provider-settings-identity";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat";
import { disconnectedSnapshot } from "../ui/chat-provider-settings-fixture";

const fixture = createCanonicalProviderCatalogFixture();
const instance = fixture.instances[0]!;
const catalog = CanonicalProviderCatalogSchema.parse({ ...fixture,
  drivers: [fixture.drivers[0], { ...fixture.drivers[0], kind: "claude_code", displayName: "Claude Code" }],
  instances: [
    { ...instance, id: "claude_code_default", driverKind: "claude_code", defaultSelection: { ...instance.defaultSelection, instanceId: "claude_code_default" } },
    { ...instance, id: "codex_default", defaultSelection: { ...instance.defaultSelection, instanceId: "codex_default" } },
  ],
});
const snapshot = disconnectedSnapshot();
const receipt: ProviderWorkflow = { id: "login_one", harnessInstanceId: "claude_default", kind: "login", state: "succeeded",
  expiresAt: "2026-11-01T00:00:00.000Z", terminalSessionId: null, deviceCode: null, authorizationUrl: null, safeFailure: null };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
afterEach(() => {
  cleanup(); stopDesktopProviderCatalogCoordinator();
  useConnection.setState(useConnection.getInitialState(), true); vi.restoreAllMocks();
});
async function mounted(initial = catalog) {
  const next = deferred<typeof catalog>();
  const get = vi.fn().mockResolvedValueOnce(initial).mockReturnValue(next.promise);
  useConnection.setState({ status: "signed-in", handle: "synthetic-owner", userId: "synthetic-user", api: { get } as never });
  startDesktopProviderCatalogCoordinator();
  const hook = renderHook(() => useChatProviderCatalog(initial));
  await waitFor(() => expect(hook.result.current.hasTrustedCatalog).toBe(true));
  const identity = desktopProviderIdentityKey(useConnection.getState());
  return { next, get, hook, identity };
}

it("immediately reprojects the successful harness for an already-open Chat without full renewal", async () => {
  const { next, get, hook, identity } = await mounted();
  act(() => invalidateDesktopProviderCatalog(identity, undefined, snapshot, receipt));
  expect(hook.result.current.catalog.instances.map(value => value.availability)).toEqual(["unavailable", "available"]);
  expect(hook.result.current.initialLoading).toBe(false);
  expect(get).toHaveBeenCalledTimes(2);
  expect(get.mock.calls[1]![0]).not.toContain("refresh=true");
  const connected = { ...catalog, instances: catalog.instances.map(value => ({ ...value, displayName: "Connected" })) };
  await act(async () => next.resolve(connected));
  expect(hook.result.current.catalog).toEqual(connected);
  expect(hook.result.current.hasTrustedCatalog).toBe(true);
  hook.rerender();
  act(() => window.dispatchEvent(new Event("focus")));
  expect(get).toHaveBeenCalledTimes(2);
});

it("coalesces repeated successful receipts even after the first refresh settles", async () => {
  const { next, get, identity } = await mounted();
  act(() => invalidateDesktopProviderCatalog(identity, undefined, snapshot, receipt));
  act(() => invalidateDesktopProviderCatalog(identity, undefined, snapshot, receipt));
  await act(async () => next.resolve(catalog));
  act(() => invalidateDesktopProviderCatalog(identity, undefined, snapshot, receipt));
  expect(useConnection.getState().providerCatalogGeneration).toBe(1);
  expect(get).toHaveBeenCalledTimes(2);
});

it.each(["pending", "running", "failed", "cancelled", "expired"] as const)("does not invalidate on a %s login receipt", async state => {
  const { get, identity } = await mounted();
  act(() => invalidateDesktopProviderCatalog(identity, undefined, snapshot, { ...receipt, state }));
  expect(useConnection.getState().providerCatalogGeneration).toBe(0);
  expect(get).toHaveBeenCalledOnce();
});

it("does not interpret an install success or unknown harness as login authority", async () => {
  const { get, identity } = await mounted();
  act(() => invalidateDesktopProviderCatalog(identity, undefined, snapshot, { ...receipt, kind: "install" }));
  act(() => invalidateDesktopProviderCatalog(identity, undefined, snapshot, { ...receipt, harnessInstanceId: "unknown" }));
  expect(get).toHaveBeenCalledOnce();
});

it.each([{ userId: "next-user" }, { handle: "next-computer" }, { runtimeSlot: "next-runtime" }, { authGeneration: 2 }])(
  "rejects a previous identity's successful login after %j", async boundary => {
    const { get, identity } = await mounted();
    act(() => useConnection.setState(boundary));
    const count = get.mock.calls.length;
    act(() => invalidateDesktopProviderCatalog(identity, undefined, snapshot, receipt));
    expect(get).toHaveBeenCalledTimes(count);
    expect(useConnection.getState().providerCatalogGeneration).toBe(0);
  },
);

it("notifies Chat before waiting for post-login Settings and avoids a forced Settings renewal", async () => {
  const pending = deferred<typeof snapshot>();
  const changed = vi.fn();
  const getSnapshot = vi.fn().mockResolvedValueOnce(snapshot).mockReturnValue(pending.promise);
  const controller = new ProviderSettingsController({ identityKey: "synthetic", transport: { getSnapshot, mutate: vi.fn() }, onCatalogChanged: changed });
  await controller.refresh({ refresh: false });
  const refresh = controller.refreshForConnection(receipt);
  expect(changed).toHaveBeenCalledWith(undefined, snapshot, receipt);
  expect(getSnapshot.mock.calls[1]![1]).toEqual({ refresh: false });
  pending.resolve(snapshot); await refresh;
  expect(changed).toHaveBeenCalledOnce();
  controller.dispose();
});

it("passes the confirmed workflow receipt from a resumed Settings login to its host", async () => {
  const onRefreshAfterLogin = vi.fn().mockResolvedValue(undefined);
  const harness = snapshot.harnesses[0]!;
  const client = { capabilities: vi.fn(), start: vi.fn(), get: vi.fn().mockResolvedValue(receipt), cancel: vi.fn(), submitKey: vi.fn(), logs: vi.fn() };
  renderHook(() => useHarnessWorkflowController({ harness,
    capability: { harnessInstanceId: harness.id, harness: "claude", displayName: "Claude Code", installState: "installed",
      loginMethods: ["terminal"], apiKeyProviders: [], install: false, uninstall: false, logs: false },
    client,
    operationId: receipt.id, disabled: false, onRefresh: vi.fn(), onRefreshAfterLogin, onOpenTerminal: vi.fn(),
  }));
  await waitFor(() => expect(onRefreshAfterLogin).toHaveBeenCalledWith(receipt));
});

it.each([false, true])("immediately fences older responses while preserving active forced renewal=%s", async forced => {
  const { get, hook, identity, next: older } = await mounted();
  const latest = deferred<typeof catalog>();
  get.mockReturnValueOnce(older.promise).mockReturnValueOnce(latest.promise);
  act(() => { if (forced) hook.result.current.refresh(); else invalidateDesktopChatgptPlanCatalog(identity); });
  const oldSignal = get.mock.calls[1]![1].signal as AbortSignal;
  act(() => invalidateDesktopProviderCatalog(identity, undefined, snapshot, receipt));
  expect(oldSignal.aborted).toBe(true);
  expect(get).toHaveBeenCalledTimes(3);
  expect(get.mock.calls[2]![0].includes("refresh=true")).toBe(forced);
  const connected = { ...catalog, instances: catalog.instances.map(value => ({ ...value, displayName: "Current login" })) };
  await act(async () => latest.resolve(connected));
  await act(async () => older.resolve(catalog));
  expect(hook.result.current.catalog).toEqual(connected);
  expect(hook.result.current.hasTrustedCatalog).toBe(true);
});

it.each(["cancelled", "succeeded"] as const)("reconciles an actual login Cancel result=%s without broad renewal", async state => {
  const onRefresh = vi.fn();
  const onRefreshAfterLogin = vi.fn().mockResolvedValue(undefined);
  const harness = snapshot.harnesses[0]!;
  const client = { capabilities: vi.fn(), start: vi.fn(), get: vi.fn().mockResolvedValue({ ...receipt, state: "running" }),
    cancel: vi.fn().mockResolvedValue({ ...receipt, state }), submitKey: vi.fn(), logs: vi.fn() };
  render(<HarnessWorkflowPanel harness={harness} capability={{ harnessInstanceId: harness.id, harness: "claude", displayName: "Claude Code",
    installState: "installed", loginMethods: ["terminal"], apiKeyProviders: [], install: false, uninstall: false, logs: false }}
    client={client} operationId={receipt.id} disabled={false} onRefresh={onRefresh} onRefreshAfterLogin={onRefreshAfterLogin} onOpenTerminal={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Cancel", exact: true }));
  await waitFor(() => expect(client.cancel).toHaveBeenCalledOnce());
  await act(async () => undefined);
  expect(onRefresh).not.toHaveBeenCalled();
  expect(onRefreshAfterLogin).toHaveBeenCalledTimes(state === "succeeded" ? 1 : 0);
});

it("does not downgrade a queued explicit authority renewal when login completes offline", async () => {
  const { get, hook, identity, next } = await mounted();
  act(() => window.dispatchEvent(new Event("offline")));
  act(() => hook.result.current.refresh());
  act(() => invalidateDesktopProviderCatalog(identity, undefined, snapshot, receipt));
  expect(get).toHaveBeenCalledOnce();
  act(() => window.dispatchEvent(new Event("online")));
  expect(get).toHaveBeenCalledTimes(2);
  expect(get.mock.calls[1]![0]).toContain("refresh=true");
  await act(async () => next.resolve(catalog));
});

it("targets only independent ChatGPT plan routes when IPC confirms login for an already-open Chat", async () => {
  const initial = CanonicalProviderCatalogSchema.parse(ordinaryPlanCatalog());
  const { get, hook, identity, next } = await mounted(initial);
  const disconnected = { state: "disconnected", scope: "this_device", models: [], grant: { revision: 0, enabled: false, background: false }, bridgeConnected: false, revocation: "none" };
  const connected = { ...disconnected, state: "connected", account: { id: "11111111-1111-4111-8111-111111111111", label: "Synthetic owner" },
    grant: { revision: 1, enabled: true, background: false }, bridgeConnected: true };
  const call = vi.fn().mockResolvedValueOnce(disconnected).mockResolvedValueOnce({ ...disconnected, state: "connecting" }).mockResolvedValue(connected);
  const client = createDesktopChatgptPlanClient({ runtimeSlot: "primary", authGeneration: 0 }, () => true, call,
    () => invalidateDesktopChatgptPlanCatalog(identity));
  const signal = new AbortController().signal;
  await act(async () => { await client.status(signal); await client.connect({ purpose: "personal_local" }, signal); });
  expect(get).toHaveBeenCalledOnce();
  await act(async () => { await client.status(signal); await client.status(signal); });
  expect(get).toHaveBeenCalledTimes(2);
  expect(get.mock.calls[1]![0]).not.toContain("refresh=true");
  expect(hook.result.current.catalog.instances.find(value => value.id === planId)?.availability).toBe("unavailable");
  expect(hook.result.current.catalog.instances.find(value => value.driverKind === "codex")?.availability).toBe("available");
  expect(hook.result.current.initialLoading).toBe(false);
  await act(async () => next.resolve(initial));
  expect(hook.result.current.catalog).toEqual(initial);
});

it("updates mounted Chat from Get started login before advisory Settings returns", async () => {
  const advisory = deferred<typeof snapshot>(), catalogRead = deferred<typeof catalog>();
  const reads: string[] = [];
  let settingsReads = 0, catalogReads = 0;
  const initial = CanonicalProviderCatalogSchema.parse({ ...catalog, instances: catalog.instances.map(instance => {
    if (instance.driverKind !== "codex") return instance;
    const { defaultSelection: _selection, ...rest } = instance;
    return { ...rest, availability: "auth_required" };
  }) });
  const option = { id: "openai_device_code", providerId: "openai", authKind: "subscription", method: "device_code",
    billingKind: "subscription", executionKind: "native", availability: "available" } as const;
  const get = vi.fn((path: string) => {
    reads.push(path);
    if (path.startsWith("/api/chat-providers?")) return ++catalogReads === 1 ? Promise.resolve(initial) : catalogRead.promise;
    if (path.startsWith("/api/ai/provider-settings")) return ++settingsReads === 1 ? Promise.resolve(snapshot) : advisory.promise;
    throw new Error(`Unexpected synthetic read ${path}`);
  });
  const post = vi.fn(async () => ({ ...receipt, id: "get_started_codex", harnessInstanceId: "codex_default", connectionOption: option }));
  const pinned = { get, post }, api = { ...pinned, forRuntime: vi.fn(() => pinned) };
  useConnection.setState({ status: "signed-in", handle: "synthetic-owner", userId: "synthetic-user", runtimeSlot: "primary", api: api as never });
  startDesktopProviderCatalogCoordinator();
  const chat = renderHook(() => useChatProviderCatalog(initial));
  await waitFor(() => expect(chat.result.current.hasTrustedCatalog).toBe(true));
  render(<DesktopGetStartedAgentLogin>{port => <GetStartedAgentDetails agent="codex" port={port}
    capabilities={{ codex: { harnessInstanceId: "codex_default", harness: "codex", displayName: "Codex", installState: "installed",
      loginMethods: ["device_code"], connectionOptions: [option], apiKeyProviders: [], install: false, uninstall: false, logs: false } }}
    onStateChange={() => {}} />}</DesktopGetStartedAgentLogin>);
  fireEvent.click(await screen.findByRole("button", { name: /ChatGPT account.*Sign in with a code/ }));
  await waitFor(() => expect(settingsReads).toBe(2));
  // Advisory read is still pending. The receipt must already wake the same Chat.
  expect(catalogReads).toBe(2);
  expect(useConnection.getState().providerCatalogAffectedInstanceIds).toEqual(["codex_default"]);
  expect(reads.every(path => !path.includes("refresh=true"))).toBe(true);
  await act(async () => catalogRead.resolve(catalog));
  expect(chat.result.current.hasTrustedCatalog).toBe(true);
  expect(chat.result.current.catalog.instances.find(row => row.id === "codex_default")?.availability).toBe("available");
  expect(post).toHaveBeenCalledOnce();
  await act(async () => advisory.resolve(snapshot));
});
