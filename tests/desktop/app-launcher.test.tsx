// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AppLauncher from "../../desktop/src/renderer/src/features/embeds/AppLauncher";
import DesktopLaunchpad from "../../desktop/src/renderer/src/features/desktop-shell/DesktopLaunchpad";
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
      userId: null, organizationStatus: "none", organizationId: null,
    });
    clearDesktopApps();
    seedDesktopApps([
      { slug: "alpha", name: "Alpha", path: "apps/utilities/alpha/index.html", appIdentity: "utilities/alpha" },
      { slug: "beta", name: "Beta" },
      { slug: "bravo", name: "Bravo" },
      { slug: "sushi-counter", name: "Sushi Counter", path: "apps/sushi-counter/index.html", appIdentity: "sushi-counter" },
    ]);
    useTabs.setState({ tabs: [], activeTabId: null });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    cleanup();
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("opens an organization app as an app tab with a shared badge", async () => {
    const target = {
      scopeId: "10000000-0000-4000-8000-000000000001", runtimeId: "runtime_owner",
      organizationId: "org_team", authorityGeneration: 1, appId: "shared-tasks-lab",
      catalogId: "30000000-0000-4000-8000-000000000001",
      readinessId: "40000000-0000-4000-8000-000000000001",
      registrationIncarnation: "a".repeat(64), buildId: "b".repeat(64), shareRevision: "1",
      owner: { actorId: "user_owner", displayName: "Owner" },
    };
    useConnection.setState({ userId: "user_member", organizationId: "org_team", organizationStatus: "member" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [target] }), {
      headers: { "content-type": "application/json" },
    })));
    render(<AppLauncher presentation="launchpad" />);
    const tile = await screen.findByRole("button", { name: "Shared tasks lab" });
    expect(tile.querySelector('[aria-label="Shared app"]')).toBeTruthy();
    fireEvent.click(tile);
    expect(useTabs.getState().tabs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "app", slug: "shared-tasks-lab", sharedAppTarget: target }),
    ]));
  });

  it("shows the owner's name and authenticated platform icon for an organization app", async () => {
    const scopeId = "10000000-0000-4000-8000-000000000001";
    const iconUrl = `/api/collaboration/shared-apps/${scopeId}/icon?v=${"c".repeat(64)}`;
    const target = {
      scopeId, runtimeId: "runtime_owner",
      organizationId: "org_team", authorityGeneration: 1, appId: "shared-tasks-lab",
      catalogId: "30000000-0000-4000-8000-000000000001",
      readinessId: "40000000-0000-4000-8000-000000000001",
      registrationIncarnation: "a".repeat(64), buildId: "b".repeat(64), shareRevision: "1",
      owner: { actorId: "user_owner", displayName: "Owner" }, name: "Team Tracker", iconUrl,
    };
    useConnection.setState({ userId: "user_member", organizationId: "org_team", organizationStatus: "member" });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ items: [target] }), {
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(<AppLauncher presentation="launchpad" />);
    const tile = await screen.findByRole("button", { name: "Team Tracker" });
    // Resolved against the platform origin, where the trusted core attaches the member's bearer.
    expect(tile.querySelector("img")?.getAttribute("src")).toBe(`https://platform.test${iconUrl}`);
    expect(tile.innerHTML).not.toContain("/icons/shared-tasks-lab");
    fireEvent.click(tile);
    expect(useTabs.getState().tabs).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "Team Tracker", sharedAppTarget: target }),
    ]));
  });

  it("filters apps in the Electron Desktop launchpad without dismissing it", async () => {
    // Fault: chip pointer events reach the launchpad backdrop, which closes before the filter applies.
    const target = {
      scopeId: "10000000-0000-4000-8000-000000000001", runtimeId: "runtime_owner",
      organizationId: "org_team", authorityGeneration: 1, appId: "shared-tasks-lab",
      catalogId: "30000000-0000-4000-8000-000000000001",
      readinessId: "40000000-0000-4000-8000-000000000001",
      registrationIncarnation: "a".repeat(64), buildId: "b".repeat(64), shareRevision: "1",
      owner: { actorId: "user_owner", displayName: "Owner" },
    };
    useConnection.setState({ userId: "user_member", organizationId: "org_team", organizationStatus: "member" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [target] }), {
      headers: { "content-type": "application/json" },
    })));
    const onClose = vi.fn();
    render(<DesktopLaunchpad open onClose={onClose} osViewMode="desktop" onSwitchOsView={vi.fn()} />);
    await screen.findByRole("button", { name: "Shared tasks lab" });
    const mine = screen.getByRole("button", { name: /^Mine/ });
    fireEvent.pointerDown(mine);
    fireEvent.click(mine);
    expect(onClose).not.toHaveBeenCalled();
    expect(mine.getAttribute("aria-pressed")).toBe("true");
  });

  it.each(["loading", "offline"])("opens shared apps while the installed catalog is %s", async (status) => {
    clearDesktopApps();
    useConnection.setState({ userId: "user_member", organizationId: "org_team", organizationStatus: "member",
      api: { forRuntime() { return this; }, get: vi.fn(() => status === "loading" ? new Promise(() => undefined) : Promise.reject(new Error("offline"))) } as never });
    const target = { scopeId: "10000000-0000-4000-8000-000000000001", runtimeId: "runtime_owner",
      organizationId: "org_team", authorityGeneration: 1, appId: "shared-tasks-lab",
      catalogId: "30000000-0000-4000-8000-000000000001", readinessId: "40000000-0000-4000-8000-000000000001",
      registrationIncarnation: "a".repeat(64), buildId: "b".repeat(64), shareRevision: "1",
      owner: { actorId: "user_owner", displayName: "Owner" } };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [target] }), {
      headers: { "content-type": "application/json" },
    })));
    render(<AppLauncher />);
    fireEvent.click(await screen.findByRole("button", { name: "Shared tasks lab" }));
    expect(useTabs.getState().tabs).toEqual(expect.arrayContaining([expect.objectContaining({ sharedAppTarget: target })]));
  });

  it("distinguishes loading shared discovery from an empty directory", async () => {
    clearDesktopApps();seedDesktopApps([]);
    useConnection.setState({ userId: "user_member", organizationId: "org_team", organizationStatus: "member" });
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
    render(<AppLauncher />);
    expect(await screen.findByText("Loading shared apps…")).toBeTruthy();
  });

  it("offers shared discovery Retry when there are no installed apps", async () => {
    clearDesktopApps();seedDesktopApps([]);
    useConnection.setState({ userId: "user_member", organizationId: "org_team", organizationStatus: "member" });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    render(<AppLauncher />);
    expect(await screen.findByText("Shared apps are unavailable.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("falls back to slug names and skips invalid app rows", async () => {
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://platform.test",
      runtimeSlot: "primary",
      api: {
        forRuntime() { return this; },
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

  it("offers no standalone app share: projects are the only live-shareable resource", async () => {
    render(<AppLauncher />);

    await screen.findByRole("button", { name: /Alpha/i });
    fireEvent.keyDown(screen.getByLabelText("Search apps"), { key: "ArrowDown" });
    expect(screen.queryByRole("button", { name: /^Share\b/i })).toBeNull();
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
    expect(names.slice(0, 2 + OS_VIEW_FIXED_APP_NAMES.length)).toEqual(["Create app", "Canvas", ...OS_VIEW_FIXED_APP_NAMES]);

    fireEvent.click(screen.getByRole("button", { name: "Create app" }));
    expect(onCreateApp).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Canvas" }));
    expect(onSwitchOsView).toHaveBeenCalledWith("canvas");

    const canvas = screen.getByRole("button", { name: "Canvas" });
    const image = canvas.querySelector("img")!;
    expect(image.getAttribute("src")).toContain("canvas.png");
    fireEvent.error(image);
    expect(canvas.querySelector("img")).toBeNull();
    expect(canvas.querySelector("svg")).toBeTruthy();
  });

  it("uses bundled core artwork for Notes when no custom icon is selected", () => {
    clearDesktopApps();
    seedDesktopApps([
      { slug: "chat", name: "Chat" },
      { slug: "notes", name: "Notes" },
    ]);

    render(<AppLauncher presentation="launchpad" />);

    const chat = screen.getByRole("button", { name: "Chat" });
    const image = chat.querySelector("img")!;
    expect(image.getAttribute("src")).toContain("chat.png");
    expect((image.parentElement as HTMLElement).style.background).toBe("transparent");
    fireEvent.error(image);
    expect(chat.querySelector("svg")).toBeTruthy();
    expect(chat.querySelector("img")).toBeNull();

    const notes = screen.getByRole("button", { name: "Notes" });
    expect(notes.querySelector("img")?.getAttribute("src")).toContain("/system-app-icons/v2/notes.png");
  });
  it.each(["notes", "whiteboard"])("preserves the owner-selected %s icon even with the default filename", (slug) => {
    const name = slug === "notes" ? "Notes" : "Whiteboard";
    clearDesktopApps();
    seedDesktopApps([{ slug, name, path: `apps/${slug}/index.html`, iconUrl: `/icons/${slug}.png?v=legacy` }]);
    const view = render(<AppLauncher presentation="launchpad" />);
    expect(screen.getByRole("button", { name }).querySelector("img")?.getAttribute("src"))
      .toContain(`/icons/${slug}.png?v=legacy`);
    view.unmount();
    seedDesktopApps([{ slug, name, path: `apps/${slug}/index.html`, iconUrl: `/icons/owner-${slug}.svg?v=selected` }]);
    render(<AppLauncher presentation="launchpad" />);
    expect(screen.getByRole("button", { name }).querySelector("img")?.getAttribute("src"))
      .toContain(`/icons/owner-${slug}.svg?v=selected`);
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
      api: { forRuntime() { return this; }, get: vi.fn(() => new Promise(() => undefined)) } as never,
    });

    render(<AppLauncher />);

    expect(screen.getByText("Loading apps")).toBeTruthy();
    expect(screen.queryByText(/No apps match/i)).toBeNull();
  });

  describe("keyboard navigation", () => {
    // jsdom has no layout: give each launchpad tile the offsetTop a `columns`-wide grid would produce.
    function layOutGrid(columns: number) {
      const tiles = Array.from(screen.getByTestId("desktop-launcher-grid").children) as HTMLElement[];
      tiles.forEach((tile, i) => Object.defineProperty(tile, "offsetTop", { configurable: true, value: Math.floor(i / columns) * 100 }));
      return tiles;
    }
    const activeTile = () => {
      const id = screen.getByLabelText("Search apps").getAttribute("aria-activedescendant");
      return id ? document.getElementById(id) : null;
    };

    it("moves through the Electron Desktop launchpad grid by tile and by row", () => {
      // Fault: ArrowDown moved one tile right and Left/Right were dead in the multi-column launchpad.
      render(<AppLauncher presentation="launchpad" />);
      const tiles = layOutGrid(3);
      const search = screen.getByLabelText("Search apps");
      expect(tiles.length).toBeGreaterThan(6);
      expect(activeTile()).toBe(tiles[0]);

      fireEvent.keyDown(search, { key: "ArrowRight" });
      expect(activeTile()).toBe(tiles[1]);
      fireEvent.keyDown(search, { key: "ArrowDown" });
      expect(activeTile()).toBe(tiles[4]);
      expect(tiles[4].scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
      fireEvent.keyDown(search, { key: "ArrowLeft" });
      expect(activeTile()).toBe(tiles[3]);
      fireEvent.keyDown(search, { key: "ArrowUp" });
      expect(activeTile()).toBe(tiles[0]);
      fireEvent.keyDown(search, { key: "ArrowUp" });
      fireEvent.keyDown(search, { key: "ArrowLeft" });
      expect(activeTile()).toBe(tiles[0]);
      fireEvent.keyDown(search, { key: "End" });
      expect(activeTile()).toBe(tiles[tiles.length - 1]);
      fireEvent.keyDown(search, { key: "ArrowRight" });
      expect(activeTile()).toBe(tiles[tiles.length - 1]);
      fireEvent.keyDown(search, { key: "Home" });
      expect(activeTile()).toBe(tiles[0]);
    });

    it("keeps Tab, Enter and Escape behavior in the launchpad grid", () => {
      const onCloseLauncher = vi.fn();
      const onCreateApp = vi.fn();
      render(<AppLauncher presentation="launchpad" onCreateApp={onCreateApp} onCloseLauncher={onCloseLauncher} />);
      const tiles = layOutGrid(3);
      const search = screen.getByLabelText("Search apps");
      fireEvent.keyDown(search, { key: "Tab", shiftKey: true });
      expect(activeTile()).toBe(tiles[tiles.length - 1]);
      fireEvent.keyDown(search, { key: "Tab" });
      expect(activeTile()).toBe(tiles[0]);
      fireEvent.keyDown(search, { key: "Enter" });
      expect(onCreateApp).toHaveBeenCalledOnce();
      fireEvent.keyDown(search, { key: "Escape" });
      expect(onCloseLauncher).toHaveBeenCalledOnce();
    });

    it("lets Left and Right edit a launchpad search query until the caret reaches an edge", () => {
      render(<AppLauncher presentation="launchpad" />);
      const search = screen.getByLabelText("Search apps") as HTMLInputElement;
      fireEvent.change(search, { target: { value: "a" } });
      const tiles = layOutGrid(2);
      expect(tiles.length).toBeGreaterThan(1);

      search.setSelectionRange(0, 0);
      expect(fireEvent.keyDown(search, { key: "ArrowRight" })).toBe(true);
      expect(activeTile()).toBe(tiles[0]);
      search.setSelectionRange(1, 1);
      expect(fireEvent.keyDown(search, { key: "ArrowRight" })).toBe(false);
      expect(activeTile()).toBe(tiles[1]);
      expect(fireEvent.keyDown(search, { key: "ArrowLeft" })).toBe(true);
      expect(activeTile()).toBe(tiles[1]);
    });

    it("keeps list navigation with wrap and leaves Left and Right to the search input", () => {
      render(<AppLauncher />);
      const search = screen.getByLabelText("Search apps");
      const tiles = Array.from(screen.getByTestId("desktop-launcher-grid").children);
      expect(tiles).toHaveLength(4);

      expect(fireEvent.keyDown(search, { key: "ArrowRight" })).toBe(true);
      expect(fireEvent.keyDown(search, { key: "ArrowLeft" })).toBe(true);
      expect(activeTile()).toBe(tiles[0]);
      fireEvent.keyDown(search, { key: "ArrowUp" });
      expect(activeTile()).toBe(tiles[3]);
      fireEvent.keyDown(search, { key: "ArrowDown" });
      expect(activeTile()).toBe(tiles[0]);
      fireEvent.keyDown(search, { key: "ArrowDown" });
      expect(activeTile()).toBe(tiles[1]);
    });

    it("clamps the active app into range when the app list shrinks", async () => {
      render(<AppLauncher />);
      const search = screen.getByLabelText("Search apps");
      fireEvent.keyDown(search, { key: "ArrowUp" });
      expect(activeTile()?.getAttribute("aria-label")).toBe("Sushi Counter");

      act(() => seedDesktopApps([{ slug: "alpha", name: "Alpha" }, { slug: "beta", name: "Beta" }, { slug: "bravo", name: "Bravo" }]));
      await waitFor(() => expect(activeTile()?.getAttribute("aria-label")).toBe("Bravo"));
      // Fault: stepping from the stale unclamped index left the highlight stuck on the last app.
      fireEvent.keyDown(search, { key: "ArrowUp" });
      expect(activeTile()?.getAttribute("aria-label")).toBe("Beta");
    });
  });
});
