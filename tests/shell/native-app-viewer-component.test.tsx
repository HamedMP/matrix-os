// @vitest-environment jsdom
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeAppViewer } from "../../shell/src/components/NativeAppViewer.js";

describe("NativeAppViewer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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
});
