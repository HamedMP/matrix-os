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
      { slug: "alpha", name: "Alpha", path: "apps/utilities/alpha/index.html", appIdentity: "utilities/alpha" },
      { slug: "beta", name: "Beta" },
      { slug: "bravo", name: "Bravo" },
      { slug: "sushi-counter", name: "Sushi Counter", path: "apps/sushi-counter/index.html", appIdentity: "sushi-counter" },
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

    const canvas = screen.getByRole("button", { name: "Canvas" });
    expect(canvas.querySelector("img")).toBeNull();
    expect(canvas.querySelector("svg")).toBeTruthy();
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

  it("adds an existing generated app and closes the launcher after persistence", async () => {
    const onAddToDesktop = vi.fn(async () => "added" as const);
    const onCloseLauncher = vi.fn();
    render(<AppLauncher presentation="launchpad" onAddToDesktop={onAddToDesktop} onCloseLauncher={onCloseLauncher} />);

    fireEvent.contextMenu(screen.getByRole("button", { name: "Sushi Counter" }), { clientX: 1000, clientY: 760 });
    const menu = screen.getByRole("menu");
    expect(menu.style.left).toBe("760px");
    expect(menu.style.top).toBe("648px");
    fireEvent.click(screen.getByRole("menuitem", { name: "Add Sushi Counter to Desktop" }));

    await waitFor(() => expect(onCloseLauncher).toHaveBeenCalledOnce());
    expect(onAddToDesktop).toHaveBeenCalledWith("apps/sushi-counter/index.html", expect.any(Object));
  });

  it("dismisses the context menu before closing the launcher", () => {
    const onCloseLauncher = vi.fn();
    render(<AppLauncher presentation="launchpad" onAddToDesktop={vi.fn()} onCloseLauncher={onCloseLauncher} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Alpha" }), { clientX: 40, clientY: 50 });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onCloseLauncher).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCloseLauncher).toHaveBeenCalledOnce();
  });

  it("keeps the launcher usable and shows a bounded error when placement fails", async () => {
    render(<AppLauncher
      presentation="launchpad"
      onAddToDesktop={vi.fn(async () => "desktop-full" as const)}
      onCloseLauncher={vi.fn()}
    />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Sushi Counter" }), { clientX: 1000, clientY: 760 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Add Sushi Counter to Desktop" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Desktop is full");
    expect(screen.getByRole("menu").style.top).toBe("648px");
  });

  it("disables repeated placement while the first request is pending", async () => {
    let resolvePlacement!: (result: "failed") => void;
    const placement = new Promise<"failed">((resolve) => { resolvePlacement = resolve; });
    const onAddToDesktop = vi.fn(() => placement);
    render(<AppLauncher presentation="launchpad" onAddToDesktop={onAddToDesktop} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Sushi Counter" }));
    const action = screen.getByRole("menuitem", { name: "Add Sushi Counter to Desktop" });

    fireEvent.click(action);
    fireEvent.click(action);

    expect((action as HTMLButtonElement).disabled).toBe(true);
    expect(onAddToDesktop).toHaveBeenCalledOnce();
    resolvePlacement("failed");
    expect((await screen.findByRole("alert")).textContent).toContain("Could not add");
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
