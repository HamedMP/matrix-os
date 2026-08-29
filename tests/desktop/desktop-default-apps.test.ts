import { describe, expect, it } from "vitest";
import { FIXED_DESKTOP_APPS } from "@desktop/renderer/src/features/desktop-shell/desktop-apps";

describe("native desktop default apps", () => {
  it("ships Chat first with the ten canonical desktop destinations in product order", () => {
    expect(FIXED_DESKTOP_APPS.map((app) => app.id)).toEqual([
      "work",
      "terminal",
      "files",
      "editor",
      "vscode",
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
    expect(FIXED_DESKTOP_APPS.find((app) => app.id === "editor")).toMatchObject({
      kind: "editor",
      name: "Editor",
    });
    expect(FIXED_DESKTOP_APPS.find((app) => app.id === "vscode")).toMatchObject({
      kind: "vscode",
      name: "VS Code",
    });
    expect(FIXED_DESKTOP_APPS.find((app) => app.id === "plugins")).toMatchObject({
      kind: "settings",
      settingsSection: "services",
    });
    expect(FIXED_DESKTOP_APPS.find((app) => app.id === "notes")).toMatchObject({
      kind: "notes",
    });
    expect(FIXED_DESKTOP_APPS.find((app) => app.id === "whiteboard")).toMatchObject({
      kind: "app",
      slug: "whiteboard",
    });
  });
});
