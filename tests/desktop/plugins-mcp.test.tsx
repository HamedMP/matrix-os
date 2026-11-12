// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServersSection } from "../../desktop/src/renderer/src/features/plugins";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useIntegrations } from "../../desktop/src/renderer/src/features/integrations/integrations-store";
import { createApiClient } from "../../desktop/src/renderer/src/lib/api";
import type { ApiClient } from "../../desktop/src/renderer/src/lib/api";

/** The section also reads the preset catalog and legacy connected apps; route those away from the server-list sequence. */
function routeServerList(api: ApiClient, ...lists: unknown[]) {
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === "/api/mcp-servers/catalog") return { presets: [] } as never;
    if (path !== "/api/mcp-servers") return [] as never;
    return (lists.length > 1 ? lists.shift() : lists[0]) as never;
  });
}

function makeApi() {
  return {
    baseUrl: "https://app.matrix-os.com",
    get: vi.fn(async (path: string) => path === "/api/mcp-servers/catalog" ? { presets: [] } : []),
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

  it("keeps the session and form values while unavailable, then recovers on retry", async () => {
    const onUnauthorized = vi.fn();
    const listResponses = [Response.json({ error: "custom_mcp_unavailable" }, { status: 503 }), Response.json([])];
    const fetchFn = vi.fn(async (input: unknown) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/api/mcp-servers/catalog")) return Response.json({ presets: [] });
      if (path.endsWith("/api/mcp-servers")) return listResponses.shift()!;
      return Response.json([]);
    });
    const api = createApiClient({ baseUrl: "https://app.matrix-os.com", getRuntimeSlot: () => "primary", fetchFn, onUnauthorized });
    useConnection.setState({ api });
    render(<McpServersSection />);
    fireEvent.change(screen.getByLabelText("MCP server name"), { target: { value: "Research" } });
    fireEvent.change(screen.getByLabelText("MCP server URL"), { target: { value: "https://example.com/mcp" } });
    expect((await screen.findByRole("alert")).textContent).toContain("MCP servers are currently unavailable.");
    expect(screen.getByRole("button", { name: "Add MCP server" }).matches(":disabled")).toBe(true);
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(useConnection.getState().status).toBe("signed-in");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect((screen.getByLabelText("MCP server name") as HTMLInputElement).value).toBe("Research");
    expect(screen.getByRole("button", { name: "Add MCP server" }).matches(":disabled")).toBe(false);
  });

  it("loads the platform-brokered list and renders the add flow", async () => {
    render(<McpServersSection />);
    expect(screen.getByRole("button", { name: "Add MCP server" })).not.toBeNull();
    expect(await screen.findByText("No connections yet")).not.toBeNull();
    await waitFor(() => expect(useConnection.getState().api!.get).toHaveBeenCalledWith("/api/mcp-servers"));
  });

  it("creates a remote HTTPS server without writing credentials locally", async () => {
    const api = useConnection.getState().api!;
    render(<McpServersSection />);
    fireEvent.change(screen.getByLabelText("MCP server name"), { target: { value: "Research" } });
    fireEvent.change(screen.getByLabelText("MCP server URL"), { target: { value: "https://mcp.acme.tools/mcp" } });
    fireEvent.change(screen.getByLabelText("Authentication mode"), { target: { value: "none" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Add MCP server" }).matches(":disabled")).toBe(false));
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
    routeServerList(api, [server]);
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
    routeServerList(api, [server], [authoritative]);
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

  it("persists a newer edit queued while a rebased retry fails", async () => {
    let releaseRetry!: () => void;
    const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
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
    routeServerList(api, [server], [authoritative]);
    vi.mocked(api.patch).mockImplementation(async (_path, body) => {
      const attempt = vi.mocked(api.patch).mock.calls.length;
      if (attempt === 1) throw new Error("revision conflict");
      if (attempt === 2) {
        await retryGate;
        throw new Error("temporary failure");
      }
      return { ...authoritative, ...(body as object), revision: 3 } as never;
    });
    useConnection.setState({ status: "signed-in", handle: "operator", api: api as never });
    render(<McpServersSection />);

    fireEvent.click((await screen.findAllByRole("checkbox"))[0]!);
    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByLabelText("search approval"), { target: { value: "allow" } });
    releaseRetry();

    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(3));
    expect(vi.mocked(api.patch).mock.calls[2]?.[1]).toMatchObject({
      revision: 2,
      tools: [{ name: "search", enabled: true, approval: "allow" }],
    });
  });
});

describe("desktop MCP inventory account isolation", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  function accountApi(label: string, gate?: Promise<void>) {
    const api = makeApi();
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === "/api/mcp-servers/catalog") return { presets: [] } as never;
      if (path === "/api/integrations/available") return [{ id: "gmail", name: "Gmail", category: "google" }] as never;
      if (path === "/api/integrations") {
        await gate;
        return [{ id: `conn-${label}`, service: "gmail", account_label: label, status: "active" }] as never;
      }
      return [] as never;
    });
    return api;
  }

  // Fault: after an account switch the previous account's connected apps stay visible.
  it("reloads legacy connected apps for the new account and hides the old account's rows meanwhile", async () => {
    useConnection.setState({ status: "signed-in", handle: "alice", api: accountApi("Alice work") as never });
    render(<McpServersSection />);
    expect(await screen.findByText(/Alice work/)).not.toBeNull();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    act(() => { useConnection.setState({ handle: "bob", api: accountApi("Bob work", gate) as never }); });
    await waitFor(() => expect(screen.queryByText(/Alice work/)).toBeNull());
    release();
    expect(await screen.findByText(/Bob work/)).not.toBeNull();
    expect(screen.queryByText(/Alice work/)).toBeNull();
  });
});

describe("desktop MCP inventory with competing connected-app loads", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  // Fault: another store consumer replaces this view's load, and the apps stay hidden after it succeeds.
  it("shows connected apps once a competing refresh for the same account succeeds", async () => {
    const gates: Array<() => void> = [];
    const api = makeApi();
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === "/api/mcp-servers/catalog") return { presets: [] } as never;
      if (path === "/api/integrations/available") return [{ id: "gmail", name: "Gmail", category: "google" }] as never;
      if (path === "/api/integrations") {
        await new Promise<void>((resolve) => { gates.push(resolve); });
        return [{ id: "conn-1", service: "gmail", account_label: "Carol work", status: "active" }] as never;
      }
      return [] as never;
    });
    useConnection.setState({ status: "signed-in", handle: "carol", api: api as never });
    render(<McpServersSection />);
    await waitFor(() => expect(gates).toHaveLength(1));
    // e.g. useOnboardingAppConnect refreshes the shared store while this view's load is in flight.
    let competing!: Promise<void>;
    act(() => { competing = useIntegrations.getState().refresh(api); });
    await waitFor(() => expect(gates).toHaveLength(2));
    await act(async () => { gates[0]!(); });
    await act(async () => { gates[1]!(); await competing; });
    expect(await screen.findByText(/Carol work/)).not.toBeNull();
  });
});
