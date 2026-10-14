// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserSurface } from "../../packages/ui/src/browser/BrowserSurface";
import { useBrowserSurface } from "../../packages/ui/src/browser/use-browser-surface";
import { createHostedBrowserSession } from "../../packages/ui/src/browser/hosted-session";

const gatewayUrl = "https://app.matrix-os.com/vm/pr-2526";
const ready = { available: true, chrome: { present: true, minimized: false }, humanControlAvailable: true };
let status = ready;
let calls: Array<{ url: string; init?: RequestInit }>;
let ensureSession: ReturnType<typeof vi.fn>;
let ticketNumber = 0;
beforeEach(() => {
  status = structuredClone(ready); calls = []; ticketNumber = 0;
  ensureSession = vi.fn(async () => {});
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (url.endsWith("/browser-status")) return Response.json(status);
    if (url.endsWith("/browser-session")) return Response.json({ ticket: (++ticketNumber).toString(16).padStart(48, "a"), expiresAt: Date.now() + 60_000 });
    if (url.endsWith("/browser-control")) { status = structuredClone(ready); return Response.json(status); }
    throw new Error("Unexpected browser request");
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
function mount(extra: Record<string, unknown> = {}) { return render(<BrowserSurface gatewayUrl={gatewayUrl} surface="browser" ensureSession={ensureSession} {...extra} />); }
function message(frame: HTMLIFrameElement, data: unknown = { type: "matrix-browser-viewer", connected: true }, origin = "https://app.matrix-os.com", source: MessageEventSource | null = frame.contentWindow) {
  act(() => { window.dispatchEvent(new MessageEvent("message", { data, origin, source })); });
}
async function frame() { return await screen.findByTitle("Chrome on your Matrix computer") as HTMLIFrameElement; }

describe("shared Chrome-first surface", () => {
  it.each(["browser", "desktop"] as const)("renews invalidated hosted %s admission on explicit reconnect before retrying viewer requests", async surface => {
    let cookieValid = true;
    let release!: () => void;
    let renewals = 0;
    const renew = vi.fn(() => {
      renewals++;
      if (renewals !== 2) { cookieValid = true; return Promise.resolve(); }
      return new Promise<void>(resolve => { release = () => { cookieValid = true; resolve(); }; });
    });
    ensureSession = vi.fn(createHostedBrowserSession(renew, () => 0));
    const normal = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => !cookieValid
      ? new Response("Unavailable", { status: 401 }) : normal(url as string, init));
    const view = mount({ surface });
    const title = surface === "browser" ? "Chrome on your Matrix computer" : "Your Matrix cloud desktop";
    const previous = await screen.findByTitle(title) as HTMLIFrameElement;
    message(previous);
    cookieValid = false;
    message(previous, { type: "matrix-browser-viewer", connected: false });
    const beforeReconnect = vi.mocked(fetch).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(renew).toHaveBeenCalledTimes(2));
    expect(vi.mocked(fetch).mock.calls).toHaveLength(beforeReconnect);
    expect(screen.queryByTitle(title)).toBeNull();
    await act(async () => { release(); });
    const next = await screen.findByTitle(title) as HTMLIFrameElement;
    expect(next).not.toBe(previous);
    expect(next.hasAttribute("inert")).toBe(true);
    message(next); expect(next.hasAttribute("inert")).toBe(false);

    view.rerender(<BrowserSurface gatewayUrl={gatewayUrl} surface={surface} active={false} ensureSession={ensureSession} />);
    view.rerender(<BrowserSurface gatewayUrl={gatewayUrl} surface={surface} active ensureSession={ensureSession} />);
    await screen.findByTitle(title);
    expect(renew).toHaveBeenCalledTimes(3);
  });

  it("disables all native desktop commands before handshake, during read-only, and after revocation", async () => {
    status = { ...ready, humanControlAvailable: false };
    mount({ surface: "desktop" });
    const viewer = await screen.findByTitle("Your Matrix cloud desktop") as HTMLIFrameElement;
    const assertDisabled = () => { for (const name of ["Show desktop", "Files", "Terminal", "Open Chrome"]) expect(screen.getByRole("button", { name }).hasAttribute("disabled")).toBe(true); };
    assertDisabled(); message(viewer); assertDisabled();
    message(viewer, { type: "matrix-browser-viewer", connected: false }); assertDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    expect(calls.some(call => call.url.endsWith("/browser-control"))).toBe(false);
  });
  it("disables Chrome settings and minimized recovery before acknowledged connection", async () => {
    status = { ...ready, chrome: { present: true, minimized: true } };
    mount(); await frame(); fireEvent.click(screen.getByRole("button", { name: "Browser settings" }));
    expect(screen.getAllByRole("button", { name: "Restore Chrome" }).every(button => button.hasAttribute("disabled"))).toBe(true);
  });
  it("rejects direct controls while disconnected, and after disconnect during session renewal", async () => {
    const hook = renderHook(() => useBrowserSurface({ gatewayUrl, surface: "desktop", ensureSession }));
    await waitFor(() => expect(hook.result.current.state.viewerUrl).not.toBe(""));
    await act(async () => expect(await hook.result.current.control("open-files")).toBe(false));
    const element = document.createElement("iframe"); element.src = hook.result.current.state.viewerUrl; document.body.append(element);
    hook.result.current.iframe.current = element;
    try {
      message(element); await waitFor(() => expect(hook.result.current.state.connection).toBe("connected"));
      let release!: () => void; ensureSession.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
      let pending!: Promise<boolean>; act(() => { pending = hook.result.current.control("open-files"); });
      message(element, { type: "matrix-browser-viewer", connected: false });
      await act(async () => { release(); expect(await pending).toBe(false); });
      expect(calls.some(call => call.url.endsWith("/browser-control"))).toBe(false);
    } finally { element.remove(); }
  });
  it("ensures the owner session before claiming the fixed product viewer", async () => {
    let release!: () => void;
    ensureSession.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    mount(); expect(calls).toHaveLength(0);
    await act(async () => { release(); });
    const viewer = await frame();
    const url = new URL(viewer.src);
    expect(url.origin).toBe("https://app.matrix-os.com");
    expect(url.pathname).toBe("/vm/pr-2526/apps/browser-lab/viewer/");
    expect(url.searchParams.get("resize")).toBe("remote");
    expect(url.searchParams.get("matrix_product")).toBe("1");
    expect(url.searchParams.get("path")).toMatch(/^vm\/pr-2526\/apps\/browser-lab\/viewer\/websockify\?lab_ticket=[a-f0-9]{48}$/);
    expect(calls.find(call => call.url.endsWith("/browser-session"))?.init?.body).toBe('{"surface":"browser"}');
    expect(calls.every(call => call.url.startsWith(`${gatewayUrl}/apps/browser-lab/api/`))).toBe(true);
    expect(calls.some(call => call.url.endsWith("/browser-control"))).toBe(false);
  });
  it("does not report connected or permit input from iframe load alone", async () => {
    mount(); const viewer = await frame(); fireEvent.load(viewer);
    expect(viewer.hasAttribute("inert")).toBe(true);
    expect(screen.queryByText("Connected")).toBeNull();
    message(viewer);
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(viewer.hasAttribute("inert")).toBe(false);
    expect(screen.queryByText("Run comparison")).toBeNull();
    expect(screen.queryByText("agent-browser")).toBeNull();
    expect(screen.queryByText(/\/10 actions/)).toBeNull();
  });
  it("retains the connecting iframe when the installed client first reports not connected", async () => {
    mount(); const viewer = await frame();
    message(viewer, { type: "matrix-browser-viewer", connected: false });
    expect(screen.getByTitle("Chrome on your Matrix computer")).toBe(viewer);
    expect(viewer.hasAttribute("inert")).toBe(true);
    message(viewer); expect(viewer.hasAttribute("inert")).toBe(false);
  });
  it("keeps the connected toolbar focused on the viewport and places recovery in settings", async () => {
    const open = vi.fn(); mount({ onOpenCloudDesktop: open }); const viewer = await frame(); message(viewer);
    expect(screen.queryByRole("button", { name: "Restore Chrome" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cloud desktop" })); expect(open).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Browser settings" }));
    expect(screen.getByRole("button", { name: "Restore Chrome" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeTruthy();
  });
  it("light dismisses settings and restores focus to its trigger", async () => {
    mount(); await frame();
    const trigger = screen.getByRole("button", { name: "Browser settings" });
    fireEvent.click(trigger);
    expect(screen.getByRole("region", { name: "Browser settings" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close browser settings" })).toBe(document.activeElement);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Browser settings" })).toBeNull();
    expect(trigger).toBe(document.activeElement);
    fireEvent.click(trigger);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("region", { name: "Browser settings" })).toBeNull();
    expect(trigger).toBe(document.activeElement);
    fireEvent.click(trigger);
    fireEvent.focusIn(document.body);
    expect(screen.queryByRole("region", { name: "Browser settings" })).toBeNull();
  });
  it("rejects messages with the wrong source, origin or payload", async () => {
    mount(); const viewer = await frame();
    message(viewer, undefined, "https://attacker.test");
    message(viewer, undefined, "https://app.matrix-os.com", window);
    message(viewer, { type: "matrix-browser-viewer", connected: true, inputs: "private" });
    message(viewer, { type: "matrix-browser-viewer", connected: "true" });
    message(viewer, { type: "other", connected: true });
    expect(viewer.hasAttribute("inert")).toBe(true);
    expect(screen.queryByText("Connected")).toBeNull();
  });
  it("keeps input gated when the acknowledged owner status forbids it", async () => {
    status = { ...ready, humanControlAvailable: false };
    mount(); const viewer = await frame(); message(viewer);
    expect(viewer.hasAttribute("inert")).toBe(true);
    expect(screen.getByText("Read only")).toBeTruthy();
  });
  it("requires explicit reconnect after a stream disconnect and rejects messages from the retired iframe", async () => {
    mount(); const previous = await frame(); message(previous);
    const previousSource = previous.contentWindow;
    message(previous, { type: "matrix-browser-viewer", connected: false });
    expect(screen.getByText("Disconnected")).toBeTruthy();
    expect(screen.queryByTitle("Chrome on your Matrix computer")).toBeNull();
    expect(ticketNumber).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    const next = await frame(); expect(next).not.toBe(previous); expect(ticketNumber).toBe(2);
    message(next, undefined, "https://app.matrix-os.com", previousSource);
    expect(next.hasAttribute("inert")).toBe(true);
    message(next); expect(next.hasAttribute("inert")).toBe(false);
  });
  it("removes the stream while inactive and reacquires it when activated", async () => {
    const view = mount(); const previous = await frame(); message(previous);
    view.rerender(<BrowserSurface gatewayUrl={gatewayUrl} surface="browser" active={false} ensureSession={ensureSession} />);
    expect(screen.queryByTitle("Chrome on your Matrix computer")).toBeNull();
    expect(ticketNumber).toBe(1);
    view.rerender(<BrowserSurface gatewayUrl={gatewayUrl} surface="browser" active ensureSession={ensureSession} />);
    const next = await frame(); expect(next).not.toBe(previous); expect(ticketNumber).toBe(2);
  });
  it("checks the owner session again soon after returning to an existing cookie", async () => {
    const view = mount(); const previous = await frame(); message(previous);
    view.rerender(<BrowserSurface gatewayUrl={gatewayUrl} surface="browser" active={false} ensureSession={ensureSession} />);
    vi.useFakeTimers({ now: 4 * 60_000 });
    view.rerender(<BrowserSurface gatewayUrl={gatewayUrl} surface="browser" active ensureSession={ensureSession} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(ensureSession).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(ensureSession.mock.calls.length).toBeGreaterThan(2);
  });
  it("ignores late claims and aborts their requests after deactivation", async () => {
    const normal = vi.mocked(fetch).getMockImplementation()!;
    let release!: (response: Response) => void; let signal: AbortSignal | undefined;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).endsWith("/browser-session")) { signal = init?.signal as AbortSignal; return new Promise<Response>(resolve => { release = resolve; }); }
      return normal(url as string, init);
    });
    const view = mount(); await waitFor(() => expect(release).toBeTypeOf("function"));
    view.rerender(<BrowserSurface gatewayUrl={gatewayUrl} surface="browser" active={false} ensureSession={ensureSession} />);
    expect(signal?.aborted).toBe(true);
    await act(async () => { release(Response.json({ ticket: "a".repeat(48), expiresAt: Date.now() + 60_000 })); });
    expect(screen.queryByTitle("Chrome on your Matrix computer")).toBeNull();
  });
  it("restores minimized Chrome through the fixed action and supports retry after failure", async () => {
    status = { ...ready, chrome: { present: true, minimized: true } };
    const normal = vi.mocked(fetch).getMockImplementation()!; let failed = false;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).endsWith("/browser-control") && !failed) { failed = true; return new Response("private provider failure", { status: 503 }); }
      return normal(url as string, init);
    });
    mount(); const viewer = await frame(); message(viewer);
    expect(screen.getByText("Chrome is minimized")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Restore Chrome" })[0]!);
    const error = await screen.findByRole("alert"); expect(error.textContent).not.toContain("private");
    fireEvent.click(screen.getAllByRole("button", { name: "Restore Chrome" })[0]!);
    await waitFor(() => expect(screen.queryByText("Chrome is minimized")).toBeNull());
    expect(calls.find(call => call.url.endsWith("/browser-control"))?.init?.body).toBe('{"action":"restore-chrome"}');
  });
  it("keeps unavailable services explicit without silently opening another browser", async () => {
    status = { ...ready, available: false };
    mount(); await screen.findByText("Browser unavailable");
    expect(screen.queryByTitle("Chrome on your Matrix computer")).toBeNull();
    expect(ticketNumber).toBe(0);
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeTruthy();
  });
  it("uses the same viewer with fixed desktop actions and no simulated app content", async () => {
    render(<BrowserSurface gatewayUrl={gatewayUrl} surface="desktop" ensureSession={ensureSession} />);
    const viewer = await screen.findByTitle("Your Matrix cloud desktop") as HTMLIFrameElement; message(viewer);
    for (const [name, action] of [["Show desktop", "show-desktop"], ["Files", "open-files"], ["Terminal", "open-terminal"], ["Open Chrome", "restore-chrome"]]) {
      fireEvent.click(screen.getByRole("button", { name }));
      await waitFor(() => expect(calls.some(call => call.init?.body === JSON.stringify({ action }))).toBe(true));
      await waitFor(() => expect(screen.getByRole("button", { name }).hasAttribute("disabled")).toBe(false));
    }
    expect(calls.find(call => call.url.endsWith("/browser-session"))?.init?.body).toBe('{"surface":"desktop"}');
    expect(screen.queryByText("Run comparison")).toBeNull();
  });
});


