import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("dock icon resolution", () => {
  it("uses React Query as the sole Web Desktop app catalog", async () => {
    const source = await readFile("shell/src/components/Desktop.tsx", "utf8");
    const windowManagerSource = await readFile("shell/src/hooks/useWindowManager.ts", "utf8");

    expect(source).toContain("useQuery({");
    expect(source).toContain("...appsQueryOptions()");
    expect(source).not.toContain("reconcileDesignApps");
    expect(windowManagerSource).not.toContain("apps: AppEntry[]");
    expect(windowManagerSource).not.toContain("setApps:");
  });

  it("uses the shared icon resolver in Desktop instead of a PNG-only local helper", async () => {
    const source = await readFile("shell/src/components/Desktop.tsx", "utf8");

    expect(source).toContain("import { iconUrlForSlug } from \"@/lib/app-launch\"");
    expect(source).not.toContain("function iconUrlForSlug");
    expect(source).not.toContain("/icons/${encodeURIComponent(slug)}.png");
    expect(source).not.toContain("const iconPath = `/icons/${slug}.png`");
    expect(source).toContain("app.iconUrl ?? iconUrlForSlug(app.icon ?? app.slug)");
    expect(source).not.toContain("method: \"HEAD\"");
  });

  it("uses dedicated raster slugs for built-in launcher apps", async () => {
    const [desktopSource, builtInSource] = await Promise.all([
      readFile("shell/src/components/Desktop.tsx", "utf8"),
      readFile("shell/src/lib/builtin-apps.ts", "utf8"),
    ]);

    expect(desktopSource).toContain("buildWebDesktopIconApps(installedApps)");
    expect(builtInSource).toContain('new Set(["__workspace__"])');
    expect(builtInSource).not.toContain('"__workspace__",\n  "__terminal__"');
    expect(desktopSource).toContain("buildWebDesktopLauncherApps(installedApps, desktopMode)");
  });

  it("writes regenerated icons into the React Query catalog", async () => {
    const source = await readFile("shell/src/components/Desktop.tsx", "utf8");

    expect(source).toContain("queryClient.setQueryData<ApiAppEntry[]>(appKeys.list()");
    expect(source).toContain("versionedIconUrl");
  });

  it("uses the shared icon resolver for mobile dock icons", async () => {
    const source = await readFile("shell/src/components/mobile/MobileShell.tsx", "utf8");

    expect(source).toContain("import { iconUrlForSlug } from \"@/lib/app-launch\"");
    expect(source).not.toContain("function iconUrl");
    expect(source).not.toContain("/icons/${slug}.png");
    expect(source).toContain("const svgUrl = src.replace(/\\.[^.]+$/, \".svg\")");
    expect(source).not.toContain("const svgUrl = `/icons/${encodeURIComponent(slug)}.svg`");
  });

  it("ships explicit assets for the mobile dock control slugs", async () => {
    const [grid, layers] = await Promise.all([
      readFile("home/system/icons/grid.svg", "utf8"),
      readFile("home/system/icons/layers.svg", "utf8"),
    ]);

    expect(grid).toContain("<svg");
    expect(layers).toContain("<svg");
  });

  it("keeps the desktop dock as a glass rail with stable icon controls", async () => {
    const source = await readFile("shell/src/components/Desktop.tsx", "utf8");
    const dockMatch = source.match(/<aside\b[^>]*\bdata-dock\b[\s\S]*?<\/aside>/);
    expect(dockMatch).not.toBeNull();
    const dockSource = dockMatch?.[0] ?? "";

    expect(dockSource).toContain("bg-card/50");
    expect(dockSource).toContain("backdrop-blur-md");
    expect(dockSource).toContain("rounded-2xl");
    expect(dockSource).toContain("<DockIcon");
  });
});
