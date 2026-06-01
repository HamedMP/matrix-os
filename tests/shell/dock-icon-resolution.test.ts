import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("dock icon resolution", () => {
  it("uses the shared icon resolver in Desktop instead of a PNG-only local helper", async () => {
    const source = await readFile("shell/src/components/Desktop.tsx", "utf8");

    expect(source).toContain("import { iconUrlForSlug } from \"@/lib/app-launch\"");
    expect(source).not.toContain("function iconUrlForSlug");
    expect(source).not.toContain("/icons/${encodeURIComponent(slug)}.png");
    expect(source).not.toContain("const iconPath = `/icons/${slug}.png`");
    expect(source).toContain("const iconPath = iconUrlForSlug(slug)");
  });

  it("uses dedicated raster slugs for built-in launcher apps", async () => {
    const source = await readFile("shell/src/components/Desktop.tsx", "utf8");

    expect(source).toContain("addApp(\"Terminal\", \"__terminal__\", \"terminal\")");
    expect(source).toContain("addApp(\"Workspace\", \"__workspace__\", \"workspace\")");
    expect(source).toContain("addApp(\"Files\", \"__file-browser__\", \"files\")");
    expect(source).toContain("addApp(\"Hermes\", \"__chat__\", \"chat\")");
  });

  it("uses the shared icon resolver for mobile dock icons", async () => {
    const source = await readFile("shell/src/components/mobile/MobileShell.tsx", "utf8");

    expect(source).toContain("import { iconUrlForSlug } from \"@/lib/app-launch\"");
    expect(source).not.toContain("function iconUrl");
    expect(source).not.toContain("/icons/${slug}.png");
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
    const dockStart = source.indexOf("<aside\n          data-dock");
    const dockEnd = source.indexOf("</aside>", dockStart);
    const dockSource = source.slice(dockStart, dockEnd);

    expect(dockSource).toContain("bg-black/35");
    expect(dockSource).toContain("backdrop-saturate-150");
    expect(source).toContain("function dockButtonClass");
    expect(source).toContain("rounded-[14px]");
  });
});
