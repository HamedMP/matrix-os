// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopOrganizationDrivesView } from "../../desktop/src/renderer/src/features/files/DesktopOrganizationDrivesView";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";

const { createApi } = vi.hoisted(() => ({ createApi: vi.fn() }));
vi.mock("../../desktop/src/renderer/src/lib/collaboration", () => ({
  createDesktopCollaborationApi: createApi,
  releaseDesktopCollaborationApi: (api: { direct: { close: () => void } }) => api.direct.close(),
  closeDesktopCollaborationSessions: vi.fn(),
}));

afterEach(() => { cleanup(); createApi.mockReset(); });

describe("Electron organization drive view", () => {
  it("creates a fresh direct client after StrictMode cleanup", async () => {
    const clients: Array<{ close: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> }> = [];
    createApi.mockImplementation(() => {
      const api = {
        get: vi.fn(async (path: string) => path === "/api/organizations"
          ? { organizations: [] } : { items: [] }),
        direct: { close: vi.fn(), request: vi.fn() },
      };
      clients.push({ close: api.direct.close, get: api.get });
      return api;
    });
    useConnection.setState({ platformHost: "https://app.matrix-os.com", runtimeSlot: "primary", authGeneration: 3 });
    render(<React.StrictMode><DesktopOrganizationDrivesView /></React.StrictMode>);
    expect(await screen.findByText("Share a folder with your organization to make a drive available here.")).toBeTruthy();
    await waitFor(() => expect(clients.length).toBeGreaterThanOrEqual(2));
    expect(clients[0]!.close).toHaveBeenCalled();
    expect(clients.at(-1)!.close).not.toHaveBeenCalled();
    expect(clients.at(-1)!.get).toHaveBeenCalledWith("/api/organizations");
  });

  it("stops its live subscription while the retained pane is hidden", async () => {
    const scopeId = "00000000-0000-4000-8000-000000000001";
    const organizationId = "org_example";
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => unsubscribe);
    const direct = { close: vi.fn(), subscribe, request: vi.fn(async (_scope: string, _method: string, path: string) => {
      if (path.endsWith(`/scopes/${scopeId}`)) return { id: scopeId, ownerId: "user_owner", kind: "folder",
        resourceId: "folder_example", organizationId, membershipMode: "direct", lifecycle: "shared",
        revision: "1", authEpoch: "1", authorityGeneration: "1", role: "viewer",
        capabilities: { read: true, discuss: false, manageMembers: false, requestAi: false } };
      return { organizationId, scopeId, usedBytes: 0, reservedBytes: 0,
        quotaBytes: 1_000_000_000_000, files: [] };
    }) };
    createApi.mockReturnValue({
      get: vi.fn(async (path: string) => path === "/api/organizations"
        ? { organizations: [{ organizationId, name: "Authority" }] }
        : { items: path.startsWith("/api/collaboration/shared") ? [{ scopeId,
          runtimeId: "runtime_owner", ownerId: "user_owner", kind: "folder",
          authorityGeneration: 1, organizationId, status: "accepted" }] : [] }),
      direct,
      subscribe,
    });
    useConnection.setState({ platformHost: "https://app.matrix-os.com", runtimeSlot: "primary", authGeneration: 3 });
    const view = render(<DesktopOrganizationDrivesView isActive />);
    await waitFor(() => expect(subscribe).toHaveBeenCalled());
    view.rerender(<DesktopOrganizationDrivesView isActive={false} />);
    await waitFor(() => expect(unsubscribe).toHaveBeenCalled());
    expect(direct.close).not.toHaveBeenCalledWith(scopeId);
  });
  it("does not open an unrelated drive when the requested shortcut is unavailable", async () => {
    createApi.mockImplementation(() => ({get: vi.fn(async path => path === "/api/organizations" ? {organizations: []} : {items: []}), direct: {close: vi.fn(), request: vi.fn()}}));
    useConnection.setState({platformHost:"https://app.matrix-os.com",runtimeSlot:"primary",authGeneration:3});
    render(<DesktopOrganizationDrivesView requestedScopeId="00000000-0000-4000-8000-0000000000ff" requestedIntentId="new-request"/>);
    expect(await screen.findByText("This drive is unavailable. Choose another drive or refresh.")).toBeTruthy();
    expect(screen.queryByRole("button",{name:"Upload file"})).toBeNull();
  });

});
