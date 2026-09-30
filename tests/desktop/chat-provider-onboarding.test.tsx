// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CanonicalChatWorkspace } from "@desktop/renderer/src/features/chat/CanonicalChatWorkspace";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useBoard } from "@desktop/renderer/src/stores/board";
import { createCanonicalChatWorkspaceClient, providerCatalog } from "./canonical-chat-workspace-test-utils";
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
    await waitFor(() => expect(screen.queryByText("Checking connections…")).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Connect Claude Code" })).not.toBeInTheDocument();
  });
});
