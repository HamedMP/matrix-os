// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserChromeModelSchema, type BrowserChromeAction, type BrowserChromeModel } from "../../packages/contracts/src/browser-chrome";
import { BrowserSurface } from "../../packages/ui/src/browser/BrowserSurface";
import { BrowserTitleBarControls } from "../../packages/ui/src/browser/BrowserTitleBarControls";
import type { BrowserChromeHost } from "../../packages/ui/src/browser/types";

const gatewayUrl = "https://app.matrix-os.com/vm/pr-2526";
const ready = { available: true, chrome: { present: true, minimized: false }, humanControlAvailable: true };

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/browser-status")) return Response.json(ready);
    if (url.endsWith("/browser-session")) return Response.json({ ticket: "a".repeat(48), expiresAt: Date.now() + 60_000 });
    if (url.endsWith("/browser-control")) return Response.json(ready);
    throw new Error("Unexpected browser request");
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function host() {
  const published: Array<BrowserChromeModel | null> = [];
  let handler: ((action: BrowserChromeAction) => void) | null = null;
  const chromeHost: BrowserChromeHost = {
    publish: (model) => { published.push(model); },
    onAction: (next) => { handler = next; return () => { handler = null; }; },
  };
  return { chromeHost, published, latest: () => published.at(-1), send: (action: BrowserChromeAction) => act(() => handler?.(action)), attached: () => handler !== null };
}

async function connect() {
  const frame = await waitFor(() => { const element = document.querySelector("iframe"); expect(element).toBeTruthy(); return element as HTMLIFrameElement; });
  act(() => { window.dispatchEvent(new MessageEvent("message", { data: { type: "matrix-browser-viewer", connected: true }, origin: "https://app.matrix-os.com", source: frame.contentWindow })); });
}

describe("Browser chrome published to the window title bar", () => {
  it("gives the viewport the full height and publishes a valid title bar model instead of an inline toolbar", async () => {
    const h = host();
    render(<BrowserSurface gatewayUrl={gatewayUrl} surface="browser" ensureSession={async () => {}} chromeHost={h.chromeHost} onOpenCloudDesktop={() => {}} />);
    await connect();
    expect(document.querySelector(".matrix-browser-toolbar")).toBeNull();
    await waitFor(() => expect(h.latest()?.connection).toBe("connected"));
    const model = h.latest()!;
    expect(BrowserChromeModelSchema.safeParse(model).success).toBe(true);
    expect(model.control).toBe("You are in control");
    expect(model.actions.map((action) => action.id)).toEqual(["open-cloud-desktop", "settings"]);
  });

  it("runs title bar actions inside the surface: settings opens the panel and Cloud desktop navigates", async () => {
    const h = host();
    const open = vi.fn();
    render(<BrowserSurface gatewayUrl={gatewayUrl} surface="browser" ensureSession={async () => {}} chromeHost={h.chromeHost} onOpenCloudDesktop={open} />);
    await connect();
    h.send("settings");
    expect(screen.getByRole("region", { name: "Browser settings" })).toBeTruthy();
    await waitFor(() => expect(h.latest()?.settingsOpen).toBe(true));
    h.send("settings");
    expect(screen.queryByRole("region", { name: "Browser settings" })).toBeNull();
    h.send("open-cloud-desktop");
    expect(open).toHaveBeenCalledOnce();
  });

  it("ignores actions the current model does not offer", async () => {
    const h = host();
    const open = vi.fn();
    render(<BrowserSurface gatewayUrl={gatewayUrl} surface="desktop" ensureSession={async () => {}} chromeHost={h.chromeHost} onOpenCloudDesktop={open} />);
    await connect();
    h.send("open-cloud-desktop");
    expect(open).not.toHaveBeenCalled();
  });

  it("clears its title bar chrome and action handler when it unmounts", async () => {
    const h = host();
    const view = render(<BrowserSurface gatewayUrl={gatewayUrl} surface="browser" ensureSession={async () => {}} chromeHost={h.chromeHost} />);
    await connect();
    view.unmount();
    expect(h.latest()).toBeNull();
    expect(h.attached()).toBe(false);
  });
});

describe("BrowserTitleBarControls", () => {
  const model: BrowserChromeModel = {
    surface: "desktop", connection: "connected", control: "Agent is working", busy: false, settingsOpen: false,
    actions: [{ id: "open-files", disabled: false }, { id: "open-terminal", disabled: true }, { id: "settings", disabled: false }],
  };

  it("renders host-owned labels for each enumerated action and reports clicks", () => {
    const onAction = vi.fn();
    render(<BrowserTitleBarControls model={model} onAction={onAction} />);
    expect(screen.getByRole("status").textContent).toContain("Agent is working");
    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    expect(onAction).toHaveBeenCalledWith("open-files");
    expect(screen.getByRole("button", { name: "Terminal" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Browser settings" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("shows the connection state when the viewer is not connected", () => {
    render(<BrowserTitleBarControls model={{ ...model, connection: "disconnected", control: null, actions: [{ id: "reconnect", disabled: false }] }} onAction={() => {}} />);
    expect(screen.getByRole("status").textContent).toContain("Disconnected");
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeTruthy();
  });
});
