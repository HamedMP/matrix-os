// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserSurface } from "../../packages/ui/src/browser/BrowserSurface";
import { useBrowserSurface } from "../../packages/ui/src/browser/use-browser-surface";
import { browserStatus } from "../../packages/ui/src/browser/transport";

const gatewayUrl = "https://app.matrix-os.com/vm/pr-2526";
const run = { chatId: "chat-1", runId: "run-1", harness: "pi" };
const status = (phase: string, revision: number, human = false) => ({
  available: true, chrome: { present: true, minimized: false }, humanControlAvailable: human,
  automation: { phase, revision, run: phase === "idle" ? null : run, needsObservation: phase === "resuming" },
});
let currentStatus: ReturnType<typeof status>;
let ensureSession: ReturnType<typeof vi.fn>;
let requests: Array<{ url: string; init?: RequestInit }>;
let mutate: (action: string) => Promise<Response>;
beforeEach(() => {
  currentStatus = status("agent", 1); requests = []; ensureSession = vi.fn(async () => {});
  mutate = async action => {
    currentStatus = status(action === "takeover" ? "human" : action === "pause" ? "paused" : action === "stop" ? "idle" : "agent", currentStatus.automation.revision + 1, action === "takeover" || action === "stop");
    return Response.json(currentStatus);
  };
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith("/browser-status")) return Response.json(currentStatus);
    if (String(url).endsWith("/browser-session")) return Response.json({ ticket: "a".repeat(48), expiresAt: Date.now() + 60_000 });
    if (String(url).endsWith("/browser-automation")) return mutate(JSON.parse(String(init?.body)).action);
    throw new Error("Unexpected request");
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
function message(viewer: HTMLIFrameElement) {
  act(() => window.dispatchEvent(new MessageEvent("message", { origin: "https://app.matrix-os.com", source: viewer.contentWindow, data: { type: "matrix-browser-viewer", connected: true } })));
}
async function mount(surface: "browser" | "desktop" = "browser") {
  const view = render(<BrowserSurface gatewayUrl={gatewayUrl} surface={surface} ensureSession={ensureSession}/>);
  const viewer = await screen.findByTitle(surface === "browser" ? "Chrome on your Matrix computer" : "Your Matrix cloud desktop") as HTMLIFrameElement;
  message(viewer); return { view, viewer };
}
const actionCalls = () => requests.filter(request => request.url.endsWith("/browser-automation"));

describe("shared Chrome owner handoff", () => {
  it.each(["browser", "desktop"] as const)("observes an agent on %s without covering the preview or enabling input", async surface => {
    const { viewer } = await mount(surface);
    expect(screen.getByText("Agent is working")).toBeTruthy();
    expect(viewer.hasAttribute("inert")).toBe(true);
    expect(screen.queryByText("This view is read only")).toBeNull();
    expect(screen.getByRole("button", { name: "Take over" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pause agent" })).toBeTruthy();
    expect(actionCalls()).toHaveLength(0);
  });
  it("offers explicit owner recovery when an idle viewer has not acknowledged human input", async () => {
    currentStatus = status("idle", 0);
    mutate = async () => Response.json(status("idle", 1, true));
    const { viewer } = await mount();
    expect(viewer.hasAttribute("inert")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Take control" }));
    await screen.findByText("You are in control");
    expect(viewer.hasAttribute("inert")).toBe(false);
    expect(actionCalls()).toHaveLength(1);
    expect(actionCalls()[0]?.init?.body).toBe('{"action":"takeover"}');
  });
  it("drains takeover before granting input, then resumes on the same viewer", async () => {
    let finish!: (response: Response) => void;
    mutate = async () => new Promise<Response>(resolve => { finish = resolve; });
    const { viewer } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Take over" }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(screen.getByText("Taking over…")).toBeTruthy();
    expect(viewer.hasAttribute("inert")).toBe(true);
    expect(screen.getByRole("button", { name: "Take over" }).hasAttribute("disabled")).toBe(true);
    await act(async () => { currentStatus = status("human", 2, true); finish(Response.json(currentStatus)); });
    expect(screen.getByText("You are in control")).toBeTruthy();
    expect(viewer.hasAttribute("inert")).toBe(false);
    mutate = async () => Response.json(status("agent", 3));
    fireEvent.click(screen.getByRole("button", { name: "Resume agent" }));
    await screen.findByText("Agent is working");
    expect(viewer.hasAttribute("inert")).toBe(true);
    expect(screen.getByTitle("Chrome on your Matrix computer")).toBe(viewer);
    expect(actionCalls().map(call => JSON.parse(String(call.init?.body)).action)).toEqual(["takeover", "resume"]);
    expect(requests.filter(call => call.url.endsWith("/browser-session"))).toHaveLength(1);
  });
  it("pauses in read-only mode and permits an explicit takeover or resume", async () => {
    const { viewer } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Pause agent" }));
    await screen.findByText("Agent paused");
    expect(viewer.hasAttribute("inert")).toBe(true);
    expect(screen.getByRole("button", { name: "Resume agent" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Take over" }));
    await screen.findByText("You are in control");
    expect(viewer.hasAttribute("inert")).toBe(false);
  });
  it("stops the bound agent and keeps Chrome available", async () => {
    const { viewer } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Stop agent" }));
    await screen.findByText("You are in control");
    expect(screen.queryByRole("button", { name: "Stop agent" })).toBeNull();
    expect(screen.getByTitle("Chrome on your Matrix computer")).toBe(viewer);
    expect(viewer.hasAttribute("inert")).toBe(false);
  });
  it("keeps input blocked after failed takeover and displays only safe retry copy", async () => {
    mutate = async () => new Response("private token provider database failure", { status: 503 });
    const { viewer } = await mount(); fireEvent.click(screen.getByRole("button", { name: "Take over" }));
    const error = await screen.findByRole("alert");
    expect(error.textContent).toBe("Browser control could not be changed. Try again.");
    expect(viewer.hasAttribute("inert")).toBe(true);
    expect(screen.getByRole("button", { name: "Take over" }).hasAttribute("disabled")).toBe(false);
  });
  it.each(["pausing", "resuming", "unavailable"])("disables handoffs while the broker is %s", async phase => {
    currentStatus = status(phase, 1);
    const { viewer } = await mount();
    expect(viewer.hasAttribute("inert")).toBe(true);
    expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Take over" })?.hasAttribute("disabled") ?? true).toBe(true);
  });
  it("rejects a stale owner response without reopening input", async () => {
    currentStatus = status("agent", 4);
    mutate = async () => Response.json(status("human", 3, true));
    const { viewer } = await mount(); fireEvent.click(screen.getByRole("button", { name: "Take over" }));
    await screen.findByRole("alert"); expect(viewer.hasAttribute("inert")).toBe(true);
    expect(screen.getByText("Agent is working")).toBeTruthy();
  });
  it("abandons an automation action during session renewal after deactivation", async () => {
    const hook = renderHook(({ active }) => useBrowserSurface({ gatewayUrl, surface: "browser", ensureSession, active }), { initialProps: { active: true } });
    await waitFor(() => expect(hook.result.current.state.viewerUrl).not.toBe(""));
    const viewer = document.createElement("iframe"); viewer.src = hook.result.current.state.viewerUrl; document.body.append(viewer); hook.result.current.iframe.current = viewer;
    try {
      message(viewer);
      let release!: () => void;
      ensureSession.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
      let pending!: Promise<boolean>;
      act(() => { pending = hook.result.current.automationControl("takeover"); });
      hook.rerender({ active: false });
      await act(async () => { release(); expect(await pending).toBe(false); });
      expect(actionCalls()).toHaveLength(0);
      expect(hook.result.current.state.connection).toBe("inactive");
    } finally { viewer.remove(); }
  });
  it("ignores a late handoff response after reconnection", async () => {
    let finish!: (response: Response) => void; mutate = async () => new Promise<Response>(resolve => { finish = resolve; });
    const hook = renderHook(() => useBrowserSurface({ gatewayUrl, surface: "browser", ensureSession }));
    await waitFor(() => expect(hook.result.current.state.viewerUrl).not.toBe(""));
    const viewer = document.createElement("iframe"); viewer.src = hook.result.current.state.viewerUrl; document.body.append(viewer); hook.result.current.iframe.current = viewer;
    try {
      message(viewer); let pending!: Promise<boolean>;
      act(() => { pending = hook.result.current.automationControl("takeover"); });
      await waitFor(() => expect(finish).toBeTypeOf("function"));
      act(() => hook.result.current.reconnect());
      await waitFor(() => expect(hook.result.current.state.viewerUrl).not.toBe(""));
      await act(async () => { finish(Response.json(status("human", 2, true))); expect(await pending).toBe(false); });
      expect(hook.result.current.state.status?.automation?.phase).toBe("agent");
      expect(hook.result.current.state.status?.humanControlAvailable).toBe(false);
    } finally { viewer.remove(); }
  });
  it("polls authoritative handoff state without rolling back to an older revision", async () => {
    let poll!: () => void;
    const original = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay?: number) => {
      if (delay === 4000) { poll = callback; return original(() => {}, 1_000_000); }
      return original(callback, delay);
    }) as typeof setTimeout);
    const { viewer } = await mount();
    currentStatus = status("paused", 3);
    await act(async () => { poll(); });
    await screen.findByText("Agent paused");
    currentStatus = status("human", 2, true);
    await act(async () => { poll(); });
    expect(screen.getByText("Agent paused")).toBeTruthy();
    expect(viewer.hasAttribute("inert")).toBe(true);
    currentStatus = status("human", 4, true);
    await act(async () => { poll(); });
    await screen.findByText("You are in control");
    expect(viewer.hasAttribute("inert")).toBe(false);
  });
  it("does not grant input back when resume fails from a human session", async () => {
    currentStatus = status("human", 2, true);
    mutate = async () => new Response("private failure", { status: 503 });
    const { viewer } = await mount(); expect(viewer.hasAttribute("inert")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Resume agent" }));
    await screen.findByRole("alert"); expect(viewer.hasAttribute("inert")).toBe(true);
    expect(screen.getByText("Read only")).toBeTruthy();
  });
  it("fails closed if viewer admission returns an older broker revision", async () => {
    let checks = 0;
    const normal = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).endsWith("/browser-status")) return Response.json(++checks === 1 ? status("agent", 4) : status("human", 3, true));
      return normal(url, init);
    });
    render(<BrowserSurface gatewayUrl={gatewayUrl} surface="browser" ensureSession={ensureSession}/>);
    await screen.findByText("Browser unavailable");
    expect(screen.queryByTitle("Chrome on your Matrix computer")).toBeNull();
    expect(screen.queryByText("You are in control")).toBeNull();
  });
  it("ignores a failed polling request started before an acknowledged takeover", async () => {
    let poll!: () => void;
    const original = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay?: number) => {
      if (delay === 4000) { poll = callback; return original(() => {}, 1_000_000); }
      return original(callback, delay);
    }) as typeof setTimeout);
    const { viewer } = await mount();
    let reject!: (error: Error) => void;
    const normal = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>((_resolve, rejectPromise) => { reject = rejectPromise; }));
    await act(async () => { poll(); });
    await waitFor(() => expect(reject).toBeTypeOf("function"));
    vi.mocked(fetch).mockImplementation(normal);
    fireEvent.click(screen.getByRole("button", { name: "Take over" }));
    await screen.findByText("You are in control");
    await act(async () => { reject(new Error("old polling failure")); });
    expect(screen.getByTitle("Chrome on your Matrix computer")).toBe(viewer);
    expect(viewer.hasAttribute("inert")).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("validates bounded automation status and remains compatible with older servers", () => {
    expect(browserStatus(status("agent", 1))).toEqual(status("agent", 1));
    expect(() => browserStatus(status("unknown", 1))).toThrow();
    expect(() => browserStatus(status("agent", -1))).toThrow();
    expect(() => browserStatus({ ...status("agent", 1), automation: { ...status("agent", 1).automation, run: { ...run, chatId: "x".repeat(1000) } } })).toThrow();
    const legacy = { available: true, chrome: { present: true, minimized: false }, humanControlAvailable: true };
    expect(browserStatus(legacy)).toEqual(legacy);
  });
});
