// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GettingStartedVisibilityProvider, useGettingStartedBlocker } from "../../packages/ui/src/getting-started-visibility";
import { GettingStartedPopover as WebCard, webGettingStartedAutoOpenKey } from "../../shell/src/components/onboarding/GettingStartedPopover";
import ElectronCard, { gettingStartedAutoOpenKey } from "../../desktop/src/renderer/src/features/onboarding/GettingStartedPopover";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";

function Blocker({ active }: { active: boolean }) { useGettingStartedBlocker(active); return <input aria-label="Overlay search" />; }
const callbacks = { onOpenSettings: vi.fn(), onOpenFirstWork: vi.fn() };
const data = (path: string) => path.includes("github/status") ? { installed: true, authenticated: false, user: null } : path.includes("credentials/status") ? { agents: [] } : path.includes("projects") ? { projects: [] } : path.includes("chats") ? { items: [] } : path.includes("billing") ? { access: { runtimeProxyAllowed: false } } : [];
function Scene({ electron, active = false, presentation = "desktop" }: { electron: boolean; active?: boolean; presentation?: string }) {
  return <GettingStartedVisibilityProvider scope="test"><Blocker active={active} />{electron ? <ElectronCard key={presentation} /> : <WebCard key={presentation} {...callbacks} />}</GettingStartedVisibilityProvider>;
}
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => new Response(JSON.stringify(data(String(input)))));
  useConnection.setState({ status: "signed-in", handle: "neo", runtimeSlot: "primary", authGeneration: 1, api: { get: vi.fn(async (path: string) => data(path)), forRuntime() { return this; } } as never });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
for (const electron of [false, true]) describe(electron ? "Electron checklist" : "web checklist", () => {
  const key = electron ? gettingStartedAutoOpenKey("neo", "primary") : webGettingStartedAutoOpenKey("/");
  it("yields to overlays and restores without taking focus", async () => {
    localStorage.setItem(key, "1");
    const view = render(<Scene electron={electron} />);
    fireEvent.click(await screen.findByRole("button", { name: /Getting started/ }));
    await screen.findByRole("dialog", { name: "Getting started" });
    view.rerender(<Scene electron={electron} active />);
    const search = screen.getByRole("textbox");
    act(() => search.focus());
    expect(screen.queryByRole("dialog", { name: "Getting started" })).toBeNull();
    expect((screen.getByRole("button", { name: /Getting started/ }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(document.activeElement).toBe(search);
    view.rerender(<Scene electron={electron} />);
    await screen.findByRole("dialog", { name: "Getting started" });
    expect(document.activeElement).toBe(search);
    view.rerender(<Scene electron={electron} presentation="canvas" />);
    expect(screen.queryByRole("dialog", { name: "Getting started" })).not.toBeNull();
    expect(document.activeElement).toBe(search);
    fireEvent.click(screen.getByRole("button", { name: /Getting started/ }));
    view.rerender(<Scene electron={electron} active />);
    view.rerender(<Scene electron={electron} />);
    expect(screen.queryByRole("dialog", { name: "Getting started" })).toBeNull();
  });
  it("does not consume first auto-open while blocked", async () => {
    let resolveStatus!: () => void;
    const pending = new Promise<void>((resolve) => { resolveStatus = resolve; });
    if (electron) {
      useConnection.setState({ api: {
        get: vi.fn(async (path: string) => { await pending; return data(path); }),
        forRuntime() { return this; },
      } as never });
    } else {
      vi.mocked(fetch).mockImplementation(async (input) => { await pending; return new Response(JSON.stringify(data(String(input)))); });
    }
    const view = render(<Scene electron={electron} active />);
    expect(localStorage.getItem(key)).toBeNull();
    await act(async () => { resolveStatus(); await pending; });
    expect(localStorage.getItem(key)).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Getting started" })).toBeNull();
    view.rerender(<Scene electron={electron} />);
    await screen.findByRole("dialog", { name: "Getting started" });
    expect(localStorage.getItem(key)).toBe("1");
  });
  it("preserves manual dismissal before the first status response arrives", async () => {
    let resolveStatus!: () => void;
    const pending = new Promise<void>((resolve) => { resolveStatus = resolve; });
    if (electron) {
      useConnection.setState({ api: {
        get: vi.fn(async (path: string) => { await pending; return data(path); }),
        forRuntime() { return this; },
      } as never });
    } else {
      vi.mocked(fetch).mockImplementation(async (input) => { await pending; return new Response(JSON.stringify(data(String(input)))); });
    }
    const view = render(<Scene electron={electron} />);
    fireEvent.click(screen.getByRole("button", { name: /Getting started/ }));
    await screen.findByRole("dialog", { name: "Getting started" });
    fireEvent.click(screen.getByRole("button", { name: /Getting started/ }));
    await act(async () => { resolveStatus(); await pending; });
    view.rerender(<Scene electron={electron} presentation="canvas" active />);
    view.rerender(<Scene electron={electron} presentation="canvas" />);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(screen.queryByRole("dialog", { name: "Getting started" })).toBeNull();
  });
});
