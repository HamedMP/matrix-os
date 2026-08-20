// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { appIconUrl, preloadAppIcons, resetAppsRuntime, useApps } from "../../desktop/src/renderer/src/stores/apps";

describe("desktop app icon warmup", () => {
  afterEach(() => {
    resetAppsRuntime();
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

    resetAppsRuntime();

    expect(document.head.querySelectorAll('link[rel="preload"][as="image"]')).toHaveLength(0);
  });

  it("waits for an already-running catalog request before a second consumer continues", async () => {
    let resolveCatalog!: (value: unknown) => void;
    const api = {
      get: vi.fn(() => new Promise<unknown>((resolve) => {
        resolveCatalog = resolve;
      })),
    };

    const first = useApps.getState().load(api as never);
    const second = useApps.getState().load(api as never);
    resolveCatalog({ apps: [{ slug: "notes", name: "Notes" }] });

    await Promise.all([first, second]);

    expect(api.get).toHaveBeenCalledOnce();
    expect(useApps.getState().apps).toEqual([{ slug: "notes", name: "Notes" }]);
  });

  it("preserves the primary-runtime icon URL", () => {
    expect(appIconUrl("https://platform.test/", "notes")).toBe("https://platform.test/icons/notes.png");
  });
});
