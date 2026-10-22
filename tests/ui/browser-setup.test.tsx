// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserSurface } from "../../packages/ui/src/browser/BrowserSurface";
const gatewayUrl = "https://app.matrix-os.com/vm/main-computer";
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("shared Browser setup gate", () => {
  it("shows upgrade guidance without unsupported setup or viewer requests on older Desktop", async () => {
    const setup = { requiresDesktopUpdate: true, status: vi.fn(), retry: vi.fn() }, ensureSession = vi.fn();
    render(<BrowserSurface surface="browser" gatewayUrl={gatewayUrl} ensureSession={ensureSession} setup={setup}/>);
    expect(screen.getByText("Update Matrix OS Desktop to use Browser")).toBeTruthy();
    expect(setup.status).not.toHaveBeenCalled(); expect(ensureSession).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Retry setup" })).toBeNull();
  });
  it.each(["browser", "desktop"] as const)("shows preparing and safe bounded retry before %s viewer admission", async surface => {
    let resolve!: (value: unknown) => void;
    const setup = { status: vi.fn(() => new Promise<unknown>(r => { resolve = r; })), retry: vi.fn(async () => ({ status: "installing", retryAvailable: false })) };
    const ensureSession = vi.fn(async () => {});
    render(<BrowserSurface surface={surface} gatewayUrl={gatewayUrl} ensureSession={ensureSession} setup={setup}/>);
    expect(screen.getByText("Preparing Browser…")).toBeTruthy(); expect(ensureSession).not.toHaveBeenCalled();
    await act(async () => { resolve({ status: "failed", retryAvailable: true }); });
    expect(await screen.findByText("Browser setup could not finish")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry setup" }));
    await waitFor(() => expect(setup.retry).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Preparing Browser…")).toBeTruthy(); expect(ensureSession).not.toHaveBeenCalled();
  });
  it("leaves explicit opt-out disabled and does not offer setup retry", async () => {
    render(<BrowserSurface surface="browser" gatewayUrl={gatewayUrl} ensureSession={vi.fn()} setup={{ status: async () => ({ status: "disabled", retryAvailable: false }), retry: vi.fn() }}/>);
    expect(await screen.findByText("Browser is disabled on this Computer")).toBeTruthy(); expect(screen.queryByRole("button", { name: "Retry setup" })).toBeNull();
  });
  it("never displays private failure details or accepts malformed native status", async () => {
    render(<BrowserSurface surface="browser" gatewayUrl={gatewayUrl} ensureSession={vi.fn()} setup={{ status: async () => ({ status: "failed", retryAvailable: true, detail: "private-token" }), retry: vi.fn() }}/>);
    expect(await screen.findByText("Browser setup is unavailable")).toBeTruthy(); expect(screen.queryByText(/private-token/)).toBeNull();
  });
  it("cancels a stale runtime setup response and makes no background requests", async () => {
    let resolve!: (value: unknown) => void; let signal!: AbortSignal;
    const setup = { status: vi.fn((s: AbortSignal) => { signal = s; return new Promise(r => { resolve = r; }); }), retry: vi.fn() };
    const ensureSession = vi.fn();
    const view = render(<BrowserSurface surface="browser" gatewayUrl={gatewayUrl} active={false} ensureSession={ensureSession} setup={setup}/>);
    expect(setup.status).not.toHaveBeenCalled();
    view.rerender(<BrowserSurface surface="browser" gatewayUrl={gatewayUrl} active ensureSession={ensureSession} setup={setup}/>);
    await waitFor(() => expect(setup.status).toHaveBeenCalledTimes(1)); view.unmount(); expect(signal.aborted).toBe(true);
    await act(async () => { resolve({ status: "ready", retryAvailable: false }); }); expect(ensureSession).not.toHaveBeenCalled();
  });
});

it("ignores a stale setup poll failure after an explicit retry succeeds", async () => {
  vi.useFakeTimers();
  let rejectPoll!: (error: Error) => void;
  const setup = { status: vi.fn().mockResolvedValueOnce({ status: "failed", retryAvailable: true }).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectPoll = reject; })),
    retry: vi.fn(async () => ({ status: "installing", retryAvailable: false })) };
  render(<BrowserSurface surface="browser" gatewayUrl={gatewayUrl} ensureSession={vi.fn()} setup={setup}/>);
  await act(async () => {});
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
  fireEvent.click(screen.getByRole("button", { name: "Retry setup" })); await act(async () => {});
  expect(screen.getByText("Preparing Browser…")).toBeTruthy();
  await act(async () => { rejectPoll(new Error("private failure")); });
  expect(screen.getByText("Preparing Browser…")).toBeTruthy(); expect(screen.queryByText("Browser setup is unavailable")).toBeNull();
  cleanup(); vi.useRealTimers();
});

