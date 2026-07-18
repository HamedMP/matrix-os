// @vitest-environment jsdom
import React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEntry, AppWindow } from "../../shell/src/hooks/useWindowManager.js";
import { WindowsTaskbar } from "../../shell/src/components/taskbar/WindowsTaskbar.js";

vi.mock("@clerk/nextjs", () => ({
  useUser: () => ({ user: { fullName: "Test User", imageUrl: undefined } }),
}));

const defaultApps: AppEntry[] = [
  { name: "Notes", path: "apps/notes/index.html", iconUrl: "/icons/notes.png" },
  { name: "Chess", path: "apps/games/chess/index.html", iconUrl: "/icons/chess.png" },
];

function makeWindow(overrides: Partial<AppWindow> & { id: string }): AppWindow {
  return {
    title: "Window",
    path: "apps/notes/index.html",
    x: 0,
    y: 0,
    width: 640,
    height: 480,
    minimized: false,
    zIndex: 1,
    ...overrides,
  };
}

async function renderTaskbar(opts: { apps?: AppEntry[]; windows?: AppWindow[] } = {}) {
  const handlers = {
    onOpenApp: vi.fn(),
    onFocusWindow: vi.fn(),
    onMinimizeWindow: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenCommandPalette: vi.fn(),
  };
  let result!: ReturnType<typeof render>;
  // The useThemeStyle hook mirrors data-theme-style via an effect + a
  // MutationObserver whose callbacks are microtasks; flush both inside act.
  await act(async () => {
    result = render(
      <WindowsTaskbar
        apps={opts.apps ?? defaultApps}
        windows={opts.windows ?? []}
        {...handlers}
      />,
    );
    await Promise.resolve();
  });
  return { ...result, handlers };
}

function setDesign(style: string) {
  document.documentElement.setAttribute("data-theme-style", style);
}