describe("long-lived browser viewer renewal", () => {
  const gatewayUrl = "https://app.matrix-os.com/vm/pr-2526";
  const ready = { available: true, chrome: { present: true, minimized: false }, humanControlAvailable: true };
  let ensureSession: ReturnType<typeof vi.fn>;
  let claims: number;
  const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
  const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  function message(frame: HTMLIFrameElement, source: MessageEventSource | null = frame.contentWindow) {
    act(() => { window.dispatchEvent(new MessageEvent("message", { origin: "https://app.matrix-os.com", source,
      data: { type: "matrix-browser-viewer", connected: true } })); });
  }
  function mount(surface: "browser" | "desktop" = "browser") {
    return render(<BrowserSurface gatewayUrl={gatewayUrl} surface={surface} ensureSession={ensureSession} />);
  }
  const frame = (surface: "browser" | "desktop" = "browser") => screen.getByTitle(surface === "browser" ? "Chrome on your Matrix computer" : "Your Matrix cloud desktop") as HTMLIFrameElement;
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 }); claims = 0; ensureSession = vi.fn(async () => {});
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async url => {
      if (String(url).endsWith("/browser-status")) return Response.json(ready);
      if (String(url).endsWith("/browser-session")) return Response.json({ ticket: (++claims).toString(16).padStart(48, "a"), expiresAt: Date.now() + 60_000 });
      if (String(url).endsWith("/browser-control")) return Response.json(ready);
      throw new Error("Unexpected request");
    }));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

  it.each(["browser", "desktop"] as const)("renews the %s stream before ten minutes and waits for a new handshake", async surface => {
    mount(surface); await flush(); const previous = frame(surface); message(previous);
    const retiredSource = previous.contentWindow;
    await advance(8 * 60_000);
    expect(claims).toBe(2);
    const renewed = frame(surface); expect(renewed).not.toBe(previous);
    expect(renewed.hasAttribute("inert")).toBe(true);
    expect(ensureSession.mock.calls.filter(call => call[1]?.force === true)).toHaveLength(2);
    message(renewed, retiredSource); expect(renewed.hasAttribute("inert")).toBe(true);
    message(renewed); expect(renewed.hasAttribute("inert")).toBe(false);
    await advance(3 * 60_000); expect(screen.getByText("Connected")).toBeTruthy();
    await advance(5 * 60_000); expect(claims).toBe(3);
    expect(frame(surface).hasAttribute("inert")).toBe(true);
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/browser-control") || String(url).endsWith("/browser-automation"))).toBe(false);
  });
  it("forces renewal before opening a stream even when a cached owner session was just checked", async () => {
    mount(); await flush(); message(frame());
    ensureSession.mockClear();
    await advance(8 * 60_000);
    expect(ensureSession).toHaveBeenLastCalledWith(expect.any(AbortSignal), { force: true });
    expect(claims).toBe(2);
  });
  it("keeps input blocked and stops automatic claims after a failed replacement", async () => {
    const normal = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => String(url).endsWith("/browser-session") && claims === 1
      ? new Response("private failure", { status: 503 }) : normal(url, init));
    mount(); await flush(); message(frame());
    await advance(8 * 60_000);
    expect(screen.queryByTitle("Chrome on your Matrix computer")).toBeNull();
    expect(screen.getByText("Browser unavailable")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).not.toContain("private");
    const requestCount = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/browser-session")).length;
    await advance(3 * 60_000);
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/browser-session"))).toHaveLength(requestCount);
  });
  it("retires the old stream when forced authentication renewal fails", async () => {
    mount(); await flush(); const retired = frame(); message(retired);
    ensureSession.mockImplementation(async (_signal, options) => {
      if (options?.force) throw new Error("private authentication failure");
    });
    await advance(8 * 60_000);
    expect(claims).toBe(1);
    expect(screen.queryByTitle("Chrome on your Matrix computer")).toBeNull();
    expect(screen.getByText("Browser unavailable")).toBeTruthy();
    message(retired); expect(screen.queryByText("Connected")).toBeNull();
  });
  it("periodically observes an ongoing Chat without taking over or granting human input", async () => {
    const normal = vi.mocked(fetch).getMockImplementation()!;
    const agent = { ...ready, humanControlAvailable: false, automation: {
      phase: "agent", revision: 4, run: { chatId: "chat_qa", runId: "run_qa", harness: "pi" }, needsObservation: false,
    } };
    vi.mocked(fetch).mockImplementation(async (url, init) => String(url).endsWith("/browser-status") ? Response.json(agent) : normal(url, init));
    mount(); await flush(); message(frame());
    await advance(8 * 60_000); expect(claims).toBe(2);
    const renewed = frame(); message(renewed);
    expect(renewed.hasAttribute("inert")).toBe(true);
    expect(screen.getByText("Agent is working")).toBeTruthy();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/browser-control") || String(url).endsWith("/browser-automation"))).toBe(false);
  });
  it("aborts a pending replacement when hidden and ignores its late admission", async () => {
    const normal = vi.mocked(fetch).getMockImplementation()!;
    let release!: (response: Response) => void; let signal!: AbortSignal;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).endsWith("/browser-session") && claims === 1) {
        signal = init!.signal!; return await new Promise<Response>(resolve => { release = resolve; });
      }
      return normal(url, init);
    });
    const view = mount(); await flush(); message(frame());
    await advance(8 * 60_000); expect(release).toBeTypeOf("function");
    view.rerender(<BrowserSurface gatewayUrl={gatewayUrl} surface="browser" active={false} ensureSession={ensureSession} />);
    expect(signal.aborted).toBe(true);
    await act(async () => { release(Response.json({ ticket: "b".repeat(48), expiresAt: Date.now() + 60_000 })); });
    expect(screen.queryByTitle("Chrome on your Matrix computer")).toBeNull();
    await advance(10 * 60_000); expect(claims).toBe(1);
  });
  it("defers stream replacement until an in-flight owner mutation settles", async () => {
    const normal = vi.mocked(fetch).getMockImplementation()!;
    let release!: (response: Response) => void;
    vi.mocked(fetch).mockImplementation(async (url, init) => String(url).endsWith("/browser-control")
      ? new Promise<Response>(resolve => { release = resolve; }) : normal(url, init));
    mount("desktop"); await flush(); message(frame("desktop"));
    await advance(8 * 60_000 - 4000);
    fireEvent.click(screen.getByRole("button", { name: "Files" })); await flush();
    await advance(4000); expect(claims).toBe(1);
    await act(async () => { release(Response.json(ready)); });
    await advance(4000); expect(claims).toBe(2);
    expect(frame("desktop").hasAttribute("inert")).toBe(true);
  });
});
