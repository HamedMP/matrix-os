// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CustomMcpServersPanel } from "../../shell/src/components/settings/sections/CustomMcpServersPanel";
import { McpServersSection } from "../../desktop/src/renderer/src/features/plugins/McpServersSection";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { createApiClient } from "../../desktop/src/renderer/src/lib/api";

const server = { id: "test-server", name: "Research", url: "https://example.com/mcp", authMode: "none", status: "disabled", enabled: false, revision: 1, tools: [] };
const tool = { name: "search", description: "Search documents", inputSchema: {}, enabled: false, approval: "always_ask" };
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

for (const [surface, Component] of [["Web", CustomMcpServersPanel], ["Electron", McpServersSection]] as const) {
  describe(`${surface} MCP action feedback`, () => {
    function setup(respond: () => Promise<Response>, initialTools: typeof tool[] = []) {
      let tools: typeof tool[] = initialTools;
      const fetchFn = vi.fn(async (_input: unknown, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          const patch = JSON.parse(String(init.body));
          tools = patch.tools.map((selection: typeof tool) => ({ ...tool, ...selection }));
          return Response.json({ ...server, ...patch, tools, revision: 2 });
        }
        if (init?.method === "POST") {
          const result = await respond();
          if (result.ok) { const body = await result.clone().json(); if (Array.isArray(body.tools)) tools = body.tools; }
          return result;
        }
        return Response.json([{ ...server, tools }]);
      });
      vi.spyOn(globalThis, "fetch").mockImplementation(fetchFn);
      useConnection.setState({ api: createApiClient({ baseUrl: "https://example.com", getRuntimeSlot: () => "primary", fetchFn }) });
      render(<Component />);
      return fetchFn;
    }

    it("shows pending discovery, prevents duplicate actions, then explains the result", async () => {
      let resolve!: (response: Response) => void;
      const fetchFn = setup(() => new Promise<Response>(r => { resolve = r; }));
      fireEvent.click(await screen.findByRole("button", { name: "Discover", exact: true }));
      expect(screen.getByRole("button", { name: "Discovering…" }).matches(":disabled")).toBe(true);
      expect(screen.getByRole("button", { name: "Test", exact: true }).matches(":disabled")).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "Discovering…" }));
      expect(fetchFn.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
      resolve(Response.json({ ...server, enabled: true, status: "ready", tools: [{ ...tool, enabled: true }] }));
      expect(await screen.findByText("Found 1 tool. New tools are enabled by default; review permissions below.")).not.toBeNull();
      expect(await screen.findByRole("checkbox")).not.toBeNull();
      expect(screen.getByLabelText("search approval").matches(":disabled")).toBe(false);
      expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    });

    it("saves permission choices for unchecked tools without enabling them", async () => {
      const fetchFn = setup(async () => Response.json({ ok: true }), [tool]);
      const select = await screen.findByLabelText("search approval");
      expect(select.matches(":disabled")).toBe(false);
      fireEvent.change(select, { target: { value: "allow" } });
      await waitFor(() => expect(fetchFn.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
      const patch = fetchFn.mock.calls.find(([, init]) => init?.method === "PATCH")![1]!;
      expect(JSON.parse(String(patch.body))).toMatchObject({ enabled: false, tools: [{ name: "search", enabled: false, approval: "allow" }] });
      expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
      expect((select as HTMLSelectElement).value).toBe("allow");
      expect(screen.getByRole("button", { name: "Enable" }).matches(":disabled")).toBe(true);
    });

    it("shows successful Test without pretending to execute a tool or discover it", async () => {
      setup(async () => Response.json({ ok: true, tools: 3 }));
      fireEvent.click(await screen.findByRole("button", { name: "Test", exact: true }));
      expect(await screen.findByText("Connection successful. 3 tools available. No tools were executed.")).not.toBeNull();
      expect(screen.queryByRole("checkbox")).toBeNull();
    });

    it("shows Testing while waiting and rejects malformed success responses", async () => {
      let resolve!: (response: Response) => void;
      setup(() => new Promise<Response>(r => { resolve = r; }));
      fireEvent.click(await screen.findByRole("button", { name: "Test", exact: true }));
      expect(screen.getByRole("button", { name: "Testing…" }).matches(":disabled")).toBe(true);
      expect(screen.getByRole("button", { name: "Discover", exact: true }).matches(":disabled")).toBe(true);
      resolve(Response.json({ ok: true, tools: "private upstream output" }));
      expect((await screen.findByRole("alert")).textContent).toContain("Connection test failed.");
      expect(screen.queryByText(/private upstream output/)).toBeNull();
    });

    it("explains an empty catalog", async () => {
      setup(async () => Response.json({ ...server, tools: [] }));
      fireEvent.click(await screen.findByRole("button", { name: "Discover", exact: true }));
      expect(await screen.findByText("Connected, but this server returned no tools. Check the server URL or try Discover again.")).not.toBeNull();
    });

    it("shows a safe action-specific error and recovers on retry", async () => {
      let fail = true;
      setup(async () => fail ? Response.json({ error: "private database token" }, { status: 502 }) : Response.json({ ok: true, tools: 0 }));
      fireEvent.click(await screen.findByRole("button", { name: "Test", exact: true }));
      expect((await screen.findByRole("alert")).textContent).toBe("Connection test failed. Check the server URL and authentication, then retry.");
      expect(screen.queryByText(/private database token/)).toBeNull();
      fail = false;
      fireEvent.click(screen.getByRole("button", { name: "Test", exact: true }));
      expect(await screen.findByText("Connection successful, but the server returned no tools. No tools were executed.")).not.toBeNull();
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    });
  });
}
