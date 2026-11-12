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
    function setup(connect: () => Response, initialServers: unknown[] = [], patch: () => Response = () => Response.json({ error: "Revision conflict" }, { status: 500 })) {
      const requests: Array<{ method: string; path: string; body?: unknown }> = [];
      let servers: unknown[] = initialServers;
      const fetchFn = vi.fn(async (input: unknown, init?: RequestInit) => {
        const path = new URL(String(input), "https://app.matrix-os.com").pathname;
        const method = init?.method ?? "GET";
        requests.push({ method, path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
        if (path.endsWith("/api/mcp-servers/catalog")) return Response.json({ presets: [linear] });
        if (path.endsWith("/api/mcp-servers") && method === "POST") { servers = [created]; return Response.json(created, { status: 201 }); }
        if (path.endsWith("/connect")) return connect();
        if (method === "PATCH") return patch();
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
      // The saved server still needs OAuth, so the preset must not claim it is connected.
      expect(await screen.findByRole("button", { name: "Finish sign-in for Linear" })).toBeTruthy();
      expect(screen.queryByText("Connected")).toBeNull();
    });

    // Fault: one failed operation hides every saved connection and its controls.
    it("keeps rows, controls, and unsaved tool choices visible after authorize and policy failures", async () => {
      const withTool = { ...created, tools: [{ name: "list_issues", description: "List issues", inputSchema: {}, approval: "always_ask", enabled: false }] };
      setup(() => Response.json({ error: "upstream" }, { status: 502 }), [withTool]);
      fireEvent.click(await screen.findByRole("button", { name: "Authorize" }));
      expect((await screen.findByRole("alert")).textContent).toBe("The MCP request failed. Try again.");
      expect(screen.getByRole("button", { name: "Authorize" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
      const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
      fireEvent.click(checkbox);
      await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("policy could not be saved"));
      expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
      expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
    });

    // Fault: a raw server or provider error string reaches the Settings UI.
    it("shows allowlisted copy when the vendor app needs administrator setup", async () => {
      setup(() => Response.json({ error: "Slack app review pending at api.slack.com", code: "oauth_client_setup_required" }, { status: 409 }));
      fireEvent.click(await screen.findByRole("button", { name: "Connect Linear" }));
      expect((await screen.findByRole("alert")).textContent).toBe("This service needs administrator setup before you can sign in.");
    });
  });
}
