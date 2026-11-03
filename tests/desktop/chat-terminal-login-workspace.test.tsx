// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CanonicalProviderCatalogSchema, ProviderWorkflowV2Schema } from "@matrix-os/contracts";
import { CanonicalChatWorkspace } from "@desktop/renderer/src/features/chat/CanonicalChatWorkspace";
import { createApiClient } from "@desktop/renderer/src/lib/api";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useCodingAgentWorkspace } from "@desktop/renderer/src/stores/coding-agent-workspace";
import { useTabs } from "@desktop/renderer/src/stores/tabs";
import { useShellSessions } from "@desktop/renderer/src/stores/shell-sessions";
import { useBoard } from "@desktop/renderer/src/stores/board";
import { startDesktopProviderCatalogCoordinator, stopDesktopProviderCatalogCoordinator } from "@desktop/renderer/src/features/chat/provider-catalog-coordinator";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat";
import { disconnectedSnapshot } from "../ui/chat-provider-settings-fixture";
import { createCanonicalChatWorkspaceClient } from "./canonical-chat-workspace-test-utils";
import { resetProviderPreferences } from "./provider-preferences-test-utils";
import { setSharedComposerText } from "./shared-chat-composer-test-utils";

afterEach(() => {
  cleanup();
  stopDesktopProviderCatalogCoordinator();
  useConnection.setState(useConnection.getInitialState(), true);
  vi.restoreAllMocks();
});

