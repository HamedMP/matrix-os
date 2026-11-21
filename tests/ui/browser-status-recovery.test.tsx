// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserSurface } from "../../packages/ui/src/browser/BrowserSurface";
import type { BrowserStatus } from "../../packages/ui/src/browser/types";

const gatewayUrl = "https://app.matrix-os.com/vm/browser-test";
const ready: BrowserStatus = { available: true, chrome: { present: true, minimized: false }, humanControlAvailable: true };
const title = (surface: "browser" | "desktop") => surface === "browser" ? "Chrome on your Matrix computer" : "Your Matrix cloud desktop";
const automation = (revision: number, phase: "human" | "agent" = "human"): BrowserStatus => ({
  ...ready, humanControlAvailable: phase === "human",
  automation: { phase, revision, run: { chatId: "chat-1", runId: "run-1", harness: "pi" }, needsObservation: false },
});
let status: BrowserStatus;
let readStatus: () => Promise<Response>;
let ensureSession: ReturnType<typeof vi.fn>;
let requests: string[];

beforeEach(() => {
  vi.useFakeTimers();
  status = structuredClone(ready); requests = [];
  readStatus = async () => Response.json(status);
  ensureSession = vi.fn(async () => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    requests.push(String(url));
    if (String(url).endsWith("/browser-status")) return readStatus();
    if (String(url).endsWith("/browser-session")) return Response.json({ ticket: "a".repeat(48), expiresAt: Date.now() + 60_000 });
    throw new Error("Unexpected browser mutation");
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

async function tick(ms = 4000) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
function message(viewer: HTMLIFrameElement, connected = true) {
  act(() => { window.dispatchEvent(new MessageEvent("message", {
    origin: "https://app.matrix-os.com", source: viewer.contentWindow, data: { type: "matrix-browser-viewer", connected },
  })); });
}
async function mount(surface: "browser" | "desktop" = "browser") {
  const view = render(<BrowserSurface gatewayUrl={gatewayUrl} surface={surface} ensureSession={ensureSession}/>);
  await tick(0);
  const viewer = screen.getByTitle(title(surface)) as HTMLIFrameElement;
  message(viewer);
  return { view, viewer };
}
const tickets = () => requests.filter(url => url.endsWith("/browser-session"));

describe("browser status polling recovery", () => {
  it.each(["browser", "desktop"] as const)("retains the %s viewer and pauses input until a fresh status succeeds", async surface => {
    const { viewer } = await mount(surface);
    expect(viewer.hasAttribute("inert")).toBe(false);
    readStatus = async () => { throw new TypeError("Failed to fetch"); };
    await tick();
    expect(screen.queryByTitle(title(surface))).toBe(viewer);
    expect(viewer.hasAttribute("inert")).toBe(true);
    expect(viewer.tabIndex).toBe(-1);
    expect(viewer.style.pointerEvents).toBe("none");
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
    if (surface === "desktop") {
      for (const name of ["Show desktop", "Files", "Terminal", "Open Chrome"]) {
        const button = screen.getByRole("button", { name });
        expect(button.hasAttribute("disabled")).toBe(true);
        fireEvent.click(button);
      }
    }
    await tick(8000);
    expect(screen.queryByTitle(title(surface))).toBe(viewer);
    expect(viewer.hasAttribute("inert")).toBe(true);
    readStatus = async () => Response.json(status);
    await tick();
    expect(screen.getByTitle(title(surface))).toBe(viewer);
    expect(viewer.hasAttribute("inert")).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(tickets()).toHaveLength(1);
    expect(requests.every(url => /\/(browser-status|browser-session)$/.test(url))).toBe(true);
  });

  it.each(["TimeoutError", "AbortError"])("recovers a status %s without reclaiming the viewer", async name => {
    const { viewer } = await mount();
    readStatus = async () => { throw new DOMException("Request interrupted", name); };
    await tick();
    expect(screen.queryByTitle(title("browser"))).toBe(viewer);
    expect(viewer.hasAttribute("inert")).toBe(true);
    readStatus = async () => Response.json(status);
    await tick();
    expect(viewer.hasAttribute("inert")).toBe(false);
    expect(tickets()).toHaveLength(1);
  });

  it("keeps handoffs disabled and rejects an older broker revision during recovery", async () => {
    status = automation(4);
    const { viewer } = await mount();
    readStatus = async () => { throw new TypeError("Failed to fetch"); };
    await tick();
    for (const name of ["Resume agent", "Stop agent"]) {
      const button = screen.getByRole("button", { name });
      expect(button.hasAttribute("disabled")).toBe(true);
      fireEvent.click(button);
    }
    status = automation(3);
    readStatus = async () => Response.json(status);
    await tick();
    expect(viewer.hasAttribute("inert")).toBe(true);
    expect(screen.getByRole("button", { name: "Resume agent" }).hasAttribute("disabled")).toBe(true);
    status = automation(5, "agent");
    await tick();
    expect(screen.getByTitle(title("browser"))).toBe(viewer);
    expect(viewer.hasAttribute("inert")).toBe(true);
    expect(screen.getByRole("button", { name: "Take over" }).hasAttribute("disabled")).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(tickets()).toHaveLength(1);
    expect(requests.some(url => url.endsWith("/browser-automation"))).toBe(false);
  });

  it("requires a foreground status after returning during a failed poll", async () => {
    const { view, viewer } = await mount();
    readStatus = async () => { throw new TypeError("Failed to fetch"); };
    await tick();
    let finish!: (response: Response) => void;
    readStatus = () => new Promise(resolve => { finish = resolve; });
    await tick();
    view.rerender(<BrowserSurface gatewayUrl={gatewayUrl} surface="browser" ensureSession={ensureSession} active={false}/>);
    await act(async () => { finish(Response.json(status)); });
    view.rerender(<BrowserSurface gatewayUrl={gatewayUrl} surface="browser" ensureSession={ensureSession} active/>);
    expect(viewer.hasAttribute("inert")).toBe(true);
    await tick(0);
    await act(async () => { finish(Response.json(status)); });
    expect(screen.getByTitle(title("browser"))).toBe(viewer);
    expect(viewer.hasAttribute("inert")).toBe(false);
  });

  it.each([401, 403, 502, 503])("still closes immediately for an authoritative HTTP %s failure", async code => {
    await mount();
    readStatus = async () => new Response("Unavailable", { status: code });
    await tick();
    expect(screen.queryByTitle(title("browser"))).toBeNull();
    expect(screen.getByText("Browser unavailable")).toBeTruthy();
    expect(tickets()).toHaveLength(1);
  });

  it.each(["unauthorized", "oversized"])("does not mistake %s response cleanup failure for a transient status read", async failure => {
    await mount();
    readStatus = async () => new Response(new ReadableStream({
      start(stream) { if (failure === "oversized") stream.enqueue(new Uint8Array(8193)); },
      cancel() { throw new TypeError("Connection failed during response cleanup"); },
    }), { status: failure === "unauthorized" ? 401 : 200 });
    await tick();
    expect(screen.queryByTitle(title("browser"))).toBeNull();
    expect(screen.getByText("Browser unavailable")).toBeTruthy();
  });

  it.each(["unavailable", "invalid status", "invalid JSON"])("still closes for %s after a transient failure", async failure => {
    await mount();
    readStatus = async () => { throw new TypeError("Failed to fetch"); };
    await tick();
    readStatus = async () => failure === "unavailable" ? Response.json({ ...ready, available: false })
      : failure === "invalid status" ? Response.json({ available: true }) : new Response("invalid JSON");
    await tick();
    expect(screen.queryByTitle(title("browser"))).toBeNull();
    expect(screen.getByText("Browser unavailable")).toBeTruthy();
  });

  it("does not preserve a viewer when owner session renewal fails", async () => {
    await mount();
    ensureSession.mockRejectedValueOnce(new TypeError("Session renewal failed"));
    await tick(60_000);
    expect(screen.queryByTitle(title("browser"))).toBeNull();
    expect(screen.getByText("Browser unavailable")).toBeTruthy();
    expect(tickets()).toHaveLength(1);
  });

  it.each([false, true])("fails closed for network failure before viewer acknowledgement (ticket issued: %s)", async issued => {
    if (!issued) readStatus = async () => { throw new TypeError("Admission failed"); };
    render(<BrowserSurface gatewayUrl={gatewayUrl} surface="browser" ensureSession={ensureSession}/>);
    await tick(0);
    if (issued) {
      expect(screen.getByTitle(title("browser")).hasAttribute("inert")).toBe(true);
      readStatus = async () => { throw new TypeError("Status unavailable before handshake"); };
      await tick();
    }
    expect(screen.queryByTitle(title("browser"))).toBeNull();
    expect(screen.getByText("Browser unavailable")).toBeTruthy();
  });

  it("does not preserve a viewer that actually disconnects during status recovery", async () => {
    const { viewer } = await mount();
    readStatus = async () => { throw new TypeError("Failed to fetch"); };
    await tick();
    message(viewer, false);
    expect(screen.queryByTitle(title("browser"))).toBeNull();
    expect(screen.getByText("Connection ended")).toBeTruthy();
    readStatus = async () => Response.json(status);
    await tick();
    expect(screen.queryByTitle(title("browser"))).toBeNull();
    expect(tickets()).toHaveLength(1);
  });
});
