import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { reconcileDesignApps } from "../../shell/src/lib/design-apps-refresh";

const normalize = (path: string) => path.replace(/^\/files\//, "");
const iconUrlFor = (app: { slug?: string; icon?: string }) => `/icons/${app.icon ?? app.slug}.png`;

describe("reconcileDesignApps", () => {
  it("rechecks cancellation after parsing before applying refreshed apps", async () => {
    const source = await readFile("shell/src/components/Desktop.tsx", "utf8");
    const effectStart = source.indexOf("// The gateway re-filters design-scoped apps");
    const effectEnd = source.indexOf("const visibleWindowCount", effectStart);
    const effectSource = source.slice(effectStart, effectEnd);

    expect(effectSource).toMatch(
      /const apiApps = \(await res\.json\(\)\) as ApiAppEntry\[\];\s+if \(cancelled\) return;\s+const \{ next, apiPaths \}/,
    );
  });

  it("adds newly matching design-scoped apps with resolved icons", () => {
    const { next, apiPaths } = reconcileDesignApps({
      current: [{ name: "Terminal", path: "__terminal__", iconUrl: "/icons/terminal.png" }],
      apiApps: [{ name: "Minesweeper", path: "/files/apps/winxp-minesweeper/index.html", slug: "winxp-minesweeper" }],
      previousApiPaths: new Set(),
      normalizePath: normalize,
      iconUrlFor,
    });

    expect(next).toHaveLength(2);
    expect(next[1]).toEqual({
      name: "Minesweeper",
      path: "apps/winxp-minesweeper/index.html",
      iconUrl: "/icons/winxp-minesweeper.png",
    });
    expect(apiPaths.has("apps/winxp-minesweeper/index.html")).toBe(true);
  });

  it("removes apps that left scope, but only when they came from the previous API list", () => {
    const current = [
      { name: "Terminal", path: "__terminal__", iconUrl: "/icons/terminal.png" },
      { name: "Minesweeper", path: "apps/winxp-minesweeper/index.html", iconUrl: "/icons/m.png" },
      // A module-registered app that shares the apps/ prefix but was never
      // returned by /api/apps: must survive the reconcile.
      { name: "Module Game", path: "apps/games/chess/index.html", iconUrl: "/icons/c.png" },
      // The user's own custom app: always listed (no designs field).
      { name: "My App", path: "apps/my-app/index.html", iconUrl: "/icons/a.png" },
    ];
    const { next, apiPaths } = reconcileDesignApps({
      current,
      apiApps: [{ name: "My App", path: "/files/apps/my-app/index.html", slug: "my-app" }],
      previousApiPaths: new Set(["apps/winxp-minesweeper/index.html", "apps/my-app/index.html"]),
      normalizePath: normalize,
      iconUrlFor,
    });

    expect(next.map((app) => app.name)).toEqual(["Terminal", "Module Game", "My App"]);
    // The existing My App entry is kept as-is (no duplicate, no churn).
    expect(next[2].iconUrl).toBe("/icons/a.png");
    expect(apiPaths.has("apps/winxp-minesweeper/index.html")).toBe(false);
  });

  it("is a no-op when the API list matches the current store", () => {
    const current = [
      { name: "My App", path: "apps/my-app/index.html", iconUrl: "/icons/a.png" },
    ];
    const { next } = reconcileDesignApps({
      current,
      apiApps: [{ name: "My App", path: "/files/apps/my-app/index.html", slug: "my-app" }],
      previousApiPaths: new Set(["apps/my-app/index.html"]),
      normalizePath: normalize,
      iconUrlFor,
    });

    expect(next).toEqual(current);
  });
});
