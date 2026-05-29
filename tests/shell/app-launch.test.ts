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

  it("uses shipped SVG icon URLs when no PNG is shipped", () => {
    expect(iconUrlForSlug("terminal")).toBe("/icons/terminal.svg");
    expect(iconUrlForSlug("folder")).toBe("/icons/folder.svg");
    expect(iconUrlForSlug("chat")).toBe("/icons/chat.svg");
    expect(iconUrlForSlug("game-center")).toBe("/icons/game-center.png");
  });

  it("keeps project context for valid project slugs that are not icon slugs", () => {
    expect(terminalContextLaunchPath("matrix_os")).toBe("__terminal__?project=matrix_os");
    expect(terminalContextLaunchPath("org/matrix_os")).toBe("__terminal__?project=org%2Fmatrix_os");
    expect(terminalContextLaunchPath("../matrix")).toBe("__terminal__");
  });
});
