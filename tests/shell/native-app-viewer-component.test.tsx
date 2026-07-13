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

    expect(frame.getAttribute("src")).toBe("/api/native-apps/sessions/session_aaaaaaaaaaaaaaaaaaaaaaaa/stream/");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");

    unmount();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/native-apps/sessions/session_aaaaaaaaaaaaaaaaaaaaaaaa",
        expect.objectContaining({ method: "DELETE" }),
      );
    });
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

    expect(frame.getAttribute("src")).toBe(
      "/vm/7a/api/native-apps/sessions/session_bbbbbbbbbbbbbbbbbbbbbbbb/stream/?nativeStreamToken=stream_cccccccccccccccccccccccc",
    );

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

    expect(frame.getAttribute("src")).toBe(
      "/vm/alice/api/native-apps/sessions/session_ffffffffffffffffffffffff/stream/stream_gggggggggggggggggggggggg/?runtime=review",
    );

    viewer.unmount();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/vm/alice/api/native-apps/sessions/session_ffffffffffffffffffffffff?runtime=review",
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
});
