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

vi.mock("@/lib/gateway", () => ({
  getGatewayUrl: () => "http://gateway.test",
  getGatewayWs: () => "ws://gateway.test/ws",
}));

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