// The backgrounded OAuth browser may throttle a renderer timer. Returning to
// Electron must observe the canonical receipt without waiting for that timer.
it.each(["focus", "visibility"] as const)("wakes a throttled Terminal receipt on %s return and updates the real Chat picker and draft", async wake => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as typeof ResizeObserver;
  for (const store of [useConnection, useCodingAgentWorkspace, useTabs, useShellSessions, useBoard]) {
    store.setState(store.getInitialState(), true);
  }
  resetProviderPreferences({ hydrated: true });
  const workspaceId = `tws_${"a".repeat(32)}`, tabId = `tt_${"b".repeat(32)}`;
  const option = { id: "openai_terminal", providerId: "openai", authKind: "subscription", method: "terminal",
    billingKind: "subscription", executionKind: "native", availability: "available" } as const;
  const receipt = ProviderWorkflowV2Schema.parse({ id: "workflow_terminal_fixture", harnessInstanceId: "harness_codex", kind: "login",
    state: "running", expiresAt: new Date(Date.now() + 600_000).toISOString(), terminalSessionId: `${workspaceId}:${tabId}`,
    deviceCode: null, authorizationUrl: null, safeFailure: null, connectionOption: option });
  const base = createCanonicalProviderCatalogFixture();
  const codex = { ...base.instances[0]!, id: "codex_default", displayName: "Codex", models: Array.from({ length: 8 }, (_, index) => ({
    ...base.instances[0]!.models[0]!, id: `codex-model-${index}`, displayName: `Codex model ${index}`,
  })), defaultSelection: { ...base.instances[0]!.defaultSelection!, instanceId: "codex_default", model: "codex-model-0" } };
  const ready = CanonicalProviderCatalogSchema.parse({ ...base, instances: [codex] });
  const { defaultSelection: _default, ...withoutDefault } = codex;
  const disconnected = CanonicalProviderCatalogSchema.parse({ ...ready, instances: [{ ...withoutDefault, availability: "unavailable", models: [],
    setupActions: [{ id: "codex_connect", kind: "foreground_terminal", label: "Connect Codex", command: "codex login --device-auth" }] }] });
  const snapshot = disconnectedSnapshot();
  snapshot.harnesses = snapshot.harnesses.map(harness => harness.harness === "codex" ? { ...harness, id: "harness_codex" } : harness);
  let succeeded = false, workflowReads = 0;
  const requests: Array<{ url: URL; method: string }> = [];
  const fetchFn = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input), method = init?.method ?? "GET";
    requests.push({ url, method });
    expect(url.searchParams.get("runtime")).toBe("dev");
    let value: unknown;
    if (url.pathname === "/api/chat-providers") value = succeeded ? ready : disconnected;
    else if (url.pathname === "/api/ai/provider-settings") value = snapshot;
    else if (url.pathname.endsWith("/v2/capabilities")) value = [{ harnessInstanceId: "harness_codex", harness: "codex", displayName: "Codex",
      installState: "installed", loginMethods: ["terminal"], apiKeyProviders: [], install: false, uninstall: false, logs: true, connectionOptions: [option] }];
    else if (url.pathname.endsWith("/v2/start")) value = receipt;
    else if (url.pathname.endsWith(`/v2/${receipt.id}`)) { workflowReads += 1; value = { ...receipt, state: succeeded ? "succeeded" : "running" }; }
    else if (url.pathname === "/api/terminal/workspaces") value = { workspaces: [{ id: workspaceId, revision: 1,
      tabs: [{ id: tabId, name: "Connect Codex", cwd: "projects", status: "active", revision: 1 }] }] };
    else throw new Error(`Unexpected synthetic HTTP ${method} ${url.pathname}`);
    return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  const api = createApiClient({ baseUrl: "https://fixture.invalid", getRuntimeSlot: () => "dev", fetchFn });
  useConnection.setState({ status: "signed-in", handle: "fixture_computer", userId: "fixture_owner", platformHost: api.baseUrl,
    runtimeSlot: "dev", authGeneration: 7, api });
  const summary = { runtime: { id: "fixture_dev", label: "Test computer", status: "available" }, capabilities: [], providers: [],
    projects: { items: [], hasMore: false, limit: 20 }, activeThreads: { items: [], hasMore: false, limit: 20 },
    attentionThreads: { items: [], hasMore: false, limit: 20 }, terminalSessions: { items: [], hasMore: false, limit: 20 },
    previewSessions: { items: [], hasMore: false, limit: 20 }, recentActivity: { items: [], hasMore: false, limit: 20 },
    limits: { maxPromptBytes: 16384, maxAttachmentCount: 8, maxTerminalInputBytes: 8192, maxListItems: 20 }, serverTime: new Date().toISOString() };
  window.operator = { invoke: vi.fn(async channel => channel === "runtime:get-summary" ? summary : { value: null }), on: vi.fn(() => () => undefined) };
  startDesktopProviderCatalogCoordinator();
  render(<CanonicalChatWorkspace api={api} client={createCanonicalChatWorkspaceClient()} projectId={null} initialView="draft" active />);
  const composer = await screen.findByRole("textbox", { name: "Start a chat" });
  await setSharedComposerText(composer, "Keep this exact unsent Terminal login draft");
  fireEvent.click(screen.getByRole("button", { name: "Choose model and provider" }));
  const picker = document.querySelector<HTMLElement>('[data-slot="provider-model-picker"]');
  expect(picker).not.toBeNull();
  const connect = within(picker!).getByRole("button", { name: "Connect Codex" });
  // Preserve normal component timers, but hold the observer's one-second wake.
  const nativeTimeout = globalThis.setTimeout.bind(globalThis);
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: TimerHandler, ms?: number, ...args: unknown[]) =>
    nativeTimeout(callback, ms === 1000 ? 60_000 : ms, ...args)) as typeof setTimeout);
  fireEvent.click(connect);
  await waitFor(() => expect(useTabs.getState().terminalSessionRequest?.sessionName).toBe(`${workspaceId}:${tabId}`), { timeout: 1500 });
  await waitFor(() => expect(window.operator.invoke).toHaveBeenCalledWith("runtime:get-summary", {}), { timeout: 1500 });
  expect(workflowReads).toBe(0);
  expect(requests.filter(request => request.url.pathname === "/api/chat-providers")).toHaveLength(1);
  succeeded = true;
  await act(async () => {
    if (wake === "focus") window.dispatchEvent(new Event("focus"));
    else document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(workflowReads).toBe(1);
  await waitFor(() => expect(useConnection.getState().providerCatalogGeneration).toBe(1), { timeout: 1500 });
  fireEvent.click(screen.getByRole("button", { name: "Choose model and provider" }));
  await screen.findByRole("option", { name: /Codex model 0/ });
  const options = screen.getAllByRole("option", { name: /Codex model/ });
  expect(options).toHaveLength(8);
  expect(options.every(option => !(option as HTMLButtonElement).disabled && option.getAttribute("aria-disabled") !== "true")).toBe(true);
  expect(composer.textContent).toBe("Keep this exact unsent Terminal login draft");
  const catalogs = requests.filter(request => request.url.pathname === "/api/chat-providers");
  expect(catalogs).toHaveLength(2);
  expect(catalogs.every(request => !request.url.searchParams.has("refresh"))).toBe(true);
  expect(requests.filter(request => request.method === "POST")).toHaveLength(1);
  await act(async () => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); });
  expect(workflowReads).toBe(1);
});
