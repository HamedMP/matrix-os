import { describe, expect, it } from "vitest";
import { canonicalAppLaunchPath, iconUrlForSlug } from "../../shell/src/lib/app-launch.js";

describe("app launch helpers", () => {
  it("canonicalizes runtime apps to slug routes before iframe rendering", () => {
    expect(canonicalAppLaunchPath({
      slug: "backgammon",
      launchUrl: "/apps/backgammon/",
      path: "/files/apps/games/backgammon/index.html",
    })).toBe("apps/backgammon/index.html");
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
});
