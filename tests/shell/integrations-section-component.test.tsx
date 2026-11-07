// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("uses the explicit computer and rechecks when Settings returns from Terminal", async () => {
    window.history.replaceState({}, "", "/vm/alice?runtime=studio");
    buildAuthenticatedWebSocketUrl.mockReturnValue(new Promise(() => {}));
    vi.spyOn(providerTransport, "createProviderSettingsTransport").mockReturnValue({
      getSnapshot: vi.fn().mockResolvedValue({ access: { mode: "writable" } }),
    } as never);
    let ready = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
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
      return new Response(null, { status: 503 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const setup = vi.fn();
    const view = render(<IntegrationsSection onOpenGithubDeveloperTerminal={setup} />);
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
    expect(setup).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringMatching(/integrations\/connect$/), expect.anything());

    view.rerender(<IntegrationsSection active={false} onOpenGithubDeveloperTerminal={setup} />);
    ready = true;
    view.rerender(<IntegrationsSection active onOpenGithubDeveloperTerminal={setup} />);
    expect(await screen.findByText("Ready")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect GitHub Developer", exact: true })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Connected (1)" }));
    expect(screen.getByTestId("integration-card-github-developer")).toBeTruthy();
    expect(screen.queryByTestId("integration-card-github")).toBeNull();
  });
});
