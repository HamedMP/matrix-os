// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../home/apps/browser/src/App.js";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Browser app", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.history.pushState({}, "", "/");
  });

  it("renders a real browser toolbar with viewport states", () => {
    render(<App />);

    expect(screen.getByRole("textbox", { name: "URL" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Forward" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Audio muted" })).toBeTruthy();
    expect(screen.getByText("No page loaded")).toBeTruthy();
  });

  it("creates an owner-scoped browser session for navigation", async () => {
    const sockets: MockWebSocket[] = [];
    vi.stubGlobal("WebSocket", class extends MockWebSocket {
      constructor(url: string, protocols?: string | string[]) {
        super(url, protocols);
        sockets.push(this);
      }
    });
    const fetchMock = vi.fn(async () => jsonResponse({
      session: {
        id: "browser_session_owner_default",
        ownerId: "owner_1",
        profileId: "profile_owner_default",
        state: "active",
        currentTabId: null,
        takeoverRequired: false,
        mediaMode: "webrtc",
        protocolVersion: 1,
      },
      streamToken: "stream_token",
      wsUrl: "/api/browser/sessions/browser_session_owner_default/ws",
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    fireEvent.change(screen.getByRole("textbox", { name: "URL" }), {
      target: { value: "example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Navigate" }));

    await waitFor(() => expect(screen.getByText("WebRTC stream pending")).toBeTruthy());
    await waitFor(() => expect(sockets).toHaveLength(1));
    expect(sockets[0]?.url).toBe("ws://localhost:3000/api/browser/sessions/browser_session_owner_default/ws");
    expect(sockets[0]?.protocols).toEqual(["browser-stream.stream_token"]);
    sockets[0]?.emitMessage({
      type: "stream.ready",
      payload: { protocolVersion: 1 },
    });
    await waitFor(() => expect(screen.getByText("Browser stream connected")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith("/api/browser/sessions", expect.objectContaining({
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: expect.any(AbortSignal),
      body: JSON.stringify({
        profileName: "default",
        targetUrl: "https://example.com/",
        surface: "canvas",
        deviceId: "browser-canvas",
      }),
    }));
    fireEvent.click(screen.getByText("Grant agent access"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/browser/grants", expect.objectContaining({
      method: "POST",
      signal: expect.any(AbortSignal),
      body: JSON.stringify({
        sessionId: "browser_session_owner_default",
        scopes: ["read_dom", "screenshot"],
        domains: ["example.com"],
      }),
    })));
  });

  it("shows safe route errors without leaking server details", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: { code: "validation_error", message: "Browser request is invalid." },
    }), {
      status: 400,
      headers: { "content-type": "application/json" },
    })));

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Navigate" }));

    await waitFor(() => expect(screen.getByText("Browser request is invalid.")).toBeTruthy());
  });

  it("sends focus, pointer, keyboard, paste, and wheel input to the active stream", async () => {
    const sockets: MockWebSocket[] = [];
    vi.stubGlobal("WebSocket", class extends MockWebSocket {
      constructor(url: string, protocols?: string | string[]) {
        super(url, protocols);
        sockets.push(this);
      }
    });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      session: {
        id: "session_1",
        ownerId: "owner_1",
        profileId: "profile_1",
        state: "active",
        currentTabId: null,
        takeoverRequired: false,
        mediaMode: "webrtc",
        protocolVersion: 1,
      },
      streamToken: "stream_token",
      wsUrl: "/api/browser/sessions/session_1/ws",
    })));

    render(<App />);
    fireEvent.change(screen.getByRole("textbox", { name: "URL" }), {
      target: { value: "example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Navigate" }));
    await waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]?.open();

    const viewport = await screen.findByRole("region", { name: "Browser viewport" });
    fireEvent.focus(viewport);
    fireEvent.pointerDown(viewport, { clientX: 20, clientY: 30, button: 0 });
    fireEvent.keyDown(viewport, { key: "A", code: "KeyA" });
    fireEvent.paste(viewport, {
      clipboardData: { getData: () => "pasted text" },
    });
    fireEvent.wheel(viewport, { clientX: 21, clientY: 31, deltaY: 12, deltaX: 2 });

    expect(sockets[0]?.sent.map((value) => JSON.parse(value))).toEqual([
      {
        type: "stream.hello",
        payload: {
          protocolVersion: 1,
          surfaceId: "browser-canvas",
          surface: "canvas",
          deviceId: "browser-canvas",
          viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
          media: {
            preferredMode: "webrtc",
            audio: true,
            fallbackFrames: true,
            iceTransportPolicy: "relay",
          },
        },
      },
      {
        type: "surface.focus",
        payload: { surfaceId: "browser-canvas", reason: "programmatic" },
      },
      {
        type: "input.pointer",
        payload: { kind: "down", x: 20, y: 30, button: "left", modifiers: [] },
      },
      {
        type: "input.keyboard",
        payload: { kind: "keydown", key: "A", code: "KeyA", text: "A", modifiers: [] },
      },
      {
        type: "input.paste",
        payload: { text: "pasted text" },
      },
      {
        type: "input.pointer",
        payload: { kind: "wheel", x: 21, y: 31, button: "none", modifiers: [], deltaX: 2, deltaY: 12 },
      },
    ]);
  });

  it("boots a standalone browser session from route query params", async () => {
    window.history.pushState({}, "", "/apps/browser/?target=https%3A%2F%2Fexample.com%2Fdocs&surface=standalone&handoff=handoff_token");
    const sockets: MockWebSocket[] = [];
    vi.stubGlobal("WebSocket", class extends MockWebSocket {
      constructor(url: string, protocols?: string | string[]) {
        super(url, protocols);
        sockets.push(this);
      }
    });
    const fetchMock = vi.fn(async () => jsonResponse({
      session: {
        id: "session_1",
        ownerId: "owner_1",
        profileId: "profile_1",
        state: "active",
        currentTabId: null,
        takeoverRequired: false,
        mediaMode: "webrtc",
        protocolVersion: 1,
      },
      streamToken: "stream_token",
      wsUrl: "/api/browser/sessions/session_1/ws",
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/browser/sessions", expect.objectContaining({
      method: "POST",
      headers: { "content-type": "application/json", "x-browser-handoff": "1" },
      signal: expect.any(AbortSignal),
      body: JSON.stringify({
        profileName: "default",
        targetUrl: "https://example.com/docs",
        handoffToken: "handoff_token",
        surface: "standalone",
        deviceId: "browser-standalone",
      }),
    })));
    await waitFor(() => expect((screen.getByRole("textbox", { name: "URL" }) as HTMLInputElement).value).toBe("https://example.com/docs"));
    await waitFor(() => expect(sockets).toHaveLength(1));
    expect(sockets[0]?.protocols).toEqual(["browser-stream.stream_token"]);
    sockets[0]?.open();
    fireEvent.change(screen.getByRole("textbox", { name: "URL" }), {
      target: { value: "https://example.com/docs/next" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Navigate" }));
    expect(sockets[0]?.sent.map((value) => JSON.parse(value))).toContainEqual({
      type: "browser.navigate",
      payload: { targetUrl: "https://example.com/docs/next", surface: "standalone" },
    });
  });

  it("shows downloads, grants, and clear-data controls", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/browser/downloads" && !init?.method) {
        return jsonResponse({ downloads: [{ id: "download_1", filename: "report.pdf", state: "complete" }] });
      }
      if (url === "/api/browser/grants" && !init?.method) {
        return jsonResponse({ grants: [{ id: "grant_1", scopes: ["screenshot"], domains: ["example.com"] }] });
      }
      if (url === "/api/browser/profiles/default/clear") {
        return jsonResponse({ profile: { name: "default" } });
      }
      if (url === "/api/browser/grants" && init?.method === "POST") {
        return jsonResponse({ grant: { id: "grant_2" } });
      }
      if (url === "/api/browser/grants/grant_1" || url === "/api/browser/downloads/download_1") {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByText("report.pdf")).toBeTruthy());
    expect(screen.getByText("1 downloads")).toBeTruthy();
    expect(screen.getByText("1 active grants")).toBeTruthy();
    fireEvent.click(screen.getByText("Clear browser data"));
    await waitFor(() => expect(screen.getByText("Browser data cleared")).toBeTruthy());
    fireEvent.click(screen.getByText("Grant agent access"));
    await waitFor(() => expect(screen.getByText("Open a Browser session first.")).toBeTruthy());
    fireEvent.click(screen.getByText("Revoke screenshot"));
    fireEvent.click(screen.getByText("report.pdf"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/browser/profiles/default/clear", expect.objectContaining({
      method: "POST",
      signal: expect.any(AbortSignal),
    })));
    expect(fetchMock).toHaveBeenCalledWith("/api/browser/grants/grant_1", expect.objectContaining({
      method: "DELETE",
      signal: expect.any(AbortSignal),
    }));
    expect(fetchMock).toHaveBeenCalledWith("/api/browser/downloads/download_1", expect.objectContaining({
      method: "DELETE",
      signal: expect.any(AbortSignal),
    }));
  });

  it("renders takeover and recoverable runtime states", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/browser/downloads" || url === "/api/browser/grants") {
        return jsonResponse(url.endsWith("downloads") ? { downloads: [] } : { grants: [] });
      }
      if (url === "/api/browser/sessions/session_locked/takeover") {
        return jsonResponse({
          session: {
            id: "session_2",
            ownerId: "owner_1",
            profileId: "profile_1",
            state: "active",
            currentTabId: null,
            takeoverRequired: false,
            mediaMode: "webrtc",
            protocolVersion: 1,
          },
          streamToken: "stream_token_2",
          wsUrl: "/api/browser/sessions/session_2/ws",
        });
      }
      return jsonResponse({
        session: {
          id: "session_locked",
          ownerId: "owner_1",
          profileId: "profile_1",
          state: "active",
          currentTabId: null,
          takeoverRequired: true,
          mediaMode: "webrtc",
          protocolVersion: 1,
        },
        streamToken: null,
        wsUrl: null,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", MockWebSocket);

    render(<App />);
    fireEvent.change(screen.getByRole("textbox", { name: "URL" }), {
      target: { value: "example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Navigate" }));

    await waitFor(() => expect(screen.getByText("Browser open elsewhere")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Take over" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/browser/sessions/session_locked/takeover", expect.objectContaining({
      method: "POST",
      signal: expect.any(AbortSignal),
      body: JSON.stringify({ deviceId: "browser-canvas", confirm: true }),
    })));
    await waitFor(() => expect(screen.getByText("WebRTC stream pending")).toBeTruthy());
  });
});

class MockWebSocket {
  static readonly OPEN = 1;
  readonly url: string;
  readonly protocols: string[];
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  static readonly CONNECTING = 0;

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = Array.isArray(protocols) ? protocols : protocols ? [protocols] : [];
  }

  send(value: string): void {
    this.sent.push(value);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close"));
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  emitMessage(value: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(value) }));
  }
}
