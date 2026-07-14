// @vitest-environment jsdom
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeAppViewer } from "../../shell/src/components/NativeAppViewer.js";

describe("NativeAppViewer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState({}, "", "/");
  });

  it("launches a native session in an opaque-origin sandbox and terminates on close", async () => {
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 1180,
      height: 720,
      top: 0,
      left: 0,
      right: 1180,
      bottom: 720,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url);
      if (requestUrl === "/api/native-apps/xterm/sessions" && init?.method === "POST") {
        return new Response(JSON.stringify({
          session: {
            id: "session_aaaaaaaaaaaaaaaaaaaaaaaa",
            appId: "xterm",
            status: "running",
            streamUrl: "/api/native-apps/sessions/session_aaaaaaaaaaaaaaaaaaaaaaaa/stream/",
          },
        }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (requestUrl === "/api/native-apps/sessions/session_aaaaaaaaaaaaaaaaaaaaaaaa" && init?.method === "DELETE") {
        return new Response(null, { status: 200 });
      }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(window, "fetch", {
      configurable: true,
      value: fetchMock,
    });

    const { unmount } = render(<NativeAppViewer appId="xterm" windowId="win-native" />);
    const frame = await screen.findByTitle("xterm native app");

    const frameUrl = new URL(frame.getAttribute("src")!, "http://localhost");
    expect(frameUrl.pathname).toBe("/api/native-apps/sessions/session_aaaaaaaaaaaaaaaaaaaaaaaa/stream/");
    expect(Object.fromEntries(frameUrl.searchParams)).toEqual({
      clipboard: "false",
      file_transfer: "false",
      floating_menu: "false",
      offscreen: "false",
      printing: "false",
      reconnect: "false",
      remote_logging: "false",
      sound: "false",
      submit: "false",
    });
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    const launchCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(launchCall?.[1]?.body))).toEqual({ width: 1180, height: 720 });

    unmount();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/native-apps/sessions/session_aaaaaaaaaaaaaaaaaaaaaaaa",
        expect.objectContaining({ method: "DELETE" }),
      );
    });
    rectSpy.mockRestore();
  });

  it("pins native app routes to the explicit VM when opened under /vm/:handle", async () => {
    window.history.replaceState({}, "", "/vm/7a");
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url);
      if (requestUrl === "/vm/7a/api/native-apps/xterm/sessions" && init?.method === "POST") {
        return new Response(JSON.stringify({
          session: {
            id: "session_bbbbbbbbbbbbbbbbbbbbbbbb",
            appId: "xterm",
            status: "running",
            streamUrl: "/api/native-apps/sessions/session_bbbbbbbbbbbbbbbbbbbbbbbb/stream/?nativeStreamToken=stream_cccccccccccccccccccccccc",
          },
        }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (requestUrl === "/vm/7a/api/native-apps/sessions/session_bbbbbbbbbbbbbbbbbbbbbbbb" && init?.method === "DELETE") {
        return new Response(null, { status: 200 });
      }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(window, "fetch", {
      configurable: true,
      value: fetchMock,
    });

    const { unmount } = render(<NativeAppViewer appId="xterm" windowId="win-native" />);
    const frame = await screen.findByTitle("xterm native app");

    const frameUrl = new URL(frame.getAttribute("src")!, "http://localhost");
    expect(frameUrl.pathname).toBe("/vm/7a/api/native-apps/sessions/session_bbbbbbbbbbbbbbbbbbbbbbbb/stream/");
    expect(frameUrl.searchParams.get("nativeStreamToken")).toBe("stream_cccccccccccccccccccccccc");

    unmount();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/vm/7a/api/native-apps/sessions/session_bbbbbbbbbbbbbbbbbbbbbbbb",
        expect.objectContaining({ method: "DELETE" }),
      );
    });
  });

  it("preserves the selected runtime slot on explicit VM launch, stream, and termination requests", async () => {
    window.history.replaceState({}, "", "/vm/alice?runtime=review");
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url);
      if (requestUrl === "/vm/alice/api/native-apps/xterm/sessions?runtime=review" && init?.method === "POST") {
        return new Response(JSON.stringify({
          session: {
            id: "session_ffffffffffffffffffffffff",
            appId: "xterm",
            status: "running",
            streamUrl: "/api/native-apps/sessions/session_ffffffffffffffffffffffff/stream/stream_gggggggggggggggggggggggg/",
          },
        }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      if (
        requestUrl === "/vm/alice/api/native-apps/sessions/session_ffffffffffffffffffffffff?runtime=review"
        && init?.method === "DELETE"
      ) {
        return new Response(null, { status: 200 });
      }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(window, "fetch", { configurable: true, value: fetchMock });

    const viewer = render(<NativeAppViewer appId="xterm" windowId="win-review-runtime" />);
    const frame = await screen.findByTitle("xterm native app");

    const frameUrl = new URL(frame.getAttribute("src")!, "http://localhost");
    expect(frameUrl.pathname).toBe(
      "/vm/alice/api/native-apps/sessions/session_ffffffffffffffffffffffff/stream/stream_gggggggggggggggggggggggg/",
    );
    expect(frameUrl.searchParams.get("runtime")).toBe("review");

    viewer.unmount();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/vm/alice/api/native-apps/sessions/session_ffffffffffffffffffffffff?runtime=review",
        expect.objectContaining({ method: "DELETE" }),
      );
    });
  });

  it("preserves a root-shell runtime selector on a handle-qualified stream capability", async () => {
    window.history.replaceState({}, "", "/?runtime=review");
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url);
      if (requestUrl === "/api/native-apps/xterm/sessions?runtime=review" && init?.method === "POST") {
        return new Response(JSON.stringify({
          session: {
            id: "session_hhhhhhhhhhhhhhhhhhhhhhhh",
            appId: "xterm",
            status: "running",
            streamUrl: "/vm/alice/api/native-apps/sessions/session_hhhhhhhhhhhhhhhhhhhhhhhh/stream/stream_iiiiiiiiiiiiiiiiiiiiiiii/",
          },
        }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      if (
        requestUrl === "/api/native-apps/sessions/session_hhhhhhhhhhhhhhhhhhhhhhhh?runtime=review"
        && init?.method === "DELETE"
      ) {
        return new Response(null, { status: 200 });
      }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(window, "fetch", { configurable: true, value: fetchMock });

    const viewer = render(<NativeAppViewer appId="xterm" windowId="win-root-review-runtime" />);
    const frame = await screen.findByTitle("xterm native app");

    const frameUrl = new URL(frame.getAttribute("src")!, "http://localhost");
    expect(frameUrl.pathname).toBe(
      "/vm/alice/api/native-apps/sessions/session_hhhhhhhhhhhhhhhhhhhhhhhh/stream/stream_iiiiiiiiiiiiiiiiiiiiiiii/",
    );
    expect(frameUrl.searchParams.get("runtime")).toBe("review");

    viewer.unmount();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/native-apps/sessions/session_hhhhhhhhhhhhhhhhhhhhhhhh?runtime=review",
        expect.objectContaining({ method: "DELETE" }),
      );
    });
  });

  it("preserves a native session across an immediate renderer remount", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url);
      if (requestUrl === "/api/native-apps/xcalc/sessions" && init?.method === "POST") {
        return new Response(JSON.stringify({
          session: {
            id: "session_dddddddddddddddddddddddd",
            appId: "xcalc",
            status: "running",
            streamUrl: "/api/native-apps/sessions/session_dddddddddddddddddddddddd/stream/",
          },
        }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (requestUrl === "/api/native-apps/sessions/session_dddddddddddddddddddddddd" && init?.method === "DELETE") {
        return new Response(null, { status: 200 });
      }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(window, "fetch", {
      configurable: true,
      value: fetchMock,
    });

    const canvasRenderer = render(<NativeAppViewer appId="xcalc" windowId="win-preserved" />);
    await screen.findByTitle("xcalc native app");
    canvasRenderer.unmount();

    const desktopRenderer = render(<NativeAppViewer appId="xcalc" windowId="win-preserved" />);
    await screen.findByTitle("xcalc native app");
    await Promise.resolve();

    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(0);

    desktopRenderer.unmount();
    await waitFor(() => {
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
    });
  });

  it("retries transient native-session termination failures", async () => {
    let deleteAttempts = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url);
      if (requestUrl === "/api/native-apps/xterm/sessions" && init?.method === "POST") {
        return new Response(JSON.stringify({
          session: {
            id: "session_eeeeeeeeeeeeeeeeeeeeeeee",
            appId: "xterm",
            status: "running",
            streamUrl: "/api/native-apps/sessions/session_eeeeeeeeeeeeeeeeeeeeeeee/stream/",
          },
        }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      if (requestUrl === "/api/native-apps/sessions/session_eeeeeeeeeeeeeeeeeeeeeeee" && init?.method === "DELETE") {
        deleteAttempts += 1;
        return new Response(null, { status: deleteAttempts < 3 ? 503 : 200 });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(window, "fetch", { configurable: true, value: fetchMock });

    const viewer = render(<NativeAppViewer appId="xterm" windowId="win-retry-close" />);
    await screen.findByTitle("xterm native app");
    viewer.unmount();

    await waitFor(() => expect(deleteAttempts).toBe(3));
  });

  it("drains active native sessions with an unload-safe request on pagehide", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url);
      if (requestUrl === "/api/native-apps/xterm/sessions" && init?.method === "POST") {
        return new Response(JSON.stringify({
          session: {
            id: "session_jjjjjjjjjjjjjjjjjjjjjjjj",
            appId: "xterm",
            status: "running",
            streamUrl: "/api/native-apps/sessions/session_jjjjjjjjjjjjjjjjjjjjjjjj/stream/",
          },
        }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      if (
        requestUrl === "/api/native-apps/sessions/session_jjjjjjjjjjjjjjjjjjjjjjjj"
        && init?.method === "DELETE"
      ) {
        return new Response(null, { status: 200 });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(window, "fetch", { configurable: true, value: fetchMock });

    render(<NativeAppViewer appId="xterm" windowId="win-pagehide" />);
    await screen.findByTitle("xterm native app");
    window.dispatchEvent(new PageTransitionEvent("pagehide"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/native-apps/sessions/session_jjjjjjjjjjjjjjjjjjjjjjjj",
        expect.objectContaining({
          method: "DELETE",
          keepalive: true,
          signal: expect.any(AbortSignal),
        }),
      );
    });
  });

  it("keeps native sessions alive when pagehide enters the back-forward cache", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url);
      if (requestUrl === "/api/native-apps/xterm/sessions" && init?.method === "POST") {
        return new Response(JSON.stringify({
          session: {
            id: "session_kkkkkkkkkkkkkkkkkkkkkkkk",
            appId: "xterm",
            status: "running",
            streamUrl: "/api/native-apps/sessions/session_kkkkkkkkkkkkkkkkkkkkkkkk/stream/",
          },
        }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(window, "fetch", { configurable: true, value: fetchMock });

    const viewer = render(<NativeAppViewer appId="xterm" windowId="win-bfcache" />);
    await screen.findByTitle("xterm native app");
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/native-apps/sessions/session_kkkkkkkkkkkkkkkkkkkkkkkk",
      expect.objectContaining({ method: "DELETE" }),
    );
    viewer.unmount();
  });
});
