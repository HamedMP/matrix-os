import { describe, expect, it } from "vitest";
import { canonicalAppLaunchPath, iconUrlForSlug, terminalContextLaunchPath } from "../../shell/src/lib/app-launch.js";

describe("app launch helpers", () => {
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

  it("uses shipped PNG app icon URLs and SVG URLs for system chrome", () => {
    expect(iconUrlForSlug("2048")).toBe("/icons/2048.png");
    expect(iconUrlForSlug("backgammon")).toBe("/icons/backgammon.png");
    expect(iconUrlForSlug("chess")).toBe("/icons/chess.png");
    expect(iconUrlForSlug("calculator")).toBe("/icons/calculator.png");
    expect(iconUrlForSlug("calorie-tracker")).toBe("/icons/calorie-tracker.png");
    expect(iconUrlForSlug("terminal")).toBe("/icons/terminal.png");
    expect(iconUrlForSlug("workspace")).toBe("/icons/workspace.png");
    expect(iconUrlForSlug("files")).toBe("/icons/files.png");
    expect(iconUrlForSlug("chat")).toBe("/icons/chat.png");
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
  });

  it("keeps project context for valid project slugs that are not icon slugs", () => {
    expect(terminalContextLaunchPath("matrix_os")).toBe("__terminal__?project=matrix_os");
    expect(terminalContextLaunchPath("org/matrix_os")).toBe("__terminal__?project=org%2Fmatrix_os");
    expect(terminalContextLaunchPath("../matrix")).toBe("__terminal__");
  });
});
