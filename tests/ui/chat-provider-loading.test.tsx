// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat";
import { useChatProviderCatalog } from "../../desktop/src/renderer/src/features/chat/chat-provider-catalog";
import { SharedChatComposer } from "@desktop/renderer/src/features/chat/SharedChatComposer";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { CanonicalChatWorkspace } from "../../desktop/src/renderer/src/features/chat/CanonicalChatWorkspace";
import { createCanonicalChatWorkspaceClient } from "../desktop/canonical-chat-workspace-test-utils";
import type { ApiClient } from "../../desktop/src/renderer/src/lib/api";
import { ChatApp } from "../../shell/src/components/ChatApp";
import { PROVIDER_SETTINGS_CHANGED_EVENT } from "../../shell/src/lib/canonical-provider-setup";
import { disconnectedSnapshot } from "./chat-provider-settings-fixture";
import {
  startDesktopProviderCatalogCoordinator,
  stopDesktopProviderCatalogCoordinator,
} from "../../desktop/src/renderer/src/features/chat/provider-catalog-coordinator";

vi.mock("../../shell/src/components/chat-provider-onboarding", () => ({ ChatProviderOnboarding: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("@clerk/nextjs", async (original) => ({ ...(await original<typeof import("@clerk/nextjs")>()), useOrganization: () => ({ organization: null }), useAuth: () => ({ userId: null, sessionId: null }) }));
beforeEach(() => {
  stopDesktopProviderCatalogCoordinator();
  useConnection.setState(useConnection.getInitialState(), true);
  useConnection.setState({ status: "signed-in", handle: "operator", platformHost: "https://platform.test",
    runtimeSlot: "primary", authGeneration: 1, api: null });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  stopDesktopProviderCatalogCoordinator();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useConnection.setState(useConnection.getInitialState(), true);
});

function startCatalogCoordinator(api: Pick<ApiClient, "get">) {
  const settings = disconnectedSnapshot();
  settings.harnesses.forEach((harness) => { harness.authState = "authenticated"; });
  const runtimeApi = {
    baseUrl: "https://matrix.test",
    forRuntime: vi.fn(() => runtimeApi),
    get: vi.fn((path: string, options?: Parameters<ApiClient["get"]>[1]) =>
      path.startsWith("/api/ai/provider-settings?") ? Promise.resolve(settings) : api.get(path, options)),
  };
  useConnection.setState({ api: runtimeApi as unknown as ApiClient });
  startDesktopProviderCatalogCoordinator();
  return runtimeApi as unknown as ApiClient;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

it("blocks cold Electron reads and retains working selection, sending, and model controls during warm refresh", async () => {
  const catalog = createCanonicalProviderCatalogFixture();
  const initial = deferred<typeof catalog>();
  const refreshed = deferred<typeof catalog>();
  const get = vi.fn().mockReturnValueOnce(initial.promise).mockReturnValueOnce(refreshed.promise);
  const api = startCatalogCoordinator({ get });
  const submit = vi.fn();
  const change = vi.fn();
  function Composer() {
    const state = useChatProviderCatalog(catalog, { api });
    return <><button onClick={state.refresh}>Refresh catalog</button><SharedChatComposer value="Keep my draft" onChange={vi.fn()} onSubmit={submit} busy={false} canSubmit
      catalog={state.catalog} providerCatalogLoading={state.initialLoading}
      selection={{ instanceId: "codex_fixture", model: "gpt-5.6-sol", options: [], interactionMode: "default", permissionMode: "supervised" }}
      instanceLocked={false} onSelectionChange={change} /></>;
  }
  render(<Composer />);
  const trigger = screen.getByRole("button", { name: "Choose model and provider" });
  expect(within(trigger).getByRole("status", { name: "Checking model availability" })).toBeVisible();
  expect(within(trigger).getByText("GPT-5.6-Sol · Codex fixture")).toBeVisible();
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  await act(async () => initial.resolve(catalog));
  await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeEnabled());
  fireEvent.click(trigger);
  expect(get).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Refresh catalog" }));
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  expect(within(trigger).queryByRole("status", { name: "Checking model availability" })).toBeNull();
  expect(within(trigger).getByText("GPT-5.6-Sol · Codex fixture")).toBeVisible();
  expect(screen.getByRole("listbox")).not.toHaveAttribute("aria-busy", "true");
  expect(within(screen.getByRole("listbox")).getByRole("option")).toBeEnabled();
  fireEvent.click(within(screen.getByRole("listbox")).getByRole("option"));
  expect(change).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(submit).toHaveBeenCalledOnce();
  await act(async () => refreshed.resolve(catalog));
  expect(screen.queryByRole("status", { name: "Checking model availability" })).toBeNull();
  expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
});

it("shows shared Web loading in the trigger and open picker for initial and explicit revalidation without sending", async () => {
  const catalog = createCanonicalProviderCatalogFixture();
  const initial = deferred<Response>();
  const refreshed = deferred<Response>();
  const fetcher = vi.fn().mockReturnValueOnce(initial.promise).mockReturnValueOnce(refreshed.promise);
  vi.stubGlobal("fetch", fetcher);
  const submit = vi.fn();
  render(<ChatApp messages={[]} busy={false} connected conversations={[]} onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={submit} />);
  const trigger = screen.getByRole("button", { name: "Choose model and connection" });
  expect(within(trigger).getByRole("status", { name: "Checking model availability" })).toBeVisible();
  await act(async () => initial.resolve(Response.json(catalog)));
  await waitFor(() => expect(within(trigger).queryByRole("status")).toBeNull());
  trigger.focus();
  fireEvent.click(trigger);
  expect(fetcher).toHaveBeenCalledTimes(1);
  act(() => window.dispatchEvent(new CustomEvent(PROVIDER_SETTINGS_CHANGED_EVENT)));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(within(trigger).getByRole("status", { name: "Checking model availability" })).toBeVisible();
  expect(screen.getByRole("searchbox")).not.toHaveFocus();
  expect(screen.getByRole("listbox")).toHaveAttribute("aria-busy", "true");
  expect(within(screen.getByRole("listbox")).getByRole("option")).toBeDisabled();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(trigger).toHaveFocus();
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(within(trigger).getByRole("status", { name: "Checking model availability" })).toBeVisible();
  await act(async () => refreshed.resolve(Response.json(catalog)));
  await waitFor(() => expect(screen.queryByRole("status", { name: "Checking model availability" })).toBeNull());
  expect(submit).not.toHaveBeenCalled();
});

it("wires cold loading and quiet five-minute background refresh through the production Electron workspace", async () => {
  vi.useFakeTimers();
  const catalog = createCanonicalProviderCatalogFixture();
  const initial = deferred<typeof catalog>();
  const refreshed = deferred<typeof catalog>();
  let reads = 0;
  const get = vi.fn((path: string) => path.startsWith("/api/chat-providers") ? (++reads === 1 ? initial.promise : refreshed.promise) : Promise.resolve({}));
  const api = startCatalogCoordinator({ get } as unknown as Pick<ApiClient, "get">);
  window.operator = { invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(() => () => undefined) };
  render(<CanonicalChatWorkspace client={createCanonicalChatWorkspaceClient()} api={api} projectId={null} active initialView="draft" />);
  await act(async () => {});
  const trigger = screen.getByRole("button", { name: "Choose model and provider" });
  expect(trigger).toBeEnabled();
  expect(within(trigger).getByRole("status", { name: "Checking model availability" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  await act(async () => initial.resolve(catalog));
  expect(within(trigger).queryByRole("status")).toBeNull();
  expect(trigger).toHaveAttribute("data-provider-instance", "codex_fixture");
  fireEvent.click(trigger);
  expect(reads).toBe(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  act(() => window.dispatchEvent(new Event("focus")));
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(reads).toBe(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(240_000); });
  expect(reads).toBe(2);
  expect(within(trigger).queryByRole("status", { name: "Checking model availability" })).toBeNull();
  expect(within(trigger).getByText("GPT-5.6-Sol · Codex fixture")).toBeVisible();
  expect(within(screen.getByRole("listbox")).getByRole("option")).toBeEnabled();
  await act(async () => refreshed.resolve(catalog));
  expect(within(screen.getByRole("listbox")).getByRole("option")).toBeEnabled();
});

it("preserves held credit identity and reason during loading while keeping Stop available", () => {
  const catalog = createCanonicalProviderCatalogFixture();
  const instance = catalog.instances[0]!;
  instance.id = "matrix_pi_default";
  instance.driverKind = "matrix_pi";
  instance.displayName = "Matrix AI";
  instance.connectionState = "credit_reserved";
  instance.availability = "unavailable";
  instance.defaultSelection = undefined;
  instance.models[0]!.availability = "unavailable";
  catalog.drivers = [{ kind: "matrix_pi", displayName: "Pi", adapterVersion: "1.0.0", capabilityClass: "system_agent" }];
  const cancel = vi.fn();
  const change = vi.fn();
  render(<SharedChatComposer value="Keep draft" onChange={vi.fn()} onSubmit={vi.fn()} busy canSubmit onAbort={cancel}
    catalog={catalog} providerCatalogLoading selection={{ instanceId: instance.id, model: instance.models[0]!.id, options: [], interactionMode: "default", permissionMode: "supervised" }} instanceLocked onSelectionChange={change} />);
  const trigger = screen.getByRole("button", { name: "Choose model and provider" });
  expect(within(trigger).getByText("Credit reserved")).toBeVisible();
  expect(trigger).toHaveAttribute("data-provider-instance", "matrix_pi_default");
  expect(trigger).toHaveAttribute("data-model", instance.models[0]!.id);
  expect(within(trigger).getByRole("status", { name: "Checking model availability" })).toBeVisible();
  fireEvent.click(trigger);
  expect(screen.getByText("Your credit is reserved while usage is confirmed.")).toBeVisible();
  expect(screen.getByRole("option")).toBeDisabled();
  fireEvent.click(screen.getByRole("option"));
  expect(change).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });
  const stop = screen.getByRole("button", { name: "Stop" });
  expect(stop).toBeEnabled();
  fireEvent.click(stop);
  expect(cancel).toHaveBeenCalledOnce();
});

it.each(["credit_reserved", "credit_required"] as const)("keeps the confirmed %s reason on the actual bound workspace model row during quiet background refresh", async (creditState) => {
  vi.useFakeTimers();
  const { canonicalChatRecord, snapshot } = await import("../desktop/canonical-chat-workspace-test-utils");
  const catalog = createCanonicalProviderCatalogFixture();
  const instance = catalog.instances[0]!;
  instance.id = "matrix_pi_default";
  instance.driverKind = "matrix_pi";
  instance.displayName = "Matrix AI";
  instance.connectionState = creditState;
  instance.availability = "unavailable";
  instance.defaultSelection = undefined;
  instance.models[0]!.availability = "unavailable";
  catalog.drivers = [{ kind: "matrix_pi", displayName: "Pi", adapterVersion: "1.0.0", capabilityClass: "system_agent" }];
  const record = { ...canonicalChatRecord, providerBinding: { ...canonicalChatRecord.providerBinding!, instanceId: instance.id, driverKind: instance.driverKind }, chat: {
    ...canonicalChatRecord.chat, currentSelection: { instanceId: instance.id, model: instance.models[0]!.id },
  } };
  const client = createCanonicalChatWorkspaceClient();
  vi.mocked(client.list).mockResolvedValue({ items: [record] });
  vi.mocked(client.search).mockResolvedValue({ items: [record] });
  vi.mocked(client.getDetail).mockResolvedValue({ record, messages: snapshot.messages, turns: snapshot.turns, runs: snapshot.runs, activities: snapshot.activities });
  const refreshed = deferred<typeof catalog>();
  let reads = 0;
  const get = vi.fn((path: string) => path.startsWith("/api/chat-providers") ? (++reads === 1 ? Promise.resolve(catalog) : refreshed.promise) : Promise.resolve({}));
  const api = startCatalogCoordinator({ get } as unknown as Pick<ApiClient, "get">);
  window.operator = { invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(() => () => undefined) };
  render(<CanonicalChatWorkspace client={client} api={api} projectId={null} active initialChatId={record.chat.id} />);
  await act(async () => {});
  const trigger = screen.getByRole("button", { name: "Choose model and provider" });
  expect(trigger).toHaveAttribute("data-provider-instance", instance.id);
  expect(within(trigger).queryByRole("status")).toBeNull();
  fireEvent.click(trigger);
  expect(reads).toBe(1);
  act(() => window.dispatchEvent(new Event("focus")));
  expect(reads).toBe(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
  expect(reads).toBe(2);
  const option = within(screen.getByRole("listbox")).getByRole("option");
  expect(option).toBeDisabled();
  expect(within(option).getByText(creditState === "credit_reserved" ? /Matrix AI credit reserved/ : /Matrix AI credit required/)).toBeVisible();
  expect(within(trigger).queryByRole("status", { name: "Checking model availability" })).toBeNull();
  expect(trigger).toHaveAttribute("data-provider-instance", instance.id);
  expect(trigger).toHaveAttribute("data-model", instance.models[0]!.id);
  fireEvent.click(option);
  expect(client.admitTurn).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(within(trigger).queryByRole("status", { name: "Checking model availability" })).toBeNull();
  if (creditState === "credit_reserved") expect(within(trigger).getByText("Credit reserved")).toBeVisible();
  await act(async () => refreshed.resolve(catalog));
});
