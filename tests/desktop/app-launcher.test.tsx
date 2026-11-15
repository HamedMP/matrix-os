// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AppLauncher from "../../desktop/src/renderer/src/features/embeds/AppLauncher";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";
import { OS_VIEW_FIXED_APP_NAMES } from "../fixtures/os-view-parity";
import { clearDesktopApps, seedDesktopApps } from "./apps-query-test-utils";
import { notifyCollaborationDiscoveryChanged } from "../../packages/ui/src/collaboration/discovery-events";
import SurfaceIcon from "../../desktop/src/renderer/src/features/desktop-shell/SurfaceIcon";

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
  });

  afterEach(() => {
    cleanup();
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

  it.each(["surface", "launchpad"] as const)("shows the owner's shared app name and platform artwork in the %s launcher", async (presentation) => {
    const iconPath = `/api/collaboration/shared-apps/10000000-0000-4000-8000-000000000001/artwork/${"c".repeat(64)}`;
    const target = {
      scopeId: "10000000-0000-4000-8000-000000000001", runtimeId: "runtime_owner",
      organizationId: "org_team", authorityGeneration: 1, appId: "shared-tasks-lab",
      catalogId: "30000000-0000-4000-8000-000000000001",
      readinessId: "40000000-0000-4000-8000-000000000001",
      registrationIncarnation: "a".repeat(64), buildId: "b".repeat(64), shareRevision: "1",
      owner: { actorId: "user_owner", displayName: "Owner" },
      presentation: { name: "Sprint Board", iconUrl: iconPath },
    };
    useConnection.setState({ userId: "user_member", organizationId: "org_team", organizationStatus: "member" });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({ items: [target] }), {
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(<AppLauncher presentation={presentation} />);
    const tile = await screen.findByRole("button", { name: "Sprint Board" });
    expect(fetchMock.mock.calls.map(([input]) => String(input)))
      .toContainEqual("https://platform.test/api/collaboration/shared-apps?limit=100&presentation=1");
    expect(tile.querySelector('[aria-label="Shared app"]')).toBeTruthy();
    // The renderer is cross-origin: artwork is requested from the platform, where the trusted core adds auth.
    const artwork = tile.querySelector("img");
    expect(artwork?.getAttribute("src")).toBe(`https://platform.test${iconPath}`);

    fireEvent.error(artwork!);
    const fallback = screen.getByRole("button", { name: "Sprint Board" });
    expect(fallback.querySelector("img")).toBeNull();
    expect(fallback.textContent).toContain("S");
    expect(fallback.querySelector('[aria-label="Shared app"]')).toBeTruthy();

    fireEvent.click(fallback);
    expect(useTabs.getState().tabs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "app", title: "Sprint Board", sharedAppTarget: target }),
    ]));
  });

  it("keeps the owner's shared artwork on the running app's taskbar tab, separate from a same-slug own app", async () => {
    const iconPath = `/api/collaboration/shared-apps/10000000-0000-4000-8000-000000000001/artwork/${"c".repeat(64)}`;
    const target = {
      scopeId: "10000000-0000-4000-8000-000000000001", runtimeId: "runtime_owner",
      organizationId: "org_team", authorityGeneration: 1, appId: "shared-tasks-lab",
      catalogId: "30000000-0000-4000-8000-000000000001",
      readinessId: "40000000-0000-4000-8000-000000000001",
      registrationIncarnation: "a".repeat(64), buildId: "b".repeat(64), shareRevision: "1",
      owner: { actorId: "user_owner", displayName: "Owner" },
      presentation: { name: "Sprint Board", iconUrl: iconPath },
    };
    useConnection.setState({ userId: "user_member", organizationId: "org_team", organizationStatus: "member" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [target] }), {
      headers: { "content-type": "application/json" },
    })));
    render(<AppLauncher presentation="launchpad" />);
    fireEvent.click(await screen.findByRole("button", { name: "Sprint Board" }));
    useTabs.getState().openTab({ kind: "app", slug: "shared-tasks-lab", title: "Shared Tasks Lab", icon: "https://platform.test/icons/own.png" });

    const tabs = useTabs.getState().tabs.filter((tab) => tab.kind === "app");
    const sharedTab = tabs.find((tab) => tab.sharedAppTarget?.scopeId === target.scopeId)!;
    const ownTab = tabs.find((tab) => !tab.sharedAppTarget)!;
    const shared = render(<SurfaceIcon tab={sharedTab} size={44} />);
    expect(shared.container.querySelector("img")?.getAttribute("src")).toBe(`https://platform.test${iconPath}`);
    const own = render(<SurfaceIcon tab={ownTab} size={44} />);
    expect(own.container.querySelector("img")?.getAttribute("src")).toBe("https://platform.test/icons/own.png");

    // The artwork follows the current platform host instead of a URL captured at launch.
    act(() => { useConnection.setState({ platformHost: "https://other-platform.test" }); });
    expect(shared.container.querySelector("img")?.getAttribute("src")).toBe(`https://other-platform.test${iconPath}`);
    // A revoked or stale digest falls back to the surface glyph.
    fireEvent.error(shared.container.querySelector("img")!);
    expect(shared.container.querySelector("img")).toBeNull();
    expect(shared.container.querySelector("svg")).toBeTruthy();
  });

  it("retries shared artwork whenever its URL changes, including a URL that failed earlier", async () => {
    const base = "/api/collaboration/shared-apps/10000000-0000-4000-8000-000000000001/artwork/";
    const target = (digest: string) => ({
      scopeId: "10000000-0000-4000-8000-000000000001", runtimeId: "runtime_owner",
      organizationId: "org_team", authorityGeneration: 1, appId: "shared-tasks-lab",
      catalogId: "30000000-0000-4000-8000-000000000001",
      readinessId: "40000000-0000-4000-8000-000000000001",
      registrationIncarnation: "a".repeat(64), buildId: "b".repeat(64), shareRevision: "1",
      owner: { actorId: "user_owner", displayName: "Owner" },
      presentation: { name: "Sprint Board", iconUrl: `${base}${digest}` },
    });
    let current = target("a".repeat(64));
    useConnection.setState({ userId: "user_member", organizationId: "org_team", organizationStatus: "member" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [current] }), {
      headers: { "content-type": "application/json" },
    })));
    render(<AppLauncher presentation="launchpad" />);
    const tile = await screen.findByRole("button", { name: "Sprint Board" });
    fireEvent.error(tile.querySelector("img")!);
    expect(screen.getByRole("button", { name: "Sprint Board" }).querySelector("img")).toBeNull();

    current = target("b".repeat(64));
    notifyCollaborationDiscoveryChanged();
    await waitFor(() => expect(screen.getByRole("button", { name: "Sprint Board" }).querySelector("img")?.getAttribute("src"))
      .toBe(`https://platform.test${base}${"b".repeat(64)}`));
    current = target("a".repeat(64));
    notifyCollaborationDiscoveryChanged();
    await waitFor(() => expect(screen.getByRole("button", { name: "Sprint Board" }).querySelector("img")?.getAttribute("src"))
      .toBe(`https://platform.test${base}${"a".repeat(64)}`));
  });

  it.each(["loading", "offline"])("opens shared apps while the installed catalog is %s", async (status) => {
    clearDesktopApps();
    useConnection.setState({ userId: "user_member", organizationId: "org_team", organizationStatus: "member",
      api: { get: vi.fn(() => status === "loading" ? new Promise(() => undefined) : Promise.reject(new Error("offline"))) } as never });
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
      api: { get: vi.fn(() => new Promise(() => undefined)) } as never,
    });

    render(<AppLauncher />);

    expect(screen.getByText("Loading apps")).toBeTruthy();
    expect(screen.queryByText(/No apps match/i)).toBeNull();
  });
});
