// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NativeDesktopShell from "@desktop/renderer/src/features/desktop-shell/NativeDesktopShell";
import DesktopHeaderTabs from "@desktop/renderer/src/features/desktop-shell/DesktopHeaderTabs";
import { bundledDesktopIconForPath } from "@desktop/renderer/src/features/desktop-shell/bundled-app-icons";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useDesktopSurfaces } from "@desktop/renderer/src/stores/desktop-surfaces";
import { useTabs } from "@desktop/renderer/src/stores/tabs";
import { useUi } from "@desktop/renderer/src/stores/ui";
import { useNativeDesktopMode } from "@desktop/renderer/src/stores/native-desktop-mode";
import { useDesktopAppDrawer } from "@desktop/renderer/src/stores/desktop-app-drawer";
import { resetDesktopIconsRuntime, useDesktopIcons } from "@desktop/renderer/src/stores/desktop-icons";
import { desktopQueryClient } from "@desktop/renderer/src/lib/query-client";
import { seedDesktopApps } from "./apps-query-test-utils";

vi.mock("@desktop/renderer/src/features/mission-control/TabContent", () => ({
  TabPane: ({ tab }: { tab: { title: string } }) => <div>{tab.title} content</div>,
  TabErrorBoundary: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@desktop/renderer/src/features/runtime/RuntimeComputerMenu", () => ({ default: () => null }));
vi.mock("@desktop/renderer/src/features/mission-control/AccountMenu", () => ({ default: () => null }));
vi.mock("@desktop/renderer/src/features/updates/DesktopUpdateButton", () => ({ default: () => null }));
vi.mock("@desktop/renderer/src/features/onboarding/GettingStartedPopover", () => ({ default: () => null }));

beforeEach(() => {
  useTabs.setState(useTabs.getInitialState(), true);
  useDesktopSurfaces.setState(useDesktopSurfaces.getInitialState(), true);
  useConnection.setState(useConnection.getInitialState(), true);
  useUi.setState(useUi.getInitialState(), true);
  useNativeDesktopMode.setState(useNativeDesktopMode.getInitialState(), true);
  useDesktopAppDrawer.setState(useDesktopAppDrawer.getInitialState(), true);
  resetDesktopIconsRuntime();
  useDesktopIcons.setState(useDesktopIcons.getInitialState(), true);
  desktopQueryClient.clear();
  useNativeDesktopMode.setState({ hydrated: true });
  window.operator = {
    invoke: vi.fn(async (channel: string) => channel === "state:get" ? { value: { mode: "desktop" } } : { ok: true }),
    on: vi.fn(() => () => undefined),
  };
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Electron Desktop selected artwork", () => {
  it.each([['notes', 'Notes'], ['whiteboard', 'Whiteboard']])("updates the maximized %s global header artwork as owner selection arrives and changes without reopening", async (slug, name) => {
    useConnection.setState({ platformHost: "https://runtime.example.com", runtimeSlot: "secondary" });
    seedDesktopApps([]);
    render(<><DesktopHeaderTabs /><NativeDesktopShell overlayOpen={false} /></>);
    fireEvent.doubleClick(screen.getByRole("button", { name }));
    const id = useTabs.getState().activeTabId!;
    act(() => useDesktopSurfaces.getState().maximizeToTab(id));
    const storedTabs = useTabs.getState().tabs;
    const surface = useDesktopSurfaces.getState().surfaces[id];
    const installed = { slug, name, path: `apps/${slug}/index.html` };
    const headerIcon = () => screen.getByRole("tab", { name }).querySelector("img")?.getAttribute("src");
    expect(headerIcon()).toBe(bundledDesktopIconForPath(installed.path));

    for (const version of ["arrived", "changed"]) {
      const iconUrl = `/icons/owner-${slug}.svg?v=${version}`;
      act(() => seedDesktopApps([{ ...installed, iconUrl }]));
      await waitFor(() => expect(headerIcon()).toBe(`https://runtime.example.com${iconUrl}&runtime=secondary`));
      expect(useTabs.getState().tabs).toBe(storedTabs);
      expect(useTabs.getState().activeTabId).toBe(id);
      expect(useDesktopSurfaces.getState().surfaces[id]).toBe(surface);
      expect(screen.getByRole("tab", { name }).getAttribute("aria-selected")).toBe("true");
    }

    act(() => seedDesktopApps([installed]));
    await waitFor(() => expect(headerIcon()).toBe(bundledDesktopIconForPath(installed.path)));
    expect(useTabs.getState().tabs).toBe(storedTabs);
    expect(useDesktopSurfaces.getState().surfaces[id]).toBe(surface);
  });
  it.each([['notes', 'Notes'], ['whiteboard', 'Whiteboard']])("preserves selected %s artwork in fixed desktop tiles and opened app tabs", (slug, name) => {
    useConnection.setState({ platformHost: "https://runtime.example.com", runtimeSlot: "secondary" });
    const iconUrl = `/icons/owner-${slug}.svg?v=selected`;
    seedDesktopApps([{ slug, name, path: `apps/${slug}/index.html`, iconUrl }]);
    render(<NativeDesktopShell overlayOpen={false} />);
    const tile = screen.getByRole("button", { name });
    const expected = `https://runtime.example.com${iconUrl}&runtime=secondary`;
    expect(screen.getAllByRole("button", { name })).toHaveLength(1);
    expect(tile.querySelector("img")?.getAttribute("src")).toBe(expected);
    fireEvent.doubleClick(tile);
    expect(screen.getByRole("button", { name: `Focus ${name}` }).querySelector("img")?.getAttribute("src")).toBe(expected);
  });
  it.each([['notes', 'Notes'], ['whiteboard', 'Whiteboard']])("uses bundled %s artwork when an installed app has no selected icon URL", (slug, name) => {
    useConnection.setState({ platformHost: "https://runtime.example.com" });
    seedDesktopApps([{ slug, name, path: `apps/${slug}/index.html` }]);
    render(<NativeDesktopShell overlayOpen={false} />);
    const tile = screen.getByRole("button", { name });
    const expected = bundledDesktopIconForPath(`apps/${slug}/index.html`);
    expect(tile.querySelector("img")?.getAttribute("src")).toBe(expected);
    fireEvent.doubleClick(tile);
    expect(screen.getByRole("button", { name: `Focus ${name}` }).querySelector("img")?.getAttribute("src")).toBe(expected);
  });
  it.each([['notes', 'Notes'], ['whiteboard', 'Whiteboard']])("refreshes the existing %s tab artwork when reopened after an owner selection changes", async (slug, name) => {
    useConnection.setState({ platformHost: "https://runtime.example.com" });
    const oldIcon = `/icons/owner-${slug}.svg?v=old`;
    const newIcon = `/icons/owner-${slug}.svg?v=new`;
    const installed = { slug, name, path: `apps/${slug}/index.html` };
    seedDesktopApps([{ ...installed, iconUrl: oldIcon }]);
    render(<NativeDesktopShell overlayOpen={false} />);
    fireEvent.doubleClick(screen.getByRole("button", { name }));
    const id = useTabs.getState().activeTabId;
    expect(screen.getByRole("button", { name: `Focus ${name}` }).querySelector("img")?.getAttribute("src")).toBe(`https://runtime.example.com${oldIcon}`);
    act(() => seedDesktopApps([{ ...installed, iconUrl: newIcon }]));
    await waitFor(() => expect(screen.getByRole("button", { name }).querySelector("img")?.getAttribute("src")).toBe(`https://runtime.example.com${newIcon}`));
    expect(screen.getByRole("button", { name: `Focus ${name}` }).querySelector("img")?.getAttribute("src")).toBe(`https://runtime.example.com${newIcon}`);
    fireEvent.doubleClick(screen.getByRole("button", { name }));
    expect(useTabs.getState().activeTabId).toBe(id);
    expect(useTabs.getState().tabs.filter(tab => tab.title === name)).toHaveLength(1);
    expect(screen.getByRole("button", { name: `Focus ${name}` }).querySelector("img")?.getAttribute("src")).toBe(`https://runtime.example.com${newIcon}`);
  });
  it.each([['notes', 'Notes'], ['whiteboard', 'Whiteboard']])("fills missing artwork on an existing %s tab when reopened from its fixed destination", (slug, name) => {
    useConnection.setState({ platformHost: "https://runtime.example.com" });
    const iconUrl = `/icons/owner-${slug}.svg?v=selected`;
    seedDesktopApps([{ slug, name, path: `apps/${slug}/index.html`, iconUrl }]);
    const id = useTabs.getState().openTab({ kind: slug === "notes" ? "notes" : "app", title: name, ...(slug === "whiteboard" ? { slug } : {}) });
    expect(useTabs.getState().tabs.find(tab => tab.id === id)?.icon).toBeUndefined();
    render(<NativeDesktopShell overlayOpen={false} />);
    fireEvent.doubleClick(screen.getByRole("button", { name }));
    expect(useTabs.getState().activeTabId).toBe(id);
    expect(useTabs.getState().tabs.filter(tab => tab.title === name)).toHaveLength(1);
    expect(screen.getByRole("button", { name: `Focus ${name}` }).querySelector("img")?.getAttribute("src")).toBe(`https://runtime.example.com${iconUrl}`);
  });
  it("keeps existing artwork when navigation reopens a tab without a replacement icon", () => {
    const icon = "https://runtime.example.com/icons/owner-notes.svg?v=selected";
    const id = useTabs.getState().openTab({ kind: "notes", title: "Notes", icon });
    expect(useTabs.getState().openTab({ kind: "notes", title: "Notes" })).toBe(id);
    expect(useTabs.getState().tabs.find(tab => tab.id === id)?.icon).toBe(icon);
  });
  it("keeps Plugins artwork in the shared settings tab and restores Settings artwork when the tab is reused", () => {
    render(<NativeDesktopShell overlayOpen={false} />);
    const plugins = screen.getByRole("button", { name: "Plugins" });
    const expectedPlugins = bundledDesktopIconForPath("__plugins__");
    expect(plugins.querySelector("img")?.getAttribute("src")).toBe(expectedPlugins);
    fireEvent.doubleClick(plugins);
    const settingsId = useTabs.getState().tabs.find(tab => tab.kind === "settings")?.id;
    expect(settingsId).toBeTruthy();
    expect(screen.getByRole("button", { name: "Focus Plugins" }).querySelector("img")?.getAttribute("src")).toBe(expectedPlugins);
    fireEvent.doubleClick(screen.getByRole("button", { name: "Settings" }));
    expect(useTabs.getState().tabs.find(tab => tab.kind === "settings")?.id).toBe(settingsId);
    expect(screen.getByRole("button", { name: "Focus Settings" }).querySelector("img")?.getAttribute("src")).toBe(bundledDesktopIconForPath("__settings__"));
  });
});
