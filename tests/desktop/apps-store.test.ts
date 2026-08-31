// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { appIconUrl, parseApps, preloadAppIcons } from "../../desktop/src/renderer/src/features/apps/apps.api";

describe("desktop app icon warmup", () => {
  afterEach(() => {
    for (const link of document.head.querySelectorAll('link[rel="preload"][as="image"]')) link.remove();
  });

  it("preloads only the first 20 selected-runtime icons", () => {
    preloadAppIcons("https://platform.test/", "preview", Array.from({ length: 24 }, (_, index) => ({
      slug: `app-${index}`,
      name: `App ${index}`,
    })));

    const links = [...document.head.querySelectorAll('link[rel="preload"][as="image"]')];
    expect(links).toHaveLength(20);
    expect(links[0]?.getAttribute("href")).toBe("https://platform.test/icons/app-0.png?runtime=preview");
    expect(links.at(-1)?.getAttribute("href")).toBe("https://platform.test/icons/app-19.png?runtime=preview");
  });

  it("removes preloads when the runtime changes", () => {
    preloadAppIcons("https://platform.test", "primary", [{ slug: "notes", name: "Notes" }]);

    for (const link of document.head.querySelectorAll('link[rel="preload"][as="image"]')) link.remove();

    expect(document.head.querySelectorAll('link[rel="preload"][as="image"]')).toHaveLength(0);
  });

  it("preserves the primary-runtime icon URL", () => {
    expect(appIconUrl("https://platform.test/", "notes")).toBe("https://platform.test/icons/notes.png");
  });

  it("retains the canonical nested app identity used by Postgres schemas", () => {
    expect(parseApps({ apps: [{
      slug: "2048",
      name: "2048",
      file: "games/2048/index.html",
    }] })).toEqual([{
      slug: "2048",
      name: "2048",
      appIdentity: "games/2048",
    }]);
  });

  it("parses the complete catalog without client-side truncation", () => {
    const apps = Array.from({ length: 201 }, (_, index) => ({ slug: `app-${index}`, name: `App ${index}` }));
    expect(parseApps({ apps })).toHaveLength(201);
  });
});
