import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

function readPngDimensions(path: string): { width: number; height: number } {
  const png = readFileSync(path);
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
  };
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("desktop packaging", () => {
  it("uses an electron-builder version that preserves branded DMG backgrounds", () => {
    const packageJson = JSON.parse(
      readFileSync(join(process.cwd(), "desktop/package.json"), "utf8"),
    ) as { devDependencies?: Record<string, string> };
    const version = packageJson.devDependencies?.["electron-builder"];

    expect(version).toMatch(/^~?\d+\.\d+\.\d+$/);
    const [major, minor, patch] = version!.replace(/^~/, "").split(".").map(Number);
    expect(major * 1_000_000 + minor * 1_000 + patch).toBeGreaterThanOrEqual(26_005_000);
  });

  it("registers canonical and legacy macOS URL schemes", () => {
    const raw = readFileSync(join(process.cwd(), "desktop/electron-builder.yml"), "utf8");
    const config = parse(raw) as {
      protocols?: Array<{ schemes?: string[] }>;
    };

    const schemes = config.protocols?.flatMap((protocol) => protocol.schemes ?? []) ?? [];
    expect(schemes).toContain("matrixos");
    expect(schemes).toContain("matrix-os");
  });

  it("uses the canonical Matrix brand assets for a Retina DMG installer", () => {
    const root = process.cwd();
    const raw = readFileSync(join(root, "desktop/electron-builder.yml"), "utf8");
    const config = parse(raw) as {
      dmg?: {
        title?: string;
        background?: string;
        icon?: string;
        iconSize?: number;
        iconTextSize?: number;
        window?: { width?: number; height?: number };
        contents?: Array<{ x?: number; y?: number; type?: string; path?: string }>;
      };
    };

    expect(config.dmg).toEqual({
      title: "Matrix OS",
      background: "build/dmg-background.png",
      icon: "build/icon.icns",
      iconSize: 112,
      iconTextSize: 13,
      window: { width: 720, height: 520 },
      contents: [
        { x: 190, y: 322 },
        { x: 530, y: 322, type: "link", path: "/Applications" },
      ],
    });

    expect(readPngDimensions(join(root, "desktop/build/dmg-background.png"))).toEqual({
      width: 720,
      height: 520,
    });
    expect(readPngDimensions(join(root, "desktop/build/dmg-background@2x.png"))).toEqual({
      width: 1440,
      height: 1040,
    });

    const generator = readFileSync(
      join(root, "scripts/generate-desktop-dmg-background.mjs"),
      "utf8",
    );
    expect(generator).toContain("desktop/src/renderer/src/assets/matrix-logo.svg");
    expect(generator).toContain('from "../packages/brand/src/tokens.ts"');
    expect(generator).toContain("forest: brandPalette.forest");
    expect(generator).toContain("forestDeep: brandPalette.forestDeep");
    expect(generator).toContain("cream: brandPalette.cream");
    expect(generator).toContain("ember: brandPalette.ember");
    expect(generator).toContain("displayFontFamily = desktopFonts.display");
    expect(generator).toContain("uiFontFamily = desktopFonts.sans");
    expect(generator).toContain("@expo-google-fonts/bricolage-grotesque");
    expect(generator).toContain("BricolageGrotesque_700Bold.ttf");
    expect(generator).not.toContain("BricolageGrotesque_400Regular.ttf");
    expect(generator).not.toContain("BricolageGrotesque_600SemiBold.ttf");
    expect(generator).toContain("@expo-google-fonts/geist");
    expect(generator).toContain("Geist_400Regular.ttf");
    expect(generator).toContain("Geist_600SemiBold.ttf");
    expect(generator).toContain("@resvg/resvg-js");
    expect(generator).toContain("existsSync(resvgPackagePath)");
    expect(generator).toContain("fontPaths.every(existsSync)");
    expect(generator).toContain(
      "fontFiles: [displayFontBoldPath, uiFontRegularPath, uiFontSemiBoldPath]",
    );
    expect(generator).toContain("loadSystemFonts: false");
    expect(generator).not.toContain("@font-face");
    expect(generator).not.toContain("Instrument Serif");
    expect(generator).not.toContain("instrument-serif");
    expect(generator.match(/<text class="display text-4xl"/g)).toHaveLength(1);
    expect(generator.match(/<text class="ui text-(?:base|xs)"/g)).toHaveLength(2);
    expect(generator).toContain('"text-4xl": { fontSize: 36, lineHeight: 40 }');
    expect(generator).toContain('"text-base": { fontSize: 16, lineHeight: 24 }');
    expect(generator).toContain('"text-xs": { fontSize: 12, lineHeight: 16 }');

    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.["generate:desktop-dmg-background"]).toBe(
      "node scripts/generate-desktop-dmg-background.mjs",
    );

    const desktopPackageJson = JSON.parse(
      readFileSync(join(root, "desktop/package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(
      desktopPackageJson.devDependencies?.["@expo-google-fonts/bricolage-grotesque"],
    ).toMatch(/^\^0\.4\./);
    expect(desktopPackageJson.devDependencies?.["@expo-google-fonts/geist"]).toMatch(/^\^0\.4\./);
    expect(desktopPackageJson.devDependencies?.["@resvg/resvg-js"]).toBe("^2.6.2");
    expect(desktopPackageJson.dependencies).not.toHaveProperty(
      "@expo-google-fonts/bricolage-grotesque",
    );
    expect(desktopPackageJson.dependencies).not.toHaveProperty("@expo-google-fonts/geist");
    expect(desktopPackageJson.dependencies).not.toHaveProperty("@resvg/resvg-js");
    expect(desktopPackageJson.dependencies?.["@fontsource/instrument-serif"]).toMatch(/^\^5\./);
  });

  it("renders the committed DMG artwork with the packaged brand fonts", () => {
    const root = process.cwd();
    const outputDirectory = mkdtempSync(join(tmpdir(), "matrix-dmg-background-"));

    try {
      execFileSync(process.execPath, [join(root, "scripts/generate-desktop-dmg-background.mjs")], {
        cwd: root,
        env: { ...process.env, MATRIX_DMG_OUTPUT_DIR: outputDirectory },
        stdio: "pipe",
      });

      for (const filename of ["dmg-background.png", "dmg-background@2x.png"]) {
        const committedPath = join(root, "desktop/build", filename);
        const generatedPath = join(outputDirectory, filename);
        expect(readFileSync(generatedPath)).toEqual(readFileSync(committedPath));
      }

      expect(sha256(join(root, "desktop/build/dmg-background.png"))).toBe(
        "b452452bf5a9a2dc23c3bc9de1acd3f6aa880733ae501bdb322665d831f09e93",
      );
      expect(sha256(join(root, "desktop/build/dmg-background@2x.png"))).toBe(
        "676b042d7498fde42cf84266cf056bfd2db05d9fb4c8b62aa11470530edb518e",
      );
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  }, 30_000);

  it("uses the minimal Electron hardened-runtime entitlements for macOS", () => {
    const root = process.cwd();
    const raw = readFileSync(join(root, "desktop/electron-builder.yml"), "utf8");
    const config = parse(raw) as {
      mac?: { entitlements?: string; entitlementsInherit?: string; hardenedRuntime?: boolean };
    };

    expect(config.mac?.hardenedRuntime).toBe(true);
    expect(config.mac?.entitlements).toBe("build/entitlements.mac.plist");
    expect(config.mac?.entitlementsInherit).toBe("build/entitlements.mac.plist");

    const entitlements = readFileSync(join(root, "desktop/build/entitlements.mac.plist"), "utf8");
    const entitlementKeys = Array.from(entitlements.matchAll(/<key>([^<]+)<\/key>/g), (match) => match[1]);

    expect(entitlementKeys).toHaveLength(3);
    expect(entitlementKeys).toEqual(
      expect.arrayContaining([
        "com.apple.security.cs.allow-jit",
        "com.apple.security.cs.allow-unsigned-executable-memory",
        "com.apple.security.cs.disable-library-validation",
      ]),
    );
    expect(entitlementKeys).not.toContain("com.apple.security.app-sandbox");
    expect(entitlementKeys).not.toContain("com.apple.security.network.client");
    expect(entitlementKeys).not.toContain("com.apple.security.files.user-selected.read-write");
  });

  it("does not ship raw TypeScript workspace contracts in the app archive", () => {
    const raw = readFileSync(join(process.cwd(), "desktop/electron-builder.yml"), "utf8");
    const config = parse(raw) as { files?: string[] };
    const packageJson = JSON.parse(
      readFileSync(join(process.cwd(), "desktop/package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(config.files).toContain("!**/node_modules/@matrix-os/contracts/**");
    expect(packageJson.dependencies).not.toHaveProperty("@matrix-os/contracts");
    expect(packageJson.devDependencies?.["@matrix-os/contracts"]).toBe("workspace:*");
  });

  it("gives electron-vite a resolvable Electron dependency in the global virtual store", () => {
    const raw = readFileSync(join(process.cwd(), "package.json"), "utf8");
    const packageJson = JSON.parse(raw) as {
      pnpm?: {
        packageExtensions?: Record<string, { dependencies?: Record<string, string> }>;
      };
    };

    expect(packageJson.pnpm?.packageExtensions?.["electron-vite@*"]?.dependencies?.electron).toBe(
      "^41.0.3",
    );
  });
});
