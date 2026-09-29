import { describe, expect, it } from "vitest";

import {
  registryPathToRelativePath,
  sameIconAsset,
} from "../../shell/src/components/desktop/desktop-app-routing";

describe("desktop app routing helpers", () => {
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