describe("WindowsTaskbar", () => {
  // Reset before (not after) each test: removing the attribute while a
  // taskbar is still mounted would fire useThemeStyle's MutationObserver
  // outside act(). RTL's cleanup unmounts before the next beforeEach runs.
  beforeEach(() => {
    document.documentElement.removeAttribute("data-theme-style");
  });

  it("renders nothing for non-Windows designs", async () => {
    for (const style of ["flat", "macos-glass", "neumorphic"]) {
      setDesign(style);
      const { container, unmount } = await renderTaskbar();
      expect(container.innerHTML).toBe("");
      unmount();
    }
  });

  it("renders the XP taskbar with start button, quick launch, task buttons and tray clock", async () => {
    setDesign("winxp");
    const windows = [
      makeWindow({ id: "w-notes", title: "Notes", zIndex: 2 }),
      makeWindow({ id: "w-chess", title: "Chess", path: "apps/games/chess/index.html", zIndex: 1, minimized: true }),
    ];
    const { container } = await renderTaskbar({ windows });

    expect(container.querySelector("[data-xp-taskbar]")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Quick launch Terminal" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Notes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Chess" })).toBeTruthy();
    const tray = container.querySelector(".xp-tray");
    expect(tray?.textContent).toMatch(/\d{1,2}:\d{2}/);
  });

  it("renders the Win11 taskbar with centered icons and a two-line tray clock", async () => {
    setDesign("win11");
    const windows = [makeWindow({ id: "w-notes", title: "Notes", zIndex: 2 })];
    const { container } = await renderTaskbar({ windows });

    expect(container.querySelector("[data-win11-taskbar]")).toBeTruthy();
    const center = container.querySelector(".win11-taskbar-center");
    expect(center).toBeTruthy();
    expect(within(center as HTMLElement).getByRole("button", { name: "Start" })).toBeTruthy();
    expect(within(center as HTMLElement).getByRole("button", { name: "Search" })).toBeTruthy();
    expect(within(center as HTMLElement).getByRole("button", { name: "Terminal" })).toBeTruthy();
    // Open window joins the centered row with an underline pill.
    const notesButton = within(center as HTMLElement).getByRole("button", { name: "Notes" });
    expect(notesButton.querySelector(".win11-task-pill")).toBeTruthy();
    const clock = container.querySelector(".win11-tray-clock");
    expect(clock?.textContent).toMatch(/\d{1,2}:\d{2}/);
    expect(clock?.textContent).toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/);
  });

  it("opens and closes the XP start menu via the start button", async () => {
    setDesign("winxp");
    const { container } = await renderTaskbar();
    const startButton = screen.getByRole("button", { name: "Start" });

    expect(container.querySelector("[data-xp-start-menu]")).toBeNull();
    fireEvent.click(startButton);
    const menu = container.querySelector("[data-xp-start-menu]");
    expect(menu).toBeTruthy();
    expect(within(menu as HTMLElement).getByText("Test User")).toBeTruthy();
    expect(within(menu as HTMLElement).getByRole("button", { name: "All Programs" })).toBeTruthy();
    expect(within(menu as HTMLElement).getByRole("button", { name: "Log Off" })).toBeTruthy();
    expect(within(menu as HTMLElement).getByRole("button", { name: "Turn Off Computer" })).toBeTruthy();

    fireEvent.click(startButton);
    expect(container.querySelector("[data-xp-start-menu]")).toBeNull();
  });

  it("closes the XP start menu on Escape and on outside pointer down", async () => {
    setDesign("winxp");
    const { container } = await renderTaskbar();
    const startButton = screen.getByRole("button", { name: "Start" });

    fireEvent.click(startButton);
    expect(container.querySelector("[data-xp-start-menu]")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(container.querySelector("[data-xp-start-menu]")).toBeNull();

    fireEvent.click(startButton);
    expect(container.querySelector("[data-xp-start-menu]")).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(container.querySelector("[data-xp-start-menu]")).toBeNull();
  });

  it("toggles XP task buttons: restore minimized, minimize focused, focus unfocused", async () => {
    setDesign("winxp");
    const windows = [
      makeWindow({ id: "w-focused", title: "Focused", zIndex: 3 }),
      makeWindow({ id: "w-min", title: "Minimized", zIndex: 2, minimized: true }),
      makeWindow({ id: "w-other", title: "Other", zIndex: 1 }),
    ];
    const { handlers } = await renderTaskbar({ windows });

    fireEvent.click(screen.getByRole("button", { name: "Minimized" }));
    expect(handlers.onFocusWindow).toHaveBeenCalledWith("w-min");

    fireEvent.click(screen.getByRole("button", { name: "Focused" }));
    expect(handlers.onMinimizeWindow).toHaveBeenCalledWith("w-focused");

    fireEvent.click(screen.getByRole("button", { name: "Other" }));
    expect(handlers.onFocusWindow).toHaveBeenCalledWith("w-other");
  });

  it("launches built-in entries from the XP start menu and closes it", async () => {
    setDesign("winxp");
    const { container, handlers } = await renderTaskbar();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    const menu = container.querySelector("[data-xp-start-menu]") as HTMLElement;

    fireEvent.click(within(menu).getByRole("button", { name: "Terminal" }));
    expect(handlers.onOpenApp).toHaveBeenCalledWith("__terminal__", "Terminal");
    expect(container.querySelector("[data-xp-start-menu]")).toBeNull();
  });

  it("expands All Programs to the full apps list and launches an app", async () => {
    setDesign("winxp");
    const { container, handlers } = await renderTaskbar();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    fireEvent.click(screen.getByRole("button", { name: "All Programs" }));
    const allPrograms = container.querySelector("[data-xp-all-programs]") as HTMLElement;
    expect(allPrograms).toBeTruthy();
    expect(within(allPrograms).getByRole("button", { name: "Notes" })).toBeTruthy();
    expect(within(allPrograms).getByRole("button", { name: "Chess" })).toBeTruthy();

    fireEvent.click(within(allPrograms).getByRole("button", { name: "Chess" }));
    expect(handlers.onOpenApp).toHaveBeenCalledWith("apps/games/chess/index.html", "Chess");
    expect(container.querySelector("[data-xp-start-menu]")).toBeNull();
  });

  it("wires XP right-column places: files, settings and command palette", async () => {
    setDesign("winxp");
    const { container, handlers } = await renderTaskbar();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    let menu = container.querySelector("[data-xp-start-menu]") as HTMLElement;

    fireEvent.click(within(menu).getByRole("button", { name: "My Documents" }));
    expect(handlers.onOpenApp).toHaveBeenCalledWith("__file-browser__", "Files");
    expect(container.querySelector("[data-xp-start-menu]")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    menu = container.querySelector("[data-xp-start-menu]") as HTMLElement;
    fireEvent.click(within(menu).getByRole("button", { name: "Control Panel" }));
    expect(handlers.onOpenSettings).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[data-xp-start-menu]")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    menu = container.querySelector("[data-xp-start-menu]") as HTMLElement;
    fireEvent.click(within(menu).getByRole("button", { name: "Help and Support" }));
    expect(handlers.onOpenCommandPalette).toHaveBeenCalledTimes(1);
  });

  it("opens the Win11 start menu, filters apps via search and launches a result", async () => {
    setDesign("win11");
    const { container, handlers } = await renderTaskbar();

    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    const menu = container.querySelector("[data-win11-start-menu]") as HTMLElement;
    expect(menu).toBeTruthy();
    expect(within(menu).getByRole("button", { name: "Terminal" })).toBeTruthy();
    expect(within(menu).getByRole("button", { name: "Notes" })).toBeTruthy();

    fireEvent.change(within(menu).getByRole("textbox", { name: "Search apps" }), {
      target: { value: "ches" },
    });
    expect(within(menu).queryByRole("button", { name: "Notes" })).toBeNull();
    const chessTile = within(menu).getByRole("button", { name: "Chess" });
    fireEvent.click(chessTile);
    expect(handlers.onOpenApp).toHaveBeenCalledWith("apps/games/chess/index.html", "Chess");
    expect(container.querySelector("[data-win11-start-menu]")).toBeNull();
  });

  it("focuses the Win11 start menu search field when opened via the search icon", async () => {
    setDesign("win11");
    const { container } = await renderTaskbar();

    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    const menu = container.querySelector("[data-win11-start-menu]") as HTMLElement;
    expect(menu).toBeTruthy();
    const input = within(menu).getByRole("textbox", { name: "Search apps" });
    expect(document.activeElement).toBe(input);
  });

  it("shows the Win11 recommended section and closes on Escape and outside click", async () => {
    setDesign("win11");
    const { container } = await renderTaskbar();

    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    let menu = container.querySelector("[data-win11-start-menu]") as HTMLElement;
    expect(within(menu).getByText("Recommended")).toBeTruthy();
    expect(within(menu).getAllByText("Recently added").length).toBe(2);
    expect(within(menu).getByRole("button", { name: "Power" })).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(container.querySelector("[data-win11-start-menu]")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    menu = container.querySelector("[data-win11-start-menu]") as HTMLElement;
    expect(menu).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(container.querySelector("[data-win11-start-menu]")).toBeNull();
  });

  it("toggles Win11 center icons: minimize focused, restore minimized", async () => {
    setDesign("win11");
    const windows = [
      makeWindow({ id: "w-notes", title: "Notes", zIndex: 2 }),
      makeWindow({ id: "w-chess", title: "Chess", path: "apps/games/chess/index.html", zIndex: 1, minimized: true }),
    ];
    const { handlers } = await renderTaskbar({ windows });

    fireEvent.click(screen.getByRole("button", { name: "Notes" }));
    expect(handlers.onMinimizeWindow).toHaveBeenCalledWith("w-notes");

    fireEvent.click(screen.getByRole("button", { name: "Chess" }));
    expect(handlers.onFocusWindow).toHaveBeenCalledWith("w-chess");
  });

  it("closes the Win11 start menu via the decorative power button", async () => {
    setDesign("win11");
    const { container, handlers } = await renderTaskbar();

    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    const menu = container.querySelector("[data-win11-start-menu]") as HTMLElement;
    fireEvent.click(within(menu).getByRole("button", { name: "Power" }));
    expect(container.querySelector("[data-win11-start-menu]")).toBeNull();
    expect(handlers.onOpenApp).not.toHaveBeenCalled();
    expect(handlers.onOpenSettings).not.toHaveBeenCalled();
  });
});
