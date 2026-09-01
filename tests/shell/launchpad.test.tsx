// @vitest-environment jsdom
import React from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MissionControl } from "../../shell/src/components/MissionControl.js";
import { SHELL_Z_INDEX } from "../../shell/src/lib/shell-layering.js";
import {
  computeLaunchpadColumns,
  computeLaunchpadRows,
} from "../../shell/src/components/launchpad/launchpad-utils.js";
import { useWindowManager } from "../../shell/src/hooks/useWindowManager.js";
import { createShellQueryClient } from "../../shell/src/api/query-client.js";
import { appKeys } from "../../shell/src/api/apps.js";

vi.mock("@/hooks/useTaskBoard", () => ({
  useTaskBoard: () => ({
    provision: { active: false, total: 0, succeeded: 0, failed: 0 },
  }),
}));

interface TestApp {
  name: string;
  path: string;
  iconUrl?: string;
}

const defaultApps: TestApp[] = [
  { name: "Terminal", path: "__terminal__", iconUrl: "/icons/terminal.png" },
  { name: "Notes", path: "apps/notes/index.html", iconUrl: "/icons/notes.png" },
  { name: "Chess", path: "apps/games/chess/index.html", iconUrl: "/icons/chess.png" },
];

/**
 * MissionControl only mounts its content on the `open` rising edge
 * (false -> true), so the harness renders closed first, then opens.
 */
async function renderLauncher(opts: { apps?: TestApp[] } = {}) {
  const handlers = {
    onOpenApp: vi.fn(),
    onClose: vi.fn(),
    onTogglePin: vi.fn(),
    onRegenerateIcon: vi.fn(),
    onRenameApp: vi.fn(),
    onRemoveFromCanvas: vi.fn(),
    onCreateApp: vi.fn(),
    onAddToDesktop: vi.fn(),
  };
  const props = {
    apps: opts.apps ?? defaultApps,
    openWindows: new Set<string>(),
    pinnedApps: [] as string[],
    ...handlers,
  };
  let result!: ReturnType<typeof render>;
  const queryClient = createShellQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  await act(async () => {
    result = render(
      <QueryClientProvider client={queryClient}>
        <MissionControl open={false} {...props} />
      </QueryClientProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    result.rerender(
      <QueryClientProvider client={queryClient}>
        <MissionControl open {...props} />
      </QueryClientProvider>,
    );
    await Promise.resolve();
  });
  return { ...result, handlers, queryClient };
}

function setDesign(style: string) {
  document.documentElement.setAttribute("data-theme-style", style);
}

function setViewport(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true, writable: true });
  Object.defineProperty(window, "innerHeight", { value: height, configurable: true, writable: true });
}

