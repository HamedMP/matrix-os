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
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    mocks.manualReconnect.mockReset();
    act(() => {
      useConnectionHealth.setState({ state: "initializing" });
    });
  });

  it("stays hidden and does not probe health during normal initial connection", () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    act(() => {
      useConnectionHealth.setState({ state: "initializing" });
    });

    render(<ConnectionIndicator />);

    expect(screen.queryByRole("status", { name: /matrix connection status/i })).toBeNull();
    act(() => {
      vi.advanceTimersByTime(2_499);
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("status", { name: /matrix connection status/i })).toBeNull();
  });

  it("shows the warning if initial connection exceeds the grace period", async () => {
    vi.useFakeTimers();
    act(() => {
      useConnectionHealth.setState({ state: "initializing" });
    });
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("gateway down"))));

    render(<ConnectionIndicator />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
      await Promise.resolve();
    });

    expect(screen.getByRole("status", { name: /matrix connection status/i })).toBeTruthy();
    expect(screen.getByText("Checking connection")).toBeTruthy();
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

  it("uses fixed viewport placement by default", async () => {
    act(() => {
      useConnectionHealth.setState({ state: "reconnecting" });
    });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/health")) return Promise.resolve(jsonResponse({ status: "ok" }));
      if (url.endsWith("/api/system/info")) return Promise.resolve(jsonResponse({ version: "v2026.06.22-test" }));
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    render(<ConnectionIndicator />);

    const status = await screen.findByRole("status", { name: /matrix connection status/i });
    expect(status.className).toContain("fixed");
    expect(status.className).toContain("inset-x-0");
    expect(status.className).toContain("bottom-[calc(env(safe-area-inset-bottom)+0.75rem)]");
  });

  it("uses dock placement without fixed viewport positioning", async () => {
    act(() => {
      useConnectionHealth.setState({ state: "reconnecting" });
    });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/health")) return Promise.resolve(jsonResponse({ status: "ok" }));
      if (url.endsWith("/api/system/info")) return Promise.resolve(jsonResponse({ version: "v2026.06.22-test" }));
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    render(<ConnectionIndicator placement="dock" />);

    const status = await screen.findByRole("status", { name: /matrix connection status/i });
    expect(status.className).not.toContain("fixed");
    expect(status.className).not.toContain("inset-x-0");
    expect(status.className).not.toContain("bottom-[calc(env(safe-area-inset-bottom)+0.75rem)]");
    expect(status.getAttribute("data-variant")).toBe("dock");
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
  it("uses quiet initial connection copy after grace", () => {
    expect(resolveConnectionCopy("initializing", { reachability: "checking" })).toMatchObject({
      title: "Checking connection",
      detail: expect.stringContaining("opening"),
      action: "Retry now",
    });
  });

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
