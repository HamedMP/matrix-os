// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AppLauncher from "../../desktop/src/renderer/src/features/embeds/AppLauncher";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";
import { OS_VIEW_FIXED_APP_NAMES } from "../fixtures/os-view-parity";
import { clearDesktopApps, seedDesktopApps } from "./apps-query-test-utils";

describe("AppLauncher", () => {
  beforeEach(() => {
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://platform.test",
      runtimeSlot: "primary",
      api: null,
    });
    clearDesktopApps();
    seedDesktopApps([
      { slug: "alpha", name: "Alpha", appIdentity: "utilities/alpha" },
      { slug: "beta", name: "Beta" },
      { slug: "bravo", name: "Bravo" },
    ]);
    useTabs.setState({ tabs: [], activeTabId: null });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("falls back to slug names and skips invalid app rows", async () => {
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://platform.test",
      runtimeSlot: "primary",
      api: {
        get: vi.fn().mockResolvedValue({
          apps: [
            { slug: "notes", name: 42 },
            { slug: "chat", name: "Chat" },
            { slug: "", name: "Blank" },
            { name: "Missing slug" },
          ],
        }),
      } as never,
    });
    clearDesktopApps();

    render(<AppLauncher />);

    expect(await screen.findByRole("button", { name: /notes/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /chat/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /blank/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /missing slug/i })).toBeNull();
  });

  it("resets the active app when the search query changes", async () => {
    render(<AppLauncher />);
    const search = screen.getByLabelText("Search apps");

    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.change(search, { target: { value: "b" } });
    fireEvent.keyDown(search, { key: "Enter" });

    await waitFor(() => {
      expect(useTabs.getState().tabs[0]).toMatchObject({
        kind: "app",
        slug: "beta",
        title: "Beta",
      });
    });
  });

  it("notifies a transient launcher after an app opens", async () => {
    const onLaunch = vi.fn();
    render(<AppLauncher presentation="launchpad" onLaunch={onLaunch} />);

    fireEvent.click(screen.getByRole("button", { name: /Alpha/i }));

    await waitFor(() => expect(onLaunch).toHaveBeenCalledTimes(1));
    expect(useTabs.getState().tabs[0]).toMatchObject({
      kind: "app",
      slug: "alpha",
      appIdentity: "utilities/alpha",
    });
  });

  it("puts Create app and the other OS view first, then the Electron Desktop parity fixture", () => {
    const onCreateApp = vi.fn();
    const onSwitchOsView = vi.fn();
    render(
      <AppLauncher
        presentation="launchpad"
        osViewMode="desktop"
        onCreateApp={onCreateApp}
        onSwitchOsView={onSwitchOsView}
      />,
    );

    const launcher = screen.getByTestId("desktop-launcher-grid");
    const names = Array.from(launcher.querySelectorAll("button"))
      .map((button) => button.getAttribute("aria-label"));
    expect(names.slice(0, 12)).toEqual(["Create app", "Canvas", ...OS_VIEW_FIXED_APP_NAMES]);

    fireEvent.click(screen.getByRole("button", { name: "Create app" }));
    expect(onCreateApp).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Canvas" }));
    expect(onSwitchOsView).toHaveBeenCalledWith("canvas");
  });

  it("keeps core system vectors while allowing app artwork for Notes", () => {
    clearDesktopApps();
    seedDesktopApps([
      { slug: "chat", name: "Chat" },
      { slug: "notes", name: "Notes" },
    ]);

    render(<AppLauncher presentation="launchpad" />);

    const chat = screen.getByRole("button", { name: "Chat" });
    expect(chat.querySelector("svg")).toBeTruthy();
    expect(chat.querySelector("img")).toBeNull();

    const notes = screen.getByRole("button", { name: "Notes" });
    expect(notes.querySelector("img")?.getAttribute("src")).toContain("/icons/notes.png");
  });

  it("offers Desktop from Canvas and keeps the OS-view destination launcher-only", () => {
    const onSwitchOsView = vi.fn();
    const onAddToDesktop = vi.fn();
    render(
      <AppLauncher
        presentation="launchpad"
        osViewMode="canvas"
        onSwitchOsView={onSwitchOsView}
        onAddToDesktop={onAddToDesktop}
      />,
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: "Desktop" }));
    expect(screen.queryByRole("menuitem", { name: "Add Desktop to Desktop" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Desktop" }));
    expect(onSwitchOsView).toHaveBeenCalledWith("desktop");
    expect(onAddToDesktop).not.toHaveBeenCalled();
  });

  it("adds a launcher app back to the Desktop from its context menu", () => {
    const onAddToDesktop = vi.fn();
    render(<AppLauncher presentation="launchpad" onAddToDesktop={onAddToDesktop} />);

    fireEvent.contextMenu(screen.getByRole("button", { name: "Notes" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Add Notes to Desktop" }));

    expect(onAddToDesktop).toHaveBeenCalledWith("__notes__");
  });

  it("keeps the focused launcher search field free of a nested focus ring", () => {
    render(<AppLauncher presentation="launchpad" />);

    const search = screen.getByLabelText("Search apps");
    expect(search.style.boxShadow).toBe("none");
    expect(search.style.borderRadius).toBe("0px");
  });

  it("does not show a no-match state before the app catalog loads", () => {
    clearDesktopApps();
    useConnection.setState({
      api: { get: vi.fn(() => new Promise(() => undefined)) } as never,
    });

    render(<AppLauncher />);

    expect(screen.getByText("Loading apps")).toBeTruthy();
    expect(screen.queryByText(/No apps match/i)).toBeNull();
  });
});
