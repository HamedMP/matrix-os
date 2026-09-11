// @vitest-environment jsdom
import React from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GettingStartedVisibilityProvider } from "../../packages/ui/src/getting-started-visibility";
import { GettingStartedPopover, webGettingStartedAutoOpenKey } from "../../shell/src/components/onboarding/GettingStartedPopover";
import { MissionControl } from "../../shell/src/components/MissionControl";
import { createShellQueryClient } from "../../shell/src/api/query-client";
import DesktopLaunchpad from "../../desktop/src/renderer/src/features/desktop-shell/DesktopLaunchpad";
import ElectronCard, { gettingStartedAutoOpenKey } from "../../desktop/src/renderer/src/features/onboarding/GettingStartedPopover";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
vi.mock("@/hooks/useTaskBoard", () => ({ useTaskBoard: () => ({ provision: { active: false } }) }));
const noop = () => {};
function responseFor(path: string): unknown {
  if (path.includes("github/status")) return { installed: true, authenticated: false, user: null };
  if (path.includes("credentials/status")) return { agents: [] };
  if (path.includes("projects")) return { projects: [] };
  if (path.includes("chats")) return { items: [] };
  if (path.includes("billing")) return { access: { runtimeProxyAllowed: false } };
  return [];
}
const launcherProps = { apps: [{ name: "Notes", path: "apps/notes/index.html" }], openWindows: new Set<string>(), pinnedApps: [], onOpenApp: noop, onClose: noop, onTogglePin: noop, onRegenerateIcon: noop, onCreateApp: noop };
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(webGettingStartedAutoOpenKey("/"), "1");
  localStorage.setItem(gettingStartedAutoOpenKey("neo", "primary"), "1");
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => { cb(0); return 0; });
  vi.stubGlobal("fetch", vi.fn(async (input) => new Response(JSON.stringify(responseFor(String(input))))));
  useConnection.setState({ status: "signed-in", handle: "neo", runtimeSlot: "primary", api: { get: async (path: string) => responseFor(path), forRuntime() { return this; } } as never });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.documentElement.removeAttribute("data-theme-style"); });
for (const presentation of ["desktop", "canvas-glass", "canvas-classic"] as const) {
  it(`Web ${presentation} keeps the real checklist hidden through launcher exit and rapid reopen`, async () => {
    document.documentElement.setAttribute("data-theme-style", presentation === "canvas-classic" ? "matrix" : "macos-glass");
    const client = createShellQueryClient();
    const scene = (open: boolean) => <QueryClientProvider client={client}><GettingStartedVisibilityProvider scope="test"><GettingStartedPopover onOpenSettings={noop} onOpenFirstWork={noop} /><MissionControl open={open} nativePresentation={presentation === "desktop"} {...launcherProps} /></GettingStartedVisibilityProvider></QueryClientProvider>;
    const view = render(scene(false));
    fireEvent.click(screen.getByRole("button", { name: /Getting started/ }));
    expect(screen.queryByRole("dialog", { name: "Getting started" })).not.toBeNull();
    view.rerender(scene(true));
    expect(screen.queryByRole("dialog", { name: "Getting started" })).toBeNull();
    view.rerender(scene(false));
    expect(screen.queryByRole("dialog", { name: "Getting started" })).toBeNull();
    view.rerender(scene(true));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
    expect(screen.queryByRole("dialog", { name: "Getting started" })).toBeNull();
    view.rerender(scene(false));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Getting started" })).not.toBeNull());
    client.clear();
  });
}
for (const presentation of ["desktop", "canvas"] as const) {
  it(`Electron ${presentation} suppresses the real checklist while its launcher is open`, async () => {
    const scene = (open: boolean) => <GettingStartedVisibilityProvider scope="test"><ElectronCard /><DesktopLaunchpad open={open} onClose={noop} osViewMode={presentation} onSwitchOsView={noop} /></GettingStartedVisibilityProvider>;
    const view = render(scene(false));
    fireEvent.click(screen.getByRole("button", { name: /Getting started/ }));
    view.rerender(scene(true));
    expect(screen.queryByRole("dialog", { name: "Getting started" })).toBeNull();
    const search = screen.getByRole("textbox");
    expect(document.activeElement).toBe(search);
    view.rerender(scene(false));
    await screen.findByRole("dialog", { name: "Getting started" });
    expect(document.activeElement).not.toBe(screen.getByRole("button", { name: /Getting started/ }));
  });
}
