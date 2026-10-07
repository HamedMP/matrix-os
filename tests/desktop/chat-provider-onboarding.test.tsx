import { startDesktopProviderCatalogCoordinator, stopDesktopProviderCatalogCoordinator } from "@desktop/renderer/src/features/chat/provider-catalog-coordinator";
import { resetProviderPreferences } from "./provider-preferences-test-utils";
// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanonicalChatWorkspace } from "@desktop/renderer/src/features/chat/CanonicalChatWorkspace";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useBoard } from "@desktop/renderer/src/stores/board";
import { createCanonicalChatWorkspaceClient, providerCatalog } from "./canonical-chat-workspace-test-utils";
import { setSharedComposerText } from "./shared-chat-composer-test-utils";
import { disconnectedSnapshot } from "../ui/chat-provider-settings-fixture";
import { openExistingProviderTerminalSession } from "@desktop/renderer/src/features/settings/provider-settings-desktop-adapter";
import type { ApiClient } from "@desktop/renderer/src/lib/api";
vi.mock("@desktop/renderer/src/features/settings/provider-settings-desktop-adapter", async (original) => ({
  ...(await original<typeof import("@desktop/renderer/src/features/settings/provider-settings-desktop-adapter")>()),
  openExistingProviderTerminalSession: vi.fn(async () => true),
}));
beforeEach(() => {
  vi.clearAllMocks();
  useConnection.setState(useConnection.getInitialState(), true); useBoard.setState(useBoard.getInitialState(), true);
  window.operator = { invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(() => () => undefined) };
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
describe("canonical native empty Chat connection wiring", () => {
  it.each(["checking", "unknown", "read_failed"])("preserves native starter cards and draft while connection evidence is %s", async (state) => {
    const snapshot = disconnectedSnapshot(); snapshot.harnesses[0]!.authState = "unknown";
    const api = { forRuntime: () => api, get: vi.fn(async () => {
      if (state === "checking") return await new Promise(() => undefined);
      if (state === "read_failed") throw new Error("private settings failure");
      return snapshot;
    }) };
    useConnection.setState({ status: "signed-in", handle: "owner", runtimeSlot: "preview", api: api as unknown as ApiClient });
    render(<CanonicalChatWorkspace client={createCanonicalChatWorkspaceClient()} projectId={null} initialView="draft" active catalog={providerCatalog} />);
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(await screen.findByRole("button", { name: "Explore and understand code" })).toBeVisible();
    const draft = screen.getByRole("textbox", { name: "Start a chat" });
    await setSharedComposerText(draft, "Keep this native prompt");
    expect(draft).toHaveTextContent("Keep this native prompt");
    expect(screen.queryByRole("region", { name: "Chat provider connection" })).not.toBeInTheDocument();
    expect(screen.queryByText("Connection status unavailable")).not.toBeInTheDocument();
    expect(screen.queryByText("private settings failure")).not.toBeInTheDocument();
  });
  it.each([null, "matrix-os"])("keeps failed-read recovery in a top-safe scroll area for wide Chat project=%s", async (projectId) => {
    const api = { forRuntime: () => api, get: vi.fn(async () => { throw new Error("settings unavailable"); }) };
    useConnection.setState({ status: "signed-in", handle: "owner", api: api as unknown as ApiClient });
    render(<CanonicalChatWorkspace client={createCanonicalChatWorkspaceClient()} projectId={projectId} initialView="draft" active catalog={providerCatalog} />);
    const retry = await screen.findByRole("button", { name: "Check connection" });
    await waitFor(() => expect(retry).toBeEnabled());
    const scroll = retry.closest<HTMLElement>('[data-slot="chat-starter-scroll"], [data-slot="chat-project-draft-scroll"]');
    expect(scroll).not.toBeNull();
    expect(scroll).toHaveClass("min-h-0", "overflow-y-auto");
    expect(scroll).toHaveClass("items-start");
    expect(scroll?.querySelector('[data-slot="chat-starter-stack"]')).toHaveClass("my-auto");
    expect(scroll?.contains(screen.getByRole("textbox", { name: "Start a chat" }))).toBe(false);
    expect(screen.getByRole("button", { name: "Explore and understand code" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Chat provider connection" })).not.toBeInTheDocument();
  });
  it("opens the server-issued Settings login in Terminal on the selected runtime", async () => {
    const snapshot = disconnectedSnapshot();
    const api = { forRuntime: vi.fn(() => api), get: vi.fn(async (path: string) => path.includes("provider-settings") ? snapshot : providerCatalog), post: vi.fn(async () => ({ kind: "login_attempt", snapshot: { ...snapshot, revision: 2, projectionOf: { ...snapshot.projectionOf, revision: 2 } }, attempt: { id: "native_attempt", harnessInstanceId: "claude_default", accountId: null, method: "terminal", state: "pending", expiresAt: new Date(Date.now() + 60_000).toISOString(), action: { kind: "open_terminal", terminalSessionId: "claude-login" }, safeFailure: null } })) };
    useConnection.setState({ status: "signed-in", handle: "owner", platformHost: "https://app.example.test", runtimeSlot: "preview", api: api as unknown as ApiClient });
    render(<CanonicalChatWorkspace client={createCanonicalChatWorkspaceClient()} projectId={null} initialView="draft" active catalog={providerCatalog} />);
    const connect = await screen.findByRole("button", { name: "Connect Claude Code" });
    await waitFor(() => expect(connect).toBeEnabled()); fireEvent.click(connect);
    await waitFor(() => expect(openExistingProviderTerminalSession).toHaveBeenCalledWith(api, "claude-login", expect.any(Function)));
    expect(api.forRuntime).toHaveBeenCalledWith("preview");
    expect(api.post).toHaveBeenCalledWith(expect.stringContaining("/api/ai/provider-settings/actions"), expect.objectContaining({ type: "start_login", harnessInstanceId: "claude_default", expectedRevision: 1 }), expect.any(Object));
  });
  it("rejects a late old-runtime settings response", async () => {
    let release!: (value: unknown) => void;
    const oldApi = { forRuntime: () => oldApi, get: vi.fn(() => new Promise((resolve) => { release = resolve; })) };
    const connected = disconnectedSnapshot(); connected.harnesses[0]!.authState = "authenticated";
    const newApi = { forRuntime: () => newApi, get: vi.fn(async () => connected) };
    useConnection.setState({ status: "signed-in", handle: "owner", runtimeSlot: "old", api: oldApi as unknown as ApiClient });
    render(<CanonicalChatWorkspace client={createCanonicalChatWorkspaceClient()} projectId={null} initialView="draft" active catalog={providerCatalog} />);
    await waitFor(() => expect(oldApi.get).toHaveBeenCalled());
    act(() => useConnection.setState({ runtimeSlot: "new", api: newApi as unknown as ApiClient }));
    await waitFor(() => expect(newApi.get).toHaveBeenCalled());
    await act(async () => release(disconnectedSnapshot()));
    expect(await screen.findByRole("button", { name: "Explore and understand code" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Connect Claude Code" })).not.toBeInTheDocument();
  });
});


afterEach(() => { cleanup(); stopDesktopProviderCatalogCoordinator(); vi.unstubAllGlobals(); });
it("mounted signed-in onboarding does not invalidate the warmed provider cache on twenty application switches", async () => {
  resetProviderPreferences({ hydrated: true });
  const settings = disconnectedSnapshot(); settings.harnesses[0]!.authState = "unknown";
  const get = vi.fn(async (path: string) => path.startsWith("/api/chat-providers") ? providerCatalog : settings);
  const api = { forRuntime: () => api, get };
  useConnection.setState({ status: "signed-in", handle: "owner", api: api as unknown as ApiClient });
  const stop = startDesktopProviderCatalogCoordinator();
  render(<CanonicalChatWorkspace client={createCanonicalChatWorkspaceClient()} api={api as unknown as ApiClient} projectId={null} initialView="draft" active />);
  const trigger = await screen.findByRole("button", { name: "Choose model and provider" });
  await waitFor(() => expect(trigger.querySelector('[role="status"]')).toBeNull());
  await setSharedComposerText(screen.getByRole("textbox", { name: "Start a chat" }), "Keep the warmed draft");
  await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeEnabled());
  const reads = get.mock.calls.length;
  for (let index = 0; index < 20; index++) act(() => {
    window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange"));
  });
  await act(async () => undefined);
  expect(get.mock.calls).toHaveLength(reads);
  expect(useConnection.getState().providerCatalogGeneration).toBe(0);
  expect(trigger.querySelector('[role="status"]')).toBeNull();
  expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  act(() => stop());
});