it("opens the viewer only after setup reports ready", async () => {
  const ensureSession = vi.fn(async () => {});
  const fetcher = vi.fn(async (url: string) => url.endsWith("/browser-status") ? Response.json({ available: true, chrome: { present: true, minimized: false }, humanControlAvailable: true })
    : Response.json({ ticket: "a".repeat(48), expiresAt: Date.now() + 60_000 }));
  vi.stubGlobal("fetch", fetcher);
  render(<BrowserSurface surface="browser" gatewayUrl={gatewayUrl} ensureSession={ensureSession} setup={{ status: async () => ({ status: "ready", retryAvailable: false }), retry: vi.fn() }}/>);
  expect(await screen.findByTitle("Chrome on your Matrix computer")).toBeTruthy(); expect(ensureSession).toHaveBeenCalled();
  vi.unstubAllGlobals();
});

it.each(["browser", "desktop"] as const)("rechecks setup on explicit %s reconnect and exposes native retry without reopening", async surface => {
  const setup = { status: vi.fn().mockResolvedValueOnce({ status: "ready", retryAvailable: false }).mockResolvedValue({ status: "failed", retryAvailable: true }),
    retry: vi.fn(async () => ({ status: "installing", retryAvailable: false })) };
  const ensureSession = vi.fn(async () => {});
  const fetcher = vi.fn(async (url: string) => url.endsWith("/browser-status") ? Response.json({ available: true, chrome: { present: true, minimized: false }, humanControlAvailable: true })
    : Response.json({ ticket: "a".repeat(48), expiresAt: Date.now() + 60_000 }));
  vi.stubGlobal("fetch", fetcher);
  render(<BrowserSurface surface={surface} gatewayUrl={gatewayUrl} ensureSession={ensureSession} setup={setup}/>);
  const frame = await screen.findByTitle(surface === "browser" ? "Chrome on your Matrix computer" : "Your Matrix cloud desktop") as HTMLIFrameElement;
  act(() => { for (const connected of [true, false]) window.dispatchEvent(new MessageEvent("message", { data: { type: "matrix-browser-viewer", connected }, origin: "https://app.matrix-os.com", source: frame.contentWindow })); });
  const viewerRequests = fetcher.mock.calls.length;
  fireEvent.click(await screen.findByRole("button", { name: "Reconnect" }));
  expect(await screen.findByRole("button", { name: "Retry setup" })).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(viewerRequests); expect(setup.status).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "Retry setup" }));
  await waitFor(() => expect(setup.retry).toHaveBeenCalledTimes(1)); expect(screen.getByText("Preparing Browser…")).toBeTruthy();
  vi.unstubAllGlobals();
});

