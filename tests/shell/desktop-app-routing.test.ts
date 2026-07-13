import { describe, expect, it } from "vitest";

import {
  findAppByName,
  registryPathToRelativePath,
  sameIconAsset,
} from "../../shell/src/components/desktop/desktop-app-routing";

describe("desktop app routing helpers", () => {
  const apps = [
    { name: "Notes" },
    { name: "Project Manager" },
    { name: "Matrix Mail" },
  ];

  it("resolves exact, substring, reverse, and word-level app names", () => {
    expect(findAppByName(apps, "notes")).toEqual({ name: "Notes" });
    expect(findAppByName(apps, "project")).toEqual({ name: "Project Manager" });
    expect(findAppByName(apps, "open matrix mail app")).toEqual({ name: "Matrix Mail" });
    expect(findAppByName(apps, "manager project")).toEqual({ name: "Project Manager" });
  });

  it("ignores empty or unrelated app name queries", () => {
    expect(findAppByName(apps, "   ")).toBeNull();
    expect(findAppByName(apps, "calendar")).toBeNull();
  });

  it("normalizes owner-home module registry paths to shell-relative paths", () => {
    expect(registryPathToRelativePath("~/apps/weather")).toBe("apps/weather");
    expect(registryPathToRelativePath("/home/matrixos/home/apps/notes")).toBe("apps/notes");
    expect(registryPathToRelativePath("/tmp/apps/notes")).toBeNull();
  });

  it("compares icon assets without cache-busting query strings", () => {
    expect(sameIconAsset("/icons/notes.png?v=abc", "/icons/notes.png?v=def")).toBe(true);
    expect(sameIconAsset("https://matrix.test/icons/notes.png?v=abc", "/icons/notes.png")).toBe(true);
    expect(sameIconAsset("/icons/notes.png", "/icons/mail.png")).toBe(false);
  });
});
