import { describe, it, expect } from "vitest";
import { extractSlug, shouldRenderAppIframe } from "../../shell/src/components/AppViewer.js";

describe("AppViewer extractSlug (spec 063 regression)", () => {
  it("extracts slug from top-level app paths", () => {
    expect(extractSlug("apps/calculator/index.html")).toBe("calculator");
    expect(extractSlug("apps/hello-vite/")).toBe("hello-vite");
    expect(extractSlug("apps/games")).toBe("games");
    expect(extractSlug("apps/games/")).toBe("games");
    expect(extractSlug("apps/games/index.html")).toBe("games");
  });

  it("returns null for nested paths (e.g. games/2048)", () => {
    // Nested paths must NOT route through /apps/{slug}/ — they'd hit the
    // parent app's dispatcher and get the wrong index.html.
    expect(extractSlug("apps/games/2048/index.html")).toBeNull();
    expect(extractSlug("apps/games/backgammon/index.html")).toBeNull();
    expect(extractSlug("apps/foo/bar")).toBeNull();
  });

  it("returns null for non-apps paths", () => {
    expect(extractSlug("modules/foo")).toBeNull();
    expect(extractSlug("/files/apps/calculator/index.html")).toBeNull();
    expect(extractSlug("system/icons/foo.png")).toBeNull();
  });

  it("does not iframe built-in shell apps as files", () => {
    expect(shouldRenderAppIframe("__workspace__")).toBe(false);
    expect(shouldRenderAppIframe("__file-browser__")).toBe(false);
    expect(shouldRenderAppIframe("__terminal__:abc")).toBe(false);
    expect(shouldRenderAppIframe("apps/notes/index.html")).toBe(true);
  });

  it("enforces SAFE_SLUG character set", () => {
    expect(extractSlug("apps/UPPERCASE")).toBeNull();
    expect(extractSlug("apps/-leading-dash")).toBeNull();
    expect(extractSlug("apps/with_underscore")).toBeNull();
    expect(extractSlug("apps/with.dot")).toBeNull();
  });
});