describe("Launchpad (macos-glass launcher)", () => {
  // Reset before (not after) each test: removing the attribute while a
  // launcher is still mounted would fire useThemeStyle's MutationObserver
  // outside act(). RTL's cleanup unmounts before the next beforeEach runs.
  beforeEach(() => {
    document.documentElement.removeAttribute("data-theme-style");
    setViewport(1024, 768);
    // MissionControl double-buffers its enter transition with rAF; run the
    // callbacks synchronously so `visible` flips inside act().
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.style.overflow = "";
    act(() => useWindowManager.setState({ appLaunchTimes: {} }));
  });

  it("keeps current apps visible until the launcher refresh completes", async () => {
    let resolveResponse!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    vi.stubGlobal("fetch", vi.fn(() => response));

    const { queryClient } = await renderLauncher();

    expect(screen.getByRole("button", { name: "Notes" })).toBeTruthy();

    await act(async () => {
      resolveResponse(new Response(JSON.stringify([{
        name: "Fresh App",
        path: "/files/apps/fresh/index.html",
        slug: "fresh",
      }]), { status: 200, headers: { "Content-Type": "application/json" } }));
      await response;
    });

    await waitFor(() => expect(queryClient.getQueryData(appKeys.list())).toEqual([{
      name: "Fresh App",
      path: "/files/apps/fresh/index.html",
      slug: "fresh",
    }]));
  });

  it.each(["flat", "macos-glass"])(
    "keeps the canonical app order after apps are launched under %s",
    async (style) => {
      setDesign(style);
      const apps: TestApp[] = [
        { name: "Terminal", path: "__terminal__", iconUrl: "/icons/terminal.png" },
        { name: "Notes", path: "apps/notes/index.html", iconUrl: "/icons/notes.png" },
        { name: "Calculator", path: "apps/calculator/index.html", iconUrl: "/icons/calculator.png" },
        { name: "Chess", path: "apps/games/chess/index.html", iconUrl: "/icons/chess.png" },
        { name: "2048", path: "apps/games/2048/index.html", iconUrl: "/icons/game-center.png" },
      ];
      act(() => {
        useWindowManager.setState({
          appLaunchTimes: {
            "apps/notes/index.html": 200,
            "apps/games/chess/index.html": 100,
          },
        });
      });

      const { container } = await renderLauncher({ apps });
      const selector = style === "macos-glass" ? "[data-launchpad-tile]" : "[data-app-tile]";
      const names = Array.from(container.querySelectorAll<HTMLElement>(selector)).map((tile) =>
        tile.textContent?.trim(),
      );

      expect(names).toEqual(["Create app", "Terminal", "Notes", "Calculator", "Chess", "2048"]);
    },
  );

  it("renders the classic launcher for non-macOS designs", async () => {
    for (const style of ["flat", "winxp", "win11", "neumorphic"]) {
      setDesign(style);
      const { container, unmount } = await renderLauncher();
      const launcher = container.querySelector<HTMLElement>("[data-mission-control]");
      expect(launcher).toBeTruthy();
      expect(launcher?.style.zIndex).toBe(String(SHELL_Z_INDEX.launchpad));
      expect(container.querySelector("[data-launchpad]")).toBeNull();
      unmount();
    }
  });

  it("renders Launchpad instead of the classic grid under macos-glass", async () => {
    setDesign("macos-glass");
    const { container } = await renderLauncher();

    expect(container.querySelector("[data-launchpad]")).toBeTruthy();
    expect(container.querySelector("[data-launchpad-backdrop]")).toBeTruthy();
    expect(container.querySelector("[data-mission-backdrop]")).toBeNull();

    const search = screen.getByRole("textbox", { name: "Search apps" });
    expect(search).toBeTruthy();
    expect(document.activeElement).toBe(search);

    expect(screen.getByRole("button", { name: "Terminal" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create app" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Notes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Chess" })).toBeTruthy();
    expect(
      (container.querySelector("[data-launchpad-grid]") as HTMLElement).style.gridTemplateColumns,
    ).toContain("repeat(4,");
    // One page of apps: no page dots.
    expect(screen.queryByRole("button", { name: /go to page/i })).toBeNull();
  });

  it("matches Electron Desktop's fixed launcher icon treatment", async () => {
    setDesign("macos-glass");
    const apps: TestApp[] = [
      { name: "Chat", path: "__chat__" },
      { name: "Terminal", path: "__terminal__" },
      { name: "Files", path: "__file-browser__" },
      { name: "Editor", path: "__editor__" },
      { name: "Settings", path: "__settings__" },
      { name: "Plugins", path: "__plugins__" },
      { name: "Browser", path: "apps/browser/dist/index.html" },
    ];

    await renderLauncher({ apps });

    const expectedBackgrounds = new Map([
      ["Chat", "var(--surface-error-emphasis, #BA5236)"],
      ["Terminal", "var(--surface-warning-emphasis, #E0AA52)"],
      ["Files", "var(--surface-brand-emphasis, #748E59)"],
      ["Editor", "rgb(77, 127, 168)"],
      ["Settings", "var(--surface-neutral-emphasis, #6B7280)"],
      ["Plugins", "rgb(124, 109, 180)"],
      ["Browser", "var(--surface-info-emphasis, #3B85BA)"],
    ]);

    for (const [name, background] of expectedBackgrounds) {
      const tile = screen.getByRole("button", { name });
      const icon = tile.querySelector<HTMLElement>("[data-launchpad-built-in-icon]");
      expect(icon).toBeTruthy();
      expect(icon?.style.background).toBe(background);
      expect(icon?.querySelector("svg")).toBeTruthy();
      expect(icon?.textContent).toBe("");
    }

    const createIcon = screen.getByRole("button", { name: "Create app" })
      .querySelector<HTMLElement>("[data-launchpad-create-icon]");
    expect(createIcon?.style.background).toBe("var(--accent)");
    expect(createIcon?.style.color).toBe("white");
  });

  it("launches Create app through the dedicated first tile", async () => {
    setDesign("macos-glass");
    const { handlers, container } = await renderLauncher();

    const firstTile = container.querySelector<HTMLElement>("[data-launchpad-tile]");
    expect(firstTile?.getAttribute("aria-label")).toBe("Create app");
    fireEvent.click(screen.getByRole("button", { name: "Create app" }));

    expect(handlers.onCreateApp).toHaveBeenCalledOnce();
    expect(handlers.onOpenApp).not.toHaveBeenCalledWith("Create app", expect.anything());
  });

  it("adds a launcher app to the Desktop from its context menu", async () => {
    setDesign("macos-glass");
    const { handlers } = await renderLauncher();

    fireEvent.contextMenu(screen.getByRole("button", { name: "Notes" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Add Notes to Desktop" }));

    expect(handlers.onAddToDesktop).toHaveBeenCalledWith("apps/notes/index.html");
  });

  it("keeps OS-view destinations launcher-only", async () => {
    setDesign("macos-glass");
    const { handlers } = await renderLauncher({
      apps: [{ name: "Web Canvas", path: "__os-view-canvas__", iconUrl: "/icons/canvas.svg" }],
    });

    fireEvent.contextMenu(screen.getByRole("button", { name: "Web Canvas" }));

    expect(screen.queryByRole("menuitem", { name: "Add Web Canvas to Desktop" })).toBeNull();
    expect(handlers.onAddToDesktop).not.toHaveBeenCalled();
  });

  it("reserves the grid padding and gaps so launchpad stays centered in the viewport", () => {
    expect(computeLaunchpadColumns(560)).toBe(3);
    expect(computeLaunchpadColumns(1024)).toBe(6);
    expect(computeLaunchpadColumns(1440)).toBe(7);
    expect(computeLaunchpadRows(500)).toBe(1);
  });

  it("filters the grid by app name via the search field", async () => {
    setDesign("macos-glass");
    await renderLauncher();

    fireEvent.change(screen.getByRole("textbox", { name: "Search apps" }), {
      target: { value: "ches" },
    });
    expect(screen.queryByRole("button", { name: "Notes" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Terminal" })).toBeNull();
    expect(screen.getByRole("button", { name: "Chess" })).toBeTruthy();

    fireEvent.change(screen.getByRole("textbox", { name: "Search apps" }), {
      target: { value: "zzz" },
    });
    expect(screen.queryByRole("button", { name: "Chess" })).toBeNull();
    expect(screen.getByText(/no apps match/i)).toBeTruthy();
  });

  it("closes on backdrop click", async () => {
    setDesign("macos-glass");
    const { container, handlers } = await renderLauncher();

    fireEvent.click(container.querySelector("[data-launchpad-backdrop]") as HTMLElement);
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
    expect(handlers.onOpenApp).not.toHaveBeenCalled();
  });

  it("closes on Escape", async () => {
    setDesign("macos-glass");
    const { handlers } = await renderLauncher();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });

  it("opens apps through the same onOpenApp + onClose path as the classic grid", async () => {
    setDesign("macos-glass");
    const launchpad = await renderLauncher();
    fireEvent.click(screen.getByRole("button", { name: "Notes" }));
    expect(launchpad.handlers.onOpenApp).toHaveBeenCalledWith("Notes", "apps/notes/index.html");
    expect(launchpad.handlers.onClose).toHaveBeenCalledTimes(1);
    launchpad.unmount();

    setDesign("flat");
    const classic = await renderLauncher();
    const classicTile = Array.from(
      classic.container.querySelectorAll<HTMLElement>("[data-app-tile]"),
    ).find((el) => el.textContent?.includes("Notes"));
    expect(classicTile).toBeTruthy();
    fireEvent.click(classicTile as HTMLElement);
    expect(classic.handlers.onOpenApp).toHaveBeenCalledWith("Notes", "apps/notes/index.html");
    expect(classic.handlers.onClose).toHaveBeenCalledTimes(1);
  });

  it("paginates with dots when the grid overflows one page", async () => {
    setDesign("macos-glass");
    // 4 columns x 2 rows = 8 tiles per page at this viewport, including
    // Launchpad's horizontal padding and row/column gaps.
    setViewport(680, 600);
    const apps: TestApp[] = Array.from({ length: 10 }, (_, i) => ({
      name: `App ${i + 1}`,
      path: `apps/app-${i + 1}/index.html`,
    }));
    await renderLauncher({ apps });

    expect(screen.queryByRole("button", { name: "App 7" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "App 8" })).toBeNull();

    const dots = screen.getAllByRole("button", { name: /go to page/i });
    expect(dots).toHaveLength(2);
    expect(dots[0].getAttribute("aria-current")).toBe("page");
    expect(dots[1].getAttribute("aria-current")).toBeNull();

    fireEvent.click(dots[1]);
    expect(screen.queryByRole("button", { name: "App 1" })).toBeNull();
    expect(screen.getByRole("button", { name: "App 8" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "App 9" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "App 10" })).toBeTruthy();
    expect(dots[1].getAttribute("aria-current")).toBe("page");
  });

  it("locks body scroll while open and restores it on unmount", async () => {
    setDesign("macos-glass");
    const { unmount } = await renderLauncher();

    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).toBe("");
  });
});
