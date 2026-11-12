// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CustomMcpServersPanel } from "../../shell/src/components/settings/sections/CustomMcpServersPanel";
import { McpServersSection } from "../../desktop/src/renderer/src/features/plugins/McpServersSection";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { createApiClient } from "../../desktop/src/renderer/src/lib/api";

const linear = { id: "linear", name: "Linear", description: "Manage issues", category: "project_management", departments: ["engineering"], url: "https://mcp.linear.app/mcp", auth: "oauth_dcr", demandRank: 9 };
const created = { id: "6bc45f4b-cf18-43ac-a424-c199a43511f4", name: "Linear", url: linear.url, authMode: "oauth", status: "auth_required", enabled: false, revision: 2, tools: [] };
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// Web Canvas and Web Desktop render the shell panel; Electron Desktop renders its section. Both use the shared picker.
for (const [surface, Component] of [["Web", CustomMcpServersPanel], ["Electron", McpServersSection]] as const) {
  describe(`${surface} MCP preset connect`, () => {
    function setup(connect: () => Response) {
      const requests: Array<{ method: string; path: string; body?: unknown }> = [];
      let servers: unknown[] = [];
      const fetchFn = vi.fn(async (input: unknown, init?: RequestInit) => {
        const path = new URL(String(input), "https://app.matrix-os.com").pathname;
        const method = init?.method ?? "GET";
        requests.push({ method, path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
        if (path.endsWith("/api/mcp-servers/catalog")) return Response.json({ presets: [linear] });
        if (path.endsWith("/api/mcp-servers") && method === "POST") { servers = [created]; return Response.json(created, { status: 201 }); }
        if (path.endsWith("/connect")) return connect();
        if (path.endsWith("/api/mcp-servers")) return Response.json(servers);
        return Response.json([]);
      });
      if (surface === "Web") vi.spyOn(globalThis, "fetch").mockImplementation(fetchFn as typeof fetch);
      else useConnection.setState({ status: "signed-in", handle: "operator", api: createApiClient({ baseUrl: "https://app.matrix-os.com", getRuntimeSlot: () => "primary", fetchFn: fetchFn as typeof fetch, onUnauthorized: vi.fn() }) });
      const open = vi.spyOn(window, "open").mockImplementation(() => null);
      render(<Component />);
      return { requests, open };
    }

    // Fault: a preset connect sends a client-chosen URL or never opens the vendor sign-in.
    it("creates from the catalog id and opens the vendor sign-in", async () => {
      const { requests, open } = setup(() => Response.json({ url: "https://mcp.linear.app/authorize?state=s" }));
      fireEvent.click(await screen.findByRole("button", { name: "Connect Linear" }));
      await waitFor(() => expect(open).toHaveBeenCalledWith("https://mcp.linear.app/authorize?state=s", "_blank", expect.stringContaining("noopener")));
      expect(requests.find(request => request.method === "POST" && request.path.endsWith("/api/mcp-servers"))?.body).toEqual({ catalogId: "linear" });
      expect(await screen.findByText("Connected")).toBeTruthy();
    });

    // Fault: a raw server or provider error string reaches the Settings UI.
    it("shows allowlisted copy when the vendor app needs administrator setup", async () => {
      setup(() => Response.json({ error: "Slack app review pending at api.slack.com", code: "oauth_client_setup_required" }, { status: 409 }));
      fireEvent.click(await screen.findByRole("button", { name: "Connect Linear" }));
      expect((await screen.findByRole("alert")).textContent).toBe("This service needs administrator setup before you can sign in.");
    });
  });
}
