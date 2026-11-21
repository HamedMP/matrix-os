// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { buildAuthenticatedWebSocketUrl } = vi.hoisted(() => ({
  buildAuthenticatedWebSocketUrl: vi.fn<() => Promise<string>>(),
}));

vi.mock("@/lib/websocket-auth", () => ({
  buildAuthenticatedWebSocketUrl,
}));

vi.mock("@/lib/gateway", async (importOriginal) => {
  const gateway = await importOriginal<typeof import("@/lib/gateway")>();
  return {
    ...gateway,
    getGatewayUrl: () => window.location.pathname.startsWith("/vm/") ? gateway.getGatewayUrl() : "http://gateway.test",
    getGatewayWs: () => "ws://gateway.test/ws",
  };
});

import * as providerTransport from "../../shell/src/lib/provider-settings-transport.js";
import { IntegrationsSection } from "../../shell/src/components/settings/sections/IntegrationsSection.js";
import { GithubDeveloperIntegration } from "../../shell/src/components/settings/sections/GithubDeveloperIntegration.js";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("IntegrationsSection websocket lifecycle", () => {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/integrations/available")) {
      return Promise.resolve({ ok: true, json: async () => ({ services: [] }) });
    }
    if (url.includes("/api/integrations")) {
      return Promise.resolve({ ok: true, json: async () => ({ connections: [] }) });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  });

  beforeEach(() => {
    fetchMock.mockClear();
    buildAuthenticatedWebSocketUrl.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("does not open a websocket after unmount when the authenticated URL resolves late", async () => {
    const deferred = createDeferred<string>();
    const webSocketCtor = vi.fn(function WebSocketMock(this: { close: ReturnType<typeof vi.fn> }) {
      this.close = vi.fn();
    });
    buildAuthenticatedWebSocketUrl.mockReturnValueOnce(deferred.promise);
    vi.stubGlobal("WebSocket", webSocketCtor as unknown as typeof WebSocket);

    const { unmount } = render(<IntegrationsSection />);

    await act(async () => {
      await Promise.resolve();
    });

    unmount();

    await act(async () => {
      deferred.resolve("ws://gateway.test/ws?token=late");
      await deferred.promise;
      await Promise.resolve();
    });

    expect(webSocketCtor).not.toHaveBeenCalled();
  });
});


