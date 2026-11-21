// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import DesktopPrivateNetworkSection from "../../desktop/src/renderer/src/features/settings/sections/PrivateNetworkSection";
import { PRIVATE_NETWORK_CONNECT_TIMEOUT_MS } from "../../packages/ui/src/private-network/client";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { PrivateNetworkSection as ShellPrivateNetworkSection } from "../../shell/src/components/settings/sections/PrivateNetworkSection";

const notInstalled = {
  supported: true,
  accessMode: "tailscale",
  state: "not-installed",
  loginUrl: null,
  tailnet: null,
  machine: null,
  viaPrivateNetwork: false,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useConnection.setState({ api: null });
});

describe("private network surface transports", () => {
  it("Web Desktop and Web Canvas load status with cookies, no cache, and a bounded signal", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(notInstalled), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ShellPrivateNetworkSection />);
    expect(await screen.findByText(/--access tailscale/)).toBeTruthy();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${window.location.origin}/api/system/private-network`);
    expect(init).toMatchObject({ method: "GET", credentials: "include", cache: "no-store" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("Web Desktop hides the panel when an older gateway returns 404", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { container } = render(<ShellPrivateNetworkSection />);
    await act(async () => {});
    expect(container.textContent).toBe("");
  });

  it("Web Desktop gives connect the long connect timeout", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.fn(async (url: string) =>
      new Response(JSON.stringify(url.endsWith("/connect") ? notInstalled : { ...notInstalled, state: "logged-out" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ShellPrivateNetworkSection />);
    fireEvent.click(await screen.findByRole("button", { name: /Connect/ }));
    await act(async () => {});
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/connect"))).toBe(true);
    expect(timeoutSpy).toHaveBeenCalledWith(PRIVATE_NETWORK_CONNECT_TIMEOUT_MS);
    timeoutSpy.mockRestore();
  });

  it("Electron Desktop gives connect the long connect timeout", async () => {
    const runtime = {
      get: vi.fn(async () => ({ ...notInstalled, state: "logged-out" })),
      post: vi.fn(async () => notInstalled),
      delete: vi.fn(),
    };
    useConnection.setState({ api: { forRuntime: vi.fn(() => runtime) } as never, runtimeSlot: "primary" });
    render(<DesktopPrivateNetworkSection />);
    fireEvent.click(await screen.findByRole("button", { name: /Connect/ }));
    await act(async () => {});
    expect(runtime.post).toHaveBeenCalledWith("/api/system/private-network/connect", {}, {
      signal: expect.any(AbortSignal),
      timeoutMs: PRIVATE_NETWORK_CONNECT_TIMEOUT_MS,
    });
  });

  it("Electron Desktop binds requests to the active runtime and hides on 404", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const runtime = {
      get: vi.fn(async () => {
        throw Object.assign(new Error("not found"), { httpStatus: 404 });
      }),
      post: vi.fn(),
      delete: vi.fn(),
    };
    const forRuntime = vi.fn(() => runtime);
    useConnection.setState({ api: { forRuntime } as never, runtimeSlot: "primary" });
    const { container } = render(<DesktopPrivateNetworkSection />);
    await act(async () => {});
    expect(forRuntime).toHaveBeenCalledWith("primary");
    expect(runtime.get).toHaveBeenCalledWith("/api/system/private-network", {
      signal: expect.any(AbortSignal),
      cache: "no-store",
    });
    expect(container.textContent).toBe("");
  });
});
