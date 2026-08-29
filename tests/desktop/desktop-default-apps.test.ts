import { describe, expect, it } from "vitest";
import { FIXED_DESKTOP_APPS } from "@desktop/renderer/src/features/desktop-shell/desktop-apps";

describe("native desktop default apps", () => {
  it("ships the eight canonical desktop destinations in product order", () => {
    expect(FIXED_DESKTOP_APPS.map((app) => app.id)).toEqual([
      "work",
      "terminal",
      "files",
      "settings",
      "plugins",
      "browser",
      "notes",
      "whiteboard",
    ]);
  });

  it("keeps every desktop destination identity unique even when surfaces are shared", () => {
    expect(new Set(FIXED_DESKTOP_APPS.map((app) => app.id)).size).toBe(FIXED_DESKTOP_APPS.length);
  });

  it("deep-links first-party app and Settings destinations", () => {
    expect(FIXED_DESKTOP_APPS.find((app) => app.id === "plugins")).toMatchObject({
      kind: "settings",
      settingsSection: "skills",
    });
    expect(FIXED_DESKTOP_APPS.find((app) => app.id === "notes")).toMatchObject({
      kind: "app",
      slug: "notes",
    });
    expect(FIXED_DESKTOP_APPS.find((app) => app.id === "whiteboard")).toMatchObject({
      kind: "app",
      slug: "whiteboard",
    });
  });
});
