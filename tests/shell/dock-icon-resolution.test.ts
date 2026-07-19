import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("dock icon resolution", () => {
  it("boots Desktop from shell bootstrap while allowing one design-switch app refresh", async () => {
    const source = await readFile("shell/src/components/Desktop.tsx", "utf8");

    expect(source).toContain("/api/shell/bootstrap");
    expect(source).not.toContain("/api/layout`,");
    expect(source.match(/fetch\(`\$\{GATEWAY_URL\}\/api\/apps`,/g)).toHaveLength(1);
    expect(source).toContain(
      "fetch(`${GATEWAY_URL}/api/apps`, { signal: AbortSignal.timeout(10_000) })",
    );
    expect(source).not.toContain("/files/system/modules.json");
  });

  it("uses the shared icon resolver in Desktop instead of a PNG-only local helper", async () => {
    const source = await readFile("shell/src/components/Desktop.tsx", "utf8");

    expect(source).toContain("import { iconUrlForSlug } from \"@/lib/app-launch\"");
    expect(source).not.toContain("function iconUrlForSlug");
    expect(source).not.toContain("/icons/${encodeURIComponent(slug)}.png");
    expect(source).not.toContain("const iconPath = `/icons/${slug}.png`");
    expect(source).toContain("bootstrap.icons?.[slug]?.versionedUrl ?? iconUrlForSlug(slug)");
    expect(source).not.toContain("method: \"HEAD\"");
  });

  it("uses dedicated raster slugs for built-in launcher apps", async () => {
    const [desktopSource, builtInSource] = await Promise.all([
      readFile("shell/src/components/Desktop.tsx", "utf8"),
      readFile("shell/src/lib/builtin-apps.ts", "utf8"),
    ]);

    expect(desktopSource).toContain("addApp(\"Terminal\", \"__terminal__\", \"terminal\", iconForSlug(\"terminal\"))");
    expect(builtInSource).toContain("[\"__workspace__\", \"Workspace\"]");
    expect(desktopSource).toContain("addApp(\"Files\", \"__file-browser__\", \"files\", iconForSlug(\"files\"))");
    expect(desktopSource).toContain("addApp(\"Hermes\", \"__chat__\", \"chat\", iconForSlug(\"chat\"))");
  });

  it("preserves versioned desktop icon URLs when app registration refreshes", async () => {
    const [source, helperSource] = await Promise.all([
      readFile("shell/src/components/Desktop.tsx", "utf8"),
      readFile("shell/src/components/desktop/desktop-app-routing.ts", "utf8"),
    ]);

    expect(helperSource).toContain("function iconAssetPath");
    expect(helperSource).toContain("export function sameIconAsset");
    expect(source).toContain("const nextIconUrl = iconUrl === undefined");
    expect(source).toContain("? existing.iconUrl");
    expect(source).toContain(": sameIconAsset(existing.iconUrl, iconUrl) ? existing.iconUrl : iconUrl");
    expect(source).toContain("{ ...app, name, iconUrl: nextIconUrl }");
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