it.each(["runtime", "active"])("keeps the viewer during a pending reconnect check and fences a late result after %s changes", async changed => {
  let resolve!: (value: unknown) => void; let signal!: AbortSignal;
  const setup = { status: vi.fn().mockResolvedValueOnce({ status: "ready", retryAvailable: false }).mockImplementationOnce((s: AbortSignal) => { signal = s; return new Promise(r => { resolve = r; }); }), retry: vi.fn() };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/browser-status") ? Response.json({ available: true, chrome: { present: true, minimized: false }, humanControlAvailable: true })
    : Response.json({ ticket: "a".repeat(48), expiresAt: Date.now() + 60_000 })));
  const ensureSession = vi.fn(async () => {});
  const view = render(<BrowserSurface surface="browser" gatewayUrl={gatewayUrl} ensureSession={ensureSession} setup={setup}/>);
  const frame = await screen.findByTitle("Chrome on your Matrix computer");
  fireEvent.click(screen.getByRole("button", { name: "Browser settings" })); fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
  await waitFor(() => expect(resolve).toBeTypeOf("function")); expect(screen.getByTitle("Chrome on your Matrix computer")).toBe(frame);
  fireEvent.click(screen.getByRole("button", { name: "Browser settings" })); fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
  expect(setup.status).toHaveBeenCalledTimes(2);
  view.rerender(<BrowserSurface surface="browser" gatewayUrl={changed === "runtime" ? "https://app.matrix-os.com/vm/other-computer" : gatewayUrl} active={false} ensureSession={ensureSession} setup={setup}/>);
  expect(signal.aborted).toBe(true);
  await act(async () => { resolve({ status: "failed", retryAvailable: true }); });
  expect(screen.queryByRole("button", { name: "Retry setup" })).toBeNull();
  if (changed === "runtime") expect(screen.queryByTitle("Chrome on your Matrix computer")).toBeNull();
  else {
    expect(screen.getByTitle("Chrome on your Matrix computer").hasAttribute("inert")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Browser settings" }));
    expect(screen.getByRole("button", { name: "Reconnect" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" })); expect(setup.status).toHaveBeenCalledTimes(2);
  }
  vi.unstubAllGlobals();
});

it("uses the hosted native setup bridge to recover without closing the Browser window", async () => {
  const { createHostedBrowserSetupTransport } = await import("../../packages/ui/src/browser/setup-transport");
  const { createHostedBrowserSession } = await import("../../packages/ui/src/browser/hosted-session");
  let healthy = true;
  const gatewayFetch = vi.fn(async () => ({ status: healthy ? "ready" : "failed", retryAvailable: !healthy }));
  const setup = createHostedBrowserSetupTransport({ browserSetup: true, gatewayFetch });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/browser-status") ? Response.json({ available: true, chrome: { present: true, minimized: false }, humanControlAvailable: true })
    : Response.json({ ticket: "a".repeat(48), expiresAt: Date.now() + 60_000 })));
  render(<BrowserSurface surface="browser" gatewayUrl={gatewayUrl} ensureSession={createHostedBrowserSession(async () => {})} setup={setup}/>);
  await screen.findByTitle("Chrome on your Matrix computer"); healthy = false;
  fireEvent.click(screen.getByRole("button", { name: "Browser settings" })); fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
  expect(await screen.findByRole("button", { name: "Retry setup" })).toBeTruthy();
  expect(gatewayFetch).toHaveBeenCalledTimes(2);
  expect(gatewayFetch).toHaveBeenLastCalledWith("/api/browser/setup", {}, 10_000);
});

it("does not create healthy setup polling or an automatic viewer failure recovery loop", async () => {
  vi.useFakeTimers(); vi.spyOn(console, "warn").mockImplementation(() => {}); let serviceFailed = false;
  const setup = { status: vi.fn(async () => ({ status: "ready", retryAvailable: false })), retry: vi.fn() };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/browser-status")
    ? serviceFailed ? new Response(null, { status: 503 }) : Response.json({ available: true, chrome: { present: true, minimized: false }, humanControlAvailable: true })
    : Response.json({ ticket: "a".repeat(48), expiresAt: Date.now() + 60_000 })));
  render(<BrowserSurface surface="browser" gatewayUrl={gatewayUrl} ensureSession={async () => {}} setup={setup}/>);
  await act(async () => {});
  const frame = screen.getByTitle("Chrome on your Matrix computer") as HTMLIFrameElement;
  act(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "matrix-browser-viewer", connected: true }, origin: "https://app.matrix-os.com", source: frame.contentWindow })));
  serviceFailed = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(screen.getByText("Browser unavailable")).toBeTruthy(); expect(setup.status).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Reconnect" })); await act(async () => {});
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(setup.status).toHaveBeenCalledTimes(2); expect(setup.retry).not.toHaveBeenCalled();
});