describe("Connect Apps partial loading", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  it("explains unavailable app connections while MCP discovery and owner approvals remain usable", async () => {
    buildAuthenticatedWebSocketUrl.mockReturnValue(new Promise(() => {}));
    let available = false;
    const saved = { id: "first", service: "gmail", account_label: "First", account_email: "first@example.test", status: "active", connected_at: "2026-11-12T00:00:00.000Z" };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/integrations/available") || url.endsWith("/api/integrations")) {
        if (available) return Response.json(url.endsWith("/available") ? { services: [] } : { connections: [saved] });
        return Response.json({ error: "integrations_unavailable" }, { status: 503 });
      }
      if (url.endsWith("/api/integrations/sync")) return Response.json({ services: [saved, { ...saved, id: "second", account_label: "Second", account_email: "second@example.test" }] });
      if (url.endsWith("/api/mcp-servers/catalog")) return Response.json({ presets: [{
        id: "context7", name: "Context7", url: "https://mcp.context7.com/mcp", auth: "none",
        category: "developer", departments: ["engineering"], description: "Library documentation",
      }] });
      if (url.endsWith("/api/mcp-servers")) return Response.json([]);
      if (url.endsWith("/external-approvals")) return Response.json({ approvals: [] });
      return Response.json({});
    }));
    render(<IntegrationsSection />);
    expect(await screen.findByText("Some app connections are unavailable. You can still connect MCP servers and review external approvals below.")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Connect Context7" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Check again" })).toBeTruthy();
    expect(screen.queryByText("Failed to load integrations")).toBeNull();
    available = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh", exact: true }));
    await waitFor(() => expect(screen.queryByText("Some app connections are unavailable. You can still connect MCP servers and review external approvals below.")).toBeNull());
    expect(await screen.findByText("second@example.test")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect Context7" })).toBeTruthy();
  });
  it.each([true, false])("distinguishes a signed preview restriction from an ordinary forbidden response (known=%s)", async (known) => {
    buildAuthenticatedWebSocketUrl.mockReturnValue(new Promise(() => {}));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/integrations/available")) return Response.json({ error: "integrations_unavailable" }, { status: 503 });
      if (url.endsWith("/api/integrations")) return Response.json({ error: "Forbidden", ...(known ? { code: "preview_integrations_unavailable" } : {}) }, { status: 403 });
      if (url.endsWith("/api/mcp-servers/catalog")) return Response.json({ presets: [{ id: "context7", name: "Context7", url: "https://mcp.context7.com/mcp", auth: "none", category: "developer", departments: ["engineering"], description: "Library documentation" }] });
      if (url.endsWith("/api/mcp-servers")) return Response.json([]);
      if (url.endsWith("/external-approvals")) return Response.json({ approvals: [] });
      return Response.json({});
    }));
    render(<IntegrationsSection />);
    expect(await screen.findByRole("button", { name: "Connect Context7" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Check again" })).toBeTruthy();
    const notice = "App connections are unavailable on this preview computer. You can still connect MCP servers and review external approvals below.";
    if (known) {
      expect(await screen.findByText(notice)).toBeTruthy();
      expect(screen.queryByText("Failed to load integrations")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Refresh", exact: true }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Refresh", exact: true }).hasAttribute("disabled")).toBe(false));
      expect(screen.queryByText("Failed to load integrations")).toBeNull();
    } else {
      expect(await screen.findByText("Failed to load integrations")).toBeTruthy();
      expect(screen.queryByText(notice)).toBeNull();
    }
  });
  it.each(["http", "network", "json"])("keeps accounts removable when the catalog fails with %s", async (failure) => {
    buildAuthenticatedWebSocketUrl.mockReturnValue(new Promise(() => {}));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/available")) {
        if (failure === "network") throw new Error("Network unavailable");
        return { ok: failure !== "http", json: async () => { throw new Error("Invalid JSON"); } };
      }
      return { ok: true, json: async () => [{ id: "saved", service: "gmail", account_label: "Work", account_email: "work@example.test", status: "active", scopes: [] }] };
    }));
    render(<IntegrationsSection />);
    expect(await screen.findByText("work@example.test")).toBeTruthy();
    expect(screen.getByText("Failed to load integrations")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByRole("button", { name: "Confirm" })).toBeTruthy();
  });
  it("keeps the usable catalog when loading accounts fails", async () => {
    buildAuthenticatedWebSocketUrl.mockReturnValue(new Promise(() => {}));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/available")) return { ok: true, json: async () => [{ id: "asana", name: "Asana", category: "productivity", authType: "oauth" }] };
      throw new Error("Accounts unavailable");
    }));
    render(<IntegrationsSection />);
    expect(await screen.findByRole("button", { name: "Connect Asana" })).toBeTruthy();
    expect(screen.getByText("Failed to load integrations")).toBeTruthy();
  });
});

