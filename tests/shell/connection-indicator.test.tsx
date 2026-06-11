// @vitest-environment jsdom

import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConnectionHealth } from "../../shell/src/hooks/useConnectionHealth.js";
import { ConnectionIndicator } from "../../shell/src/components/ConnectionIndicator.js";
import { resolveConnectionCopy } from "../../shell/src/components/connection-indicator-copy.js";

const mocks = vi.hoisted(() => ({
  manualReconnect: vi.fn(),
}));

vi.mock("@/hooks/useSocket", () => ({
  manualReconnect: () => mocks.manualReconnect(),
}));

vi.mock("@/lib/gateway", () => ({
  getGatewayUrl: () => "http://gateway.test",
}));

function jsonResponse(body: unknown) {
  return {
    ok: true,
    json: async () => body,
  } as Response;
}

describe("ConnectionIndicator", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    mocks.manualReconnect.mockReset();
    act(() => {
      useConnectionHealth.setState({ state: "disconnected" });
    });
  });

  it("describes gateway-online reconnects instead of a generic reconnecting label", async () => {
    act(() => {
      useConnectionHealth.setState({ state: "reconnecting" });
    });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/health")) return Promise.resolve(jsonResponse({ status: "ok" }));
      if (url.endsWith("/api/system/info")) {
        return Promise.resolve(jsonResponse({
          release: { version: "v2026.05.29-test", channel: "stable" },
        }));
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    render(<ConnectionIndicator />);

    await waitFor(() => {
      expect(screen.getByRole("status", { name: /matrix connection status/i })).toBeTruthy();
      expect(screen.getByText("Reconnecting shell")).toBeTruthy();
      expect(screen.getByText("v2026.05.29-test")).toBeTruthy();
      expect(screen.getByText("stable")).toBeTruthy();
    });
  });

  it("shows the runtime version even when the gateway omits a release channel", async () => {
    act(() => {
      useConnectionHealth.setState({ state: "reconnecting" });
    });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/health")) return Promise.resolve(jsonResponse({ status: "ok" }));
      if (url.endsWith("/api/system/info")) {
        return Promise.resolve(jsonResponse({ version: "v2026.06.11-version-only" }));
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    render(<ConnectionIndicator />);

    await waitFor(() => {
      expect(screen.getByText("v2026.06.11-version-only")).toBeTruthy();
    });
  });

  it("shows an update/restart state when the gateway is unavailable", async () => {
    act(() => {
      useConnectionHealth.setState({ state: "reconnecting" });
    });
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("gateway down"))));

    render(<ConnectionIndicator />);

    await waitFor(() => {
      expect(screen.getByText("Matrix is reconnecting")).toBeTruthy();
      expect(screen.getByText(/keeping your workspace open/i)).toBeTruthy();
      expect(screen.queryByText("Matrix computer is restarting")).toBeNull();
      expect(screen.queryByText(/bundle upgrades or gateway restarts/i)).toBeNull();
      expect(screen.getByRole("status", { name: /matrix connection status/i }).getAttribute("data-variant")).toBe("dock");
    });
  });

  it("lets users manually retry a disconnected live socket", async () => {
    act(() => {
      useConnectionHealth.setState({ state: "disconnected" });
    });
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("gateway down"))));

    render(<ConnectionIndicator />);

    fireEvent.click(await screen.findByRole("button", { name: /reconnect/i }));

    expect(mocks.manualReconnect).toHaveBeenCalledTimes(1);
  });
});

describe("resolveConnectionCopy", () => {
  it("uses precise copy for disconnected but reachable runtimes", () => {
    expect(resolveConnectionCopy("disconnected", { reachability: "online" })).toMatchObject({
      title: "Connection lost",
      detail: expect.stringContaining("online"),
      action: "Reconnect",
    });
  });

  it("uses gateway-online copy while reconnecting", () => {
    expect(resolveConnectionCopy("reconnecting", {
      reachability: "online",
      releaseVersion: "v2026.05.29-test",
    })).toMatchObject({
      title: "Reconnecting shell",
      detail: "The gateway is online. Waiting for the live session to resume.",
      action: "Retry now",
    });
  });

  it("uses checking copy before runtime polling settles", () => {
    expect(resolveConnectionCopy("reconnecting", { reachability: "checking" })).toMatchObject({
      title: "Checking connection",
      detail: expect.stringContaining("checking"),
      action: "Retry now",
    });
  });

  it("uses restart copy when the runtime is unreachable", () => {
    expect(resolveConnectionCopy("reconnecting", { reachability: "unavailable" })).toMatchObject({
      title: "Matrix is reconnecting",
      detail: expect.stringContaining("keeping your workspace open"),
      action: "Retry now",
    });
  });
});
