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
});