describe("Connect Apps consent window", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  function prepare() {
    buildAuthenticatedWebSocketUrl.mockReturnValue(new Promise(() => {}));
    const connectResponse = createDeferred<Response>();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/connect")) return connectResponse.promise;
      if (url.endsWith("/available")) return Promise.resolve({ ok: true, json: async () => [{ id: "asana", name: "Asana", category: "productivity", authType: "oauth" }] });
      if (url.endsWith("/sync")) return Promise.resolve({ ok: true, json: async () => ({ services: [] }) });
      return Promise.resolve({ ok: true, json: async () => [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    return { fetchMock, connectResponse };
  }
  it("opens consent synchronously and navigates it after the authenticated request", async () => {
    const { connectResponse } = prepare();
    const popup = { location: { href: "about:blank" }, opener: {}, close: vi.fn() };
    const open = vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    render(<IntegrationsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect Asana" }));
    expect(open).toHaveBeenCalledWith("about:blank", "_blank", "width=600,height=700");
    expect(popup.location.href).toBe("about:blank");
    connectResponse.resolve({ ok: true, json: async () => ({ url: "https://pipedream.com/connect/test" }) } as Response);
    await waitFor(() => expect(popup.location.href).toBe("https://pipedream.com/connect/test"));
    expect(popup.opener).toBeNull();
  });
  it("reports a blocked popup and allows retry without issuing a connect token", async () => {
    const { fetchMock } = prepare();
    vi.spyOn(window, "open").mockReturnValue(null);
    render(<IntegrationsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect Asana" }));
    expect(await screen.findByText("Could not open sign-in. Allow popups and try again.")).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/connect"))).toBe(false);
    expect((screen.getByRole("button", { name: "Connect Asana" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("Connect Apps GitHub Developer entry", () => {
  afterEach(() => {
    cleanup();
    window.history.replaceState({}, "", "/");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(["/vm/alice?runtime=studio", "/"])("only cleans up a switched setup when its original Computer route is explicit (%s)", async (initialPath) => {
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
    window.history.replaceState({}, "", initialPath);
    vi.spyOn(providerTransport, "createProviderSettingsTransport").mockReturnValue({
      getSnapshot: vi.fn().mockResolvedValue({ access: { mode: "writable" } }),
    } as never);
    const setupId = "016d31b0-50d7-4dca-ae0d-b6083bdcd219";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input).endsWith("/api/github/setup")) {
        return Response.json({ id: setupId, state: "awaiting_authorization", deviceCode: "ABCD-EFGH" });
      }
      if (String(input).endsWith("/api/github/status")) {
        return Response.json({ installed: true, authenticated: false, ready: false });
      }
      return Response.json({ id: setupId, state: "cancelled" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const card = () => <GithubDeveloperIntegration active>{({ action }) => action ? (
      <button disabled={action.disabled} onClick={action.onClick}>{action.text}</button>
    ) : null}</GithubDeveloperIntegration>;
    const view = render(card());
    const connect = await screen.findByRole("button", { name: "Connect" });
    await waitFor(() => expect(connect).toHaveProperty("disabled", false));
    fireEvent.click(connect);
    expect(await screen.findByText("ABCD-EFGH")).toBeTruthy();

    window.history.replaceState({}, "", "/vm/alice?runtime=primary");
    await act(async () => { view.rerender(card()); });
    expect(screen.queryByText("ABCD-EFGH")).toBeNull();
    const cancellations = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/cancel"));
    expect(cancellations.map(([url, init]) => [url, init?.method])).toEqual(initialPath.startsWith("/vm/")
      ? [[`${window.location.origin}/vm/alice/~runtime/studio/api/github/setup/${setupId}/cancel`, "POST"]]
      : []);
  });

  it("connects the selected computer in Settings and preserves Terminal disconnect", async () => {
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
    HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
    window.history.replaceState({}, "", "/vm/alice?runtime=studio");
    buildAuthenticatedWebSocketUrl.mockReturnValue(new Promise(() => {}));
    vi.spyOn(providerTransport, "createProviderSettingsTransport").mockReturnValue({
      getSnapshot: vi.fn().mockResolvedValue({ access: { mode: "writable" } }),
    } as never);
    let ready = false;
    const setupId = "016d31b0-50d7-4dca-ae0d-b6083bdcd219";
    const workspaceId = `tws_${"a".repeat(32)}`;
    const tabId = `tt_${"b".repeat(32)}`;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input).endsWith("/api/github/setup")) {
        return Response.json({ id: setupId, state: "awaiting_authorization", deviceCode: "ABCD-EFGH" });
      }
      if (String(input).endsWith(`/api/github/setup/${setupId}`)) {
        ready = true;
        return Response.json({ id: setupId, state: "succeeded" });
      }
      if (String(input).endsWith("/api/github/status")) {
        return Response.json({
          installed: true, authenticated: ready, user: ready ? "octocat" : null,
          gitProtocol: ready ? "ssh" : null, sshStatus: ready ? "verified" : "setup_required",
          commitIdentity: { status: ready ? "ready" : "missing", label: ready ? "Octocat" : null },
          ready,
        });
      }
      if (String(input).endsWith("/api/integrations/available")) {
        return Response.json({ services: [
          ...["a", "b"].map(id => ({ id, name: id, category: "developer" })),
          { id: "github", name: "GitHub", category: "developer" },
          { id: "c", name: "c", category: "developer" },
        ] });
      }
      if (String(input).endsWith("/api/integrations")) return Response.json({ connections: [] });
      if (String(input).endsWith("/api/terminal/workspaces/ensure")) return Response.json({ workspace: { id: workspaceId } });
      if (String(input).endsWith(`/api/terminal/workspaces/${workspaceId}/tabs`)) return Response.json({ tab: { id: tabId } });
      return new Response(null, { status: 503 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const disconnect = vi.fn();
    const terminalCallbacks = { onOpenGithubDisconnectTerminal: disconnect };
    const view = render(<IntegrationsSection {...terminalCallbacks} />);
    const connect = await screen.findByRole("button", { name: "Connect GitHub Developer", exact: true });
    await waitFor(() => expect((connect as HTMLButtonElement).disabled).toBe(false));
    const github = await screen.findByTestId("integration-card-github");
    const developer = screen.getByTestId("integration-card-github-developer");
    expect(github.nextElementSibling).toBe(developer);
    expect(developer.className).toBe(github.className);
    expect(connect.className).toBe(screen.getByRole("button", { name: "Connect GitHub", exact: true }).className);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/vm\/alice\/~runtime\/studio\/api\/github\/status$/),
      expect.objectContaining({ cache: "no-store" }),
    );
    fireEvent.click(connect);
    const setupDialog = within(await screen.findByRole("dialog", { name: "Connect GitHub Developer" }));
    expect(await setupDialog.findByText("ABCD-EFGH")).toBeTruthy();
    fireEvent.click(setupDialog.getByRole("button", { name: "Open GitHub" }));
    expect(open).toHaveBeenCalledExactlyOnceWith("https://github.com/login/device", "_blank", "noopener,noreferrer");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/vm\/alice\/~runtime\/studio\/api\/github\/setup$/),
      expect.objectContaining({ method: "POST", body: "{}", cache: "no-store" }),
    );
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringMatching(/integrations\/connect$/), expect.anything());
    expect(await screen.findByText("Ready", {}, { timeout: 3_000 })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`/vm/alice/~runtime/studio/api/github/setup/${setupId}`),
      expect.objectContaining({ method: "GET", cache: "no-store" }),
    );
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/terminal"))).toBe(false);
    expect(screen.queryByRole("button", { name: "Connect GitHub Developer", exact: true })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Connected (1)" }));
    expect(screen.getByTestId("integration-card-github-developer")).toBeTruthy();
    expect(screen.queryByTestId("integration-card-github")).toBeNull();

    const disconnectButton = await screen.findByRole("button", { name: "Disconnect GitHub Developer" });
    fireEvent.click(disconnectButton);
    const dialog = within(screen.getByRole("dialog", { name: "Disconnect GitHub Developer?" }));
    fireEvent.click(dialog.getByRole("button", { name: "Disconnect", exact: true }));
    await waitFor(() => expect(disconnect).toHaveBeenCalledExactlyOnceWith(`${workspaceId}:${tabId}`));
    const commandRequest = fetchMock.mock.calls.find(([url]) => String(url).endsWith(`/workspaces/${workspaceId}/tabs`));
    expect(commandRequest?.[0]).toMatch(/\/vm\/alice\/~runtime\/studio\/api\/terminal\/workspaces/);
    expect(JSON.parse(String(commandRequest?.[1]?.body)).command).toEqual([
      "/bin/sh", "-c", expect.stringContaining('auth logout --hostname github.com --user "$1"'), "matrix-github-developer-disconnect", "octocat",
    ]);
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringMatching(/\/api\/integrations\/connect$/), expect.anything());

    view.rerender(<IntegrationsSection active={false} {...terminalCallbacks} />);
    ready = false;
    view.rerender(<IntegrationsSection active {...terminalCallbacks} />);
    expect(await screen.findByText("No integrations found")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "All apps" }));
    expect(await screen.findByRole("button", { name: "Connect GitHub Developer", exact: true })).toBeTruthy();
  });
});
