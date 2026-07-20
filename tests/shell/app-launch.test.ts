import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalAppLaunchPath, iconUrlForSlug, terminalContextLaunchPath } from "../../shell/src/lib/app-launch.js";
import { isGameApp } from "../../shell/src/lib/dock-sections.js";

describe("app launch helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("canonicalizes runtime apps to slug routes before iframe rendering", () => {
    expect(canonicalAppLaunchPath({
      slug: "backgammon",
      launchUrl: "/apps/backgammon/",
      path: "/files/apps/games/backgammon/index.html",
    })).toBe("apps/backgammon/index.html");
  });

  it("canonicalizes nested runtime app slugs without treating them as icon names", () => {
    expect(canonicalAppLaunchPath({
      slug: "games/minesweeper",
      launchUrl: "/apps/games/minesweeper/",
      path: "/files/apps/games/minesweeper/index.html",
    })).toBe("apps/games/minesweeper/index.html");
    expect(iconUrlForSlug("games/minesweeper")).toBeUndefined();
  });

  it("falls back to legacy file paths for non-runtime apps", () => {
    expect(canonicalAppLaunchPath({
      path: "/files/apps/legacy.html",
    })).toBe("apps/legacy.html");
  });

  it("uses shipped skeuomorphic PNG icon URLs and SVG URLs for system chrome", () => {
    expect(iconUrlForSlug("2048")).toBe("/icons/2048.png");
    expect(iconUrlForSlug("backgammon")).toBe("/icons/backgammon.png");
    expect(iconUrlForSlug("calculator")).toBe("/icons/calculator.png");
    expect(iconUrlForSlug("chess")).toBe("/icons/chess.png");
    expect(iconUrlForSlug("terminal")).toBe("/icons/terminal.png");
    expect(iconUrlForSlug("workspace")).toBe("/icons/workspace.png");
    expect(iconUrlForSlug("files")).toBe("/icons/files.png");
    expect(iconUrlForSlug("chat")).toBe("/icons/chat.png");
    expect(iconUrlForSlug("code")).toBe("/icons/code.png");
    expect(iconUrlForSlug("folder")).toBe("/icons/folder.svg");
    expect(iconUrlForSlug("game-center")).toBe("/icons/game-center.png");
    expect(iconUrlForSlug("grid")).toBe("/icons/grid.svg");
    expect(iconUrlForSlug("layers")).toBe("/icons/layers.svg");
    expect(iconUrlForSlug("minesweeper")).toBe("/icons/minesweeper.png");
    expect(iconUrlForSlug("pomodoro")).toBe("/icons/pomodoro-timer.png");
    expect(iconUrlForSlug("pomodoro-timer")).toBe("/icons/pomodoro-timer.png");
    expect(iconUrlForSlug("snake")).toBe("/icons/snake.png");
    expect(iconUrlForSlug("solitaire")).toBe("/icons/solitaire.png");
    expect(iconUrlForSlug("tetris")).toBe("/icons/tetris.png");
    expect(iconUrlForSlug("new-generated-app")).toBe("/icons/new-generated-app.png");
    expect(iconUrlForSlug("matrix_os")).toBe("/icons/matrix_os.png");
  });

  it("scopes icon URLs to the explicit computer and runtime in browser tabs", () => {
    vi.stubGlobal("window", {
      location: {
        origin: "https://app.matrix-os.com",
        pathname: "/vm/pr-1018/",
        search: "?runtime=pr-1018",
      },
    });

    expect(iconUrlForSlug("notes")).toBe(
      "https://app.matrix-os.com/vm/pr-1018/~runtime/pr-1018/icons/notes.png",
    );
  });

  it("classifies only the canonical games subtree as game apps", () => {
    expect(isGameApp("apps/games/snake/index.html")).toBe(true);
    expect(isGameApp("apps/mydir/apps/games/tool/index.html")).toBe(false);
  });

  it("routes project-context launches through the canonical terminal surface", () => {
    expect(terminalContextLaunchPath("matrix_os")).toBe("__terminal__");
    expect(terminalContextLaunchPath("org/matrix_os")).toBe("__terminal__");
    expect(terminalContextLaunchPath("../matrix")).toBe("__terminal__");
  });
});
