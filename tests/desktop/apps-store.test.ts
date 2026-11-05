// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { appIconUrl, clearPreloadedAppIcons, parseApps, preloadAppIcons } from "../../desktop/src/renderer/src/features/apps/apps.api";

describe("desktop app icon warmup", () => {
  afterEach(() => {
    clearPreloadedAppIcons();
  });

  it("warms only the first 20 selected-runtime icons without declaring them immediately required", () => {
    preloadAppIcons("https://platform.test/", "preview", Array.from({ length: 24 }, (_, index) => ({
      slug: `app-${index}`,
      name: `App ${index}`,
    })));

    expect(document.head.querySelectorAll('link[rel="preload"][as="image"]')).toHaveLength(0);
    const links = [...document.head.querySelectorAll('link[rel="prefetch"][as="image"]')];
    expect(links).toHaveLength(20);
    expect(links[0]?.getAttribute("href")).toBe("https://platform.test/icons/app-0.png?runtime=preview");
    expect(links.at(-1)?.getAttribute("href")).toBe("https://platform.test/icons/app-19.png?runtime=preview");
  });

  it("replaces warmup hints when the runtime changes and clears them on sign-out", () => {
    preloadAppIcons("https://platform.test", "primary", [{ slug: "notes", name: "Notes" }]);
    preloadAppIcons("https://platform.test", "preview", [{ slug: "editor", name: "Editor" }]);
    const links = [...document.head.querySelectorAll('link[rel="prefetch"][as="image"]')];
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("https://platform.test/icons/editor.png?runtime=preview");
    clearPreloadedAppIcons();
    expect(document.head.querySelectorAll('link[rel="prefetch"][as="image"]')).toHaveLength(0);
  });

  it("preserves the primary-runtime icon URL", () => {
    expect(appIconUrl("https://platform.test/", "notes")).toBe("https://platform.test/icons/notes.png");
  });

  it("uses the catalog's versioned local icon URL across runtime slots", () => {
    const app = {
      slug: "custom-dashboard",
      name: "Custom Dashboard",
      iconUrl: "/icons/custom-brand.png?v=mtime-size",
    };

    expect(appIconUrl("https://platform.test/", app)).toBe(
      "https://platform.test/icons/custom-brand.png?v=mtime-size",
    );
    expect(appIconUrl("https://platform.test/", app, "preview")).toBe(
      "https://platform.test/icons/custom-brand.png?v=mtime-size&runtime=preview",
    );
  });

  it("accepts only local versioned icon URLs from the app catalog", () => {
    expect(parseApps({ apps: [{
      slug: "custom-dashboard",
      name: "Custom Dashboard",
      iconUrl: "/icons/custom-brand.png?v=mtime-size",
    }] })).toEqual([{
      slug: "custom-dashboard",
      name: "Custom Dashboard",
      iconUrl: "/icons/custom-brand.png?v=mtime-size",
    }]);

    expect(parseApps({ apps: [{
      slug: "custom-dashboard",
      name: "Custom Dashboard",
      iconUrl: "https://tracking.invalid/icon.png",
    }] })[0]).not.toHaveProperty("iconUrl");
  });

  it("retains the canonical nested app identity used by Postgres schemas", () => {
    expect(parseApps({ apps: [{
      slug: "2048",
      name: "2048",
      file: "games/2048/index.html",
    }] })).toEqual([{
      slug: "2048",
      name: "2048",
      path: "apps/games/2048/index.html",
      appIdentity: "games/2048",
    }]);
  });

  it("makes existing generated apps placeable from either catalog path shape", () => {
    expect(parseApps({ apps: [{
      slug: "sushi-counter",
      name: "Sushi Counter",
      file: "sushi-counter/index.html",
      path: "/files/apps/sushi-counter/index.html",
    }] })).toEqual([{
      slug: "sushi-counter",
      name: "Sushi Counter",
      path: "apps/sushi-counter/index.html",
      appIdentity: "sushi-counter",
    }]);
  });

  it("parses the complete catalog without client-side truncation", () => {
    const apps = Array.from({ length: 201 }, (_, index) => ({ slug: `app-${index}`, name: `App ${index}` }));
    expect(parseApps({ apps })).toHaveLength(201);
  });
});
