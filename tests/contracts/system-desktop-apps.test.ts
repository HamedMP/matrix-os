import { describe, expect, it } from "vitest";
import { SYSTEM_DESKTOP_APPS } from "../../packages/contracts/src/system-desktop-apps.js";

describe("system Desktop app catalog", () => {
  it("defines every first-class OS View app once and in launcher order", () => {
    expect(SYSTEM_DESKTOP_APPS.map((app) => app.id)).toEqual([
      "chat",
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
    expect(new Set(SYSTEM_DESKTOP_APPS.map((app) => app.iconKey)).size).toBe(10);
  });

  it("keeps the Chat and Notes visual identity used by native Desktop", () => {
    expect(SYSTEM_DESKTOP_APPS.find((app) => app.id === "chat")).toMatchObject({
      iconKey: "message-square",
      color: "var(--surface-error-emphasis, #BA5236)",
      iconColor: "white",
    });
    expect(SYSTEM_DESKTOP_APPS.find((app) => app.id === "notes")).toMatchObject({
      iconKey: "notebook",
      color: "var(--surface-purple-emphasis)",
      iconColor: "white",
    });
  });
});
