// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServersSection } from "../../desktop/src/renderer/src/features/plugins";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import type { ApiClient } from "../../desktop/src/renderer/src/lib/api";

function makeApi() {
  return {
    baseUrl: "https://app.matrix-os.com",
    get: vi.fn(async () => []),
    post: vi.fn(async () => ({
      id: "6bc45f4b-cf18-43ac-a424-c199a43511f4",
      name: "Research",
      url: "https://mcp.acme.tools/mcp",
      authMode: "none",
      status: "disabled",
      enabled: false,
      revision: 2,
      tools: [],
    })),
    delete: vi.fn(async () => ({ ok: true })),
    patch: vi.fn(), put: vi.fn(), putText: vi.fn(), getText: vi.fn(), getBlob: vi.fn(),
  } as unknown as ApiClient;
}

describe("desktop Custom MCP management", () => {
  beforeEach(() => {
    const api = makeApi();
    useConnection.setState({ status: "signed-in", handle: "operator", api: api as never });
    vi.spyOn(window, "open").mockImplementation(() => null);
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("loads the platform-brokered list and renders the add flow", async () => {
    render(<McpServersSection />);
    expect(screen.getByRole("button", { name: "Add MCP server" })).not.toBeNull();
    expect(screen.getByText("No personal MCP servers yet")).not.toBeNull();
    await waitFor(() => expect(useConnection.getState().api!.get).toHaveBeenCalledWith("/api/mcp-servers"));
  });

  it("creates a remote HTTPS server without writing credentials locally", async () => {
    const api = useConnection.getState().api!;
    render(<McpServersSection />);
    fireEvent.change(screen.getByLabelText("MCP server name"), { target: { value: "Research" } });
    fireEvent.change(screen.getByLabelText("MCP server URL"), { target: { value: "https://mcp.acme.tools/mcp" } });
    fireEvent.change(screen.getByLabelText("Authentication mode"), { target: { value: "none" } });
    fireEvent.click(screen.getByRole("button", { name: "Add MCP server" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/mcp-servers", {
      name: "Research",
      url: "https://mcp.acme.tools/mcp",
      authMode: "none",
    }));
  });

  it("fails closed when no Matrix computer is connected", () => {
    useConnection.setState({ api: null as never });
    render(<McpServersSection />);
    expect(screen.getByText("Connect a Matrix computer to manage MCP servers.")).not.toBeNull();
    expect((screen.getByRole("button", { name: "Add MCP server" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("serializes rapid tool edits onto the latest optimistic revision", async () => {
    let releaseFirstPatch!: () => void;
    const firstPatchGate = new Promise<void>((resolve) => { releaseFirstPatch = resolve; });
    let revision = 1;
    const server = {
      id: "6bc45f4b-cf18-43ac-a424-c199a43511f4",
      name: "Research",
      url: "https://mcp.acme.tools/mcp",
      authMode: "none" as const,
      status: "disabled",
      enabled: false,
      revision,
      tools: [
        { name: "search", description: "", inputSchema: {}, approval: "always_ask" as const, enabled: false },
        { name: "summarize", description: "", inputSchema: {}, approval: "always_ask" as const, enabled: false },
      ],
    };
    const api = makeApi();
    vi.mocked(api.get).mockResolvedValue([server] as never);
    vi.mocked(api.patch).mockImplementation(async (_path, body) => {
      if (revision === 1) await firstPatchGate;
      revision += 1;
      return { ...server, ...(body as object), revision } as never;
    });
    useConnection.setState({ status: "signed-in", handle: "operator", api: api as never });
    render(<McpServersSection />);
    const checkboxes = await screen.findAllByRole("checkbox");

    fireEvent.click(checkboxes[0]!);
    fireEvent.click(checkboxes[1]!);
    releaseFirstPatch();

    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.patch).mock.calls[1]?.[1]).toMatchObject({
      revision: 2,
      tools: [
        { name: "search", enabled: true },
        { name: "summarize", enabled: true },
      ],
    });
  });

  it("rebases local policy edits after a revision conflict and retries once", async () => {
    const server = {
      id: "6bc45f4b-cf18-43ac-a424-c199a43511f4",
      name: "Research",
      url: "https://mcp.acme.tools/mcp",
      authMode: "none" as const,
      status: "disabled",
      enabled: false,
      revision: 1,
      tools: [{ name: "search", description: "", inputSchema: {}, approval: "always_ask" as const, enabled: false }],
    };
    const authoritative = { ...server, revision: 2 };
    const api = makeApi();
    vi.mocked(api.get)
      .mockResolvedValueOnce([server] as never)
      .mockResolvedValueOnce([authoritative] as never);
    vi.mocked(api.patch)
      .mockRejectedValueOnce(new Error("revision conflict"))
      .mockImplementationOnce(async (_path, body) => ({ ...authoritative, ...(body as object), revision: 3 }) as never);
    useConnection.setState({ status: "signed-in", handle: "operator", api: api as never });
    render(<McpServersSection />);

    fireEvent.click((await screen.findAllByRole("checkbox"))[0]!);

    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.patch).mock.calls[1]?.[1]).toMatchObject({
      revision: 2,
      tools: [{ name: "search", enabled: true, approval: "always_ask" }],
    });
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
