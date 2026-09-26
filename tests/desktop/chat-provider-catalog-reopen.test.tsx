// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CanonicalProviderCatalogSchema, type CanonicalProviderCatalog } from "@matrix-os/contracts";
import { HermesPane } from "../../desktop/src/renderer/src/features/chat/ChatTab";
import { useBoard } from "../../desktop/src/renderer/src/stores/board";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useCodingAgentWorkspace } from "../../desktop/src/renderer/src/stores/coding-agent-workspace";
import { CanonicalChatWorkspace } from "../../desktop/src/renderer/src/features/chat/CanonicalChatWorkspace";
import { createCanonicalChatWorkspaceClient } from "./canonical-chat-workspace-test-utils";
import type { ApiClient } from "../../desktop/src/renderer/src/lib/api";
import { SharedChatComposer } from "../../desktop/src/renderer/src/features/chat/SharedChatComposer";
import { useChatProviderCatalog } from "../../desktop/src/renderer/src/features/chat/chat-provider-catalog";

const support = { rootChat: true, resume: true, cancellation: true, attachments: [], tools: [], approvals: false,
  userInput: false, worktrees: "none", resources: [], interactionModes: [], permissionModes: [] };
function catalog(revision: string, savedOff = false): CanonicalProviderCatalog {
  return CanonicalProviderCatalogSchema.parse({ revision,
    drivers: [{ kind: "pi", displayName: "Pi", adapterVersion: "1.0.0", capabilityClass: "coding_agent" }],
    instances: [{ id: "pi_owner", driverKind: "pi", displayName: "Pi", availability: savedOff ? "unavailable" : "available",
      ...(savedOff ? { unavailabilityReason: "disabled_in_settings" } : {}), workspaceRequirement: "project_optional",
      catalogRevision: revision, models: savedOff ? [] : [{ id: "model", displayName: "Owner model", availability: "available",
        capabilities: [], supportsVision: false, supportsToolUse: false }], options: [], skills: [], commands: [], setupActions: [], supports: support,
      ...(!savedOff ? { defaultSelection: { instanceId: "pi_owner", model: "model" } } : {}) }],
  });
}
const oldCatalog = catalog("before_update");
const newCatalog = catalog("after_update", true);
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function CatalogComposer({ api, active = true, fallback = oldCatalog }: { api: { get: () => Promise<unknown> }; active?: boolean; fallback?: CanonicalProviderCatalog }) {
  const state = useChatProviderCatalog(fallback, { api, active });
  return <><output>{state.catalog.revision}</output><output data-testid="catalog-status">{state.status}</output><output data-testid="availability">{state.catalog.instances[0]?.availability}</output><SharedChatComposer value="" onChange={() => undefined}
    onSubmit={() => undefined} busy={false} catalog={state.catalog}
    selection={{ instanceId: "pi_owner", model: "model", options: [], interactionMode: "default", permissionMode: "supervised" }}
    onSelectionChange={() => undefined} instanceLocked={false} onProviderPickerOpen={state.refresh} /></>;
}
const openPicker = () => fireEvent.click(screen.getByRole("button", { name: "Choose model and provider" }));
afterEach(() => { cleanup(); useConnection.setState(useConnection.getInitialState(), true); useCodingAgentWorkspace.setState(useCodingAgentWorkspace.getInitialState(), true); useBoard.setState(useBoard.getInitialState(), true); });
describe("native Chat catalog freshness", () => {
  it("reloads saved-off truth when the normal picker is reopened without a cold restart", async () => {
    const get = vi.fn().mockResolvedValueOnce(oldCatalog).mockResolvedValue(newCatalog);
    render(<CatalogComposer api={{ get }} />);
    await screen.findByText("before_update");
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    openPicker();
    await screen.findByText("Disabled in Settings");
    expect(get).toHaveBeenLastCalledWith("/api/chat-providers?refresh=true&includeConnectionLabels=true");
    expect(screen.queryByText("Owner model")).toBeNull();
    expect(screen.queryByText("Connect Pi")).toBeNull();
    // Closing and rendering do not issue reads; one explicit reopen does.
    openPicker();
    expect(get).toHaveBeenCalledTimes(2);
    openPicker();
    await waitFor(() => expect(get).toHaveBeenCalledTimes(3));
  });

  it("keeps an unchanged owner route selected without fetching on ordinary renders", async () => {
    const refreshed = catalog("same_route_refreshed");
    const get = vi.fn().mockResolvedValueOnce(oldCatalog).mockResolvedValue(refreshed);
    const api = { get };
    const view = render(<CatalogComposer api={api} />);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    view.rerender(<CatalogComposer api={api} />);
    expect(get).toHaveBeenCalledTimes(1);
    openPicker();
    await screen.findByText("same_route_refreshed");
    const trigger = screen.getByRole("button", { name: "Choose model and provider" });
    expect(trigger.getAttribute("data-provider-instance")).toBe("pi_owner");
    expect(trigger.getAttribute("data-model")).toBe("model");
    expect(get).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])("retains last same-runtime catalog on reopen failure (savedOff=%s)", async (savedOff) => {
    const trusted = catalog("trusted_owner_catalog", savedOff);
    const get = vi.fn().mockResolvedValueOnce(trusted).mockRejectedValue(new Error("refresh_failed"));
    render(<CatalogComposer api={{ get }} />);
    await screen.findByText("trusted_owner_catalog");
    openPicker();
    await waitFor(() => expect(screen.getByTestId("catalog-status").textContent).toBe("error"));
    expect(screen.getByText("trusted_owner_catalog")).not.toBeNull();
    if (savedOff) {
      expect(screen.getByText("Disabled in Settings")).not.toBeNull();
      expect(screen.queryByText("Owner model")).toBeNull();
    } else {
      const trigger = screen.getByRole("button", { name: "Choose model and provider" });
      expect(trigger.getAttribute("data-provider-instance")).toBe("pi_owner");
      expect(trigger.getAttribute("data-model")).toBe("model");
    }
  });

  it("fails closed on initial and replaced-API errors instead of borrowing old trusted truth", async () => {
    const firstApi = { get: vi.fn().mockResolvedValue(newCatalog) };
    const view = render(<CatalogComposer api={firstApi} />);
    await screen.findByText("after_update");
    const replacementApi = { get: vi.fn().mockRejectedValue(new Error("new_runtime_unavailable")) };
    view.rerender(<CatalogComposer api={replacementApi} />);
    await waitFor(() => expect(screen.getByTestId("catalog-status").textContent).toBe("error"));
    expect(screen.getByText("before_update")).not.toBeNull();
    expect(screen.getByTestId("availability").textContent).toBe("unavailable");
    view.unmount();
    render(<CatalogComposer api={replacementApi} />);
    await waitFor(() => expect(screen.getByTestId("catalog-status").textContent).toBe("error"));
    expect(screen.getByTestId("availability").textContent).toBe("unavailable");
  });

  it("reopens the actual HermesPane picker with a forced read and updated saved-Off choices", async () => {
    const get = vi.fn().mockResolvedValueOnce(oldCatalog).mockResolvedValueOnce(oldCatalog).mockResolvedValue(newCatalog);
    window.operator = { invoke: vi.fn(async () => ({ value: null })), on: vi.fn(() => () => undefined) };
    useConnection.setState({ api: { get } as unknown as ApiClient });
    useCodingAgentWorkspace.setState({ status: "ready" });
    render(<HermesPane />);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    openPicker();
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Disabled in Settings")).toBeNull();
    openPicker();
    openPicker();
    await screen.findByText("Disabled in Settings");
    expect(get).toHaveBeenCalledTimes(3);
    expect(get).toHaveBeenLastCalledWith("/api/chat-providers?refresh=true&includeConnectionLabels=true");
    expect(screen.queryByText("Owner model")).toBeNull();
  });

  it("wires reopening through the production canonical workspace composer", async () => {
    const get = vi.fn(async (path: string) => path.startsWith("/api/chat-providers") ? oldCatalog : {});
    window.operator = { invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(() => () => undefined) };
    const view = render(<CanonicalChatWorkspace client={createCanonicalChatWorkspaceClient()}
      api={{ get } as unknown as ApiClient} projectId={null} active initialView="draft" />);
    const trigger = await screen.findByRole("button", { name: "Choose model and provider" });
    await waitFor(() => expect(trigger.hasAttribute("disabled")).toBe(false));
    const readsBefore = get.mock.calls.filter(([path]) => path.startsWith("/api/chat-providers")).length;
    get.mockImplementation(async (path) => path.startsWith("/api/chat-providers") ? newCatalog : {});
    fireEvent.click(trigger);
    await screen.findByText("Disabled in Settings");
    expect(get.mock.calls.filter(([path]) => path.startsWith("/api/chat-providers"))).toHaveLength(readsBefore + 1);
    view.unmount();
  });

  it.each([true, false])("preserves production workspace truth on reopen failure (savedOff=%s)", async (savedOff) => {
    const trusted = catalog("trusted_workspace", savedOff);
    let failRefresh = false;
    const get = vi.fn(async (path: string) => {
      if (!path.startsWith("/api/chat-providers")) return {};
      if (failRefresh) throw new Error("refresh_unavailable");
      return trusted;
    });
    window.operator = { invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(() => () => undefined) };
    render(<CanonicalChatWorkspace client={createCanonicalChatWorkspaceClient()}
      api={{ get } as unknown as ApiClient} projectId={null} active initialView="draft" />);
    const trigger = await screen.findByRole("button", { name: "Choose model and provider" });
    await waitFor(() => expect(trigger.hasAttribute("disabled")).toBe(false));
    failRefresh = true;
    fireEvent.click(trigger);
    await waitFor(() => expect(get.mock.calls.filter(([path]) => path.startsWith("/api/chat-providers"))).toHaveLength(2));
    await act(async () => undefined);
    if (savedOff) {
      expect(screen.getByText("Disabled in Settings")).not.toBeNull();
      expect(screen.queryByText("Owner model")).toBeNull();
    } else {
      expect(trigger.getAttribute("data-provider-instance")).toBe("pi_owner");
      expect(trigger.getAttribute("data-model")).toBe("model");
    }
  });

  it.each([true, false])("keeps same-runtime truth when projects change and revalidation fails (savedOff=%s)", async (savedOff) => {
    useBoard.setState({ projects: [] });
    const trusted = catalog("trusted_before_project_change", savedOff);
    let failRefresh = false;
    const get = vi.fn(async (path: string) => {
      if (!path.startsWith("/api/chat-providers")) return {};
      if (failRefresh) throw new Error("refresh_unavailable");
      return trusted;
    });
    window.operator = { invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(() => () => undefined) };
    render(<CanonicalChatWorkspace client={createCanonicalChatWorkspaceClient()}
      api={{ get } as unknown as ApiClient} projectId={null} active initialView="draft" />);
    const trigger = await screen.findByRole("button", { name: "Choose model and provider" });
    await waitFor(() => expect(trigger.hasAttribute("disabled")).toBe(false));
    failRefresh = true;
    act(() => useBoard.setState({ projects: [{ slug: "new-project", name: "New project" }] }));
    await waitFor(() => expect(get.mock.calls.filter(([path]) => path.startsWith("/api/chat-providers"))).toHaveLength(2));
    await act(async () => undefined);
    if (savedOff) {
      fireEvent.click(trigger);
      await screen.findByText("Disabled in Settings");
      expect(screen.queryByText("Owner model")).toBeNull();
    } else {
      expect(trigger.getAttribute("data-provider-instance")).toBe("pi_owner");
      expect(trigger.getAttribute("data-model")).toBe("model");
    }
  });

  it("discards inactive trusted snapshots before a new active read fails", async () => {
    const get = vi.fn().mockResolvedValueOnce(newCatalog).mockRejectedValue(new Error("reactivated_unavailable"));
    const api = { get };
    const view = render(<CatalogComposer api={api} />);
    await screen.findByText("after_update");
    view.rerender(<CatalogComposer api={api} active={false} />);
    openPicker();
    expect(get).toHaveBeenCalledTimes(1);
    view.rerender(<CatalogComposer api={api} />);
    await waitFor(() => expect(screen.getByTestId("catalog-status").textContent).toBe("error"));
    expect(screen.getByText("before_update")).not.toBeNull();
    expect(screen.getByTestId("availability").textContent).toBe("unavailable");
  });

  it("ignores old fallback-effect responses in both UI and the trusted error snapshot", async () => {
    const older = deferred<CanonicalProviderCatalog>();
    const newer = deferred<CanonicalProviderCatalog>();
    const get = vi.fn().mockResolvedValueOnce(oldCatalog).mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise).mockRejectedValue(new Error("current_refresh_failed"));
    const api = { get };
    const view = render(<CatalogComposer api={api} />);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    act(() => window.dispatchEvent(new Event("focus")));
    view.rerender(<CatalogComposer api={api} fallback={catalog("project_changed_fallback")} />);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(3));
    await act(async () => newer.resolve(newCatalog));
    await act(async () => older.resolve(oldCatalog));
    expect(screen.getByText("after_update")).not.toBeNull();
    openPicker();
    await waitFor(() => expect(screen.getByTestId("catalog-status").textContent).toBe("error"));
    expect(screen.getByText("after_update")).not.toBeNull();
    expect(screen.getByText("Disabled in Settings")).not.toBeNull();
  });

  it.each(["success", "error"] as const)("ignores an older %s after a newer catalog response", async (outcome) => {
    const older = deferred<CanonicalProviderCatalog>();
    const newer = deferred<CanonicalProviderCatalog>();
    const get = vi.fn().mockResolvedValueOnce(oldCatalog).mockImplementationOnce(() => older.promise).mockImplementationOnce(() => newer.promise);
    render(<CatalogComposer api={{ get }} />);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    act(() => window.dispatchEvent(new Event("focus")));
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(3));
    await act(async () => newer.resolve(newCatalog));
    expect(screen.getByText("after_update")).not.toBeNull();
    await act(async () => outcome === "success" ? older.resolve(oldCatalog) : older.reject(new Error("older_request_failed")));
    expect(screen.getByText("after_update")).not.toBeNull();
  });
});
