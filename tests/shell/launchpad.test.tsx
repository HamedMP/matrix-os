// @vitest-environment jsdom
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MissionControl } from "../../shell/src/components/MissionControl.js";

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
  };
  const props = {
    apps: opts.apps ?? defaultApps,
    openWindows: new Set<string>(),
    pinnedApps: [] as string[],
    ...handlers,
  };
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(<MissionControl open={false} {...props} />);
    await Promise.resolve();
  });
  await act(async () => {
    result.rerender(<MissionControl open {...props} />);
    await Promise.resolve();
  });
  return { ...result, handlers };
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.style.overflow = "";
  });

  it("renders the classic launcher for non-macOS designs", async () => {
    for (const style of ["flat", "winxp", "win11", "neumorphic"]) {
      setDesign(style);
      const { container, unmount } = await renderLauncher();
      expect(container.querySelector("[data-mission-control]")).toBeTruthy();
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
    expect(screen.getByRole("button", { name: "Notes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Chess" })).toBeTruthy();
    // One page of apps: no page dots.
    expect(screen.queryByRole("button", { name: /go to page/i })).toBeNull();
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
    // 4 columns x 2 rows = 8 tiles per page at this viewport.
    setViewport(560, 500);
    const apps: TestApp[] = Array.from({ length: 10 }, (_, i) => ({
      name: `App ${i + 1}`,
      path: `apps/app-${i + 1}/index.html`,
    }));
    await renderLauncher({ apps });

    expect(screen.queryByRole("button", { name: "App 8" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "App 9" })).toBeNull();

    const dots = screen.getAllByRole("button", { name: /go to page/i });
    expect(dots).toHaveLength(2);
    expect(dots[0].getAttribute("aria-current")).toBe("page");
    expect(dots[1].getAttribute("aria-current")).toBeNull();

    fireEvent.click(dots[1]);
    expect(screen.queryByRole("button", { name: "App 1" })).toBeNull();
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
