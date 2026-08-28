import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const RENDERER_SRC = path.resolve(import.meta.dirname, "../../desktop/src/renderer/src");

function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectSources(full, out);
    else if (/\.(ts|tsx|css)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const VAR_REFERENCE = /var\(\s*(--[A-Za-z0-9_-]+)/g;
const CSS_DECLARATION = /(--[A-Za-z0-9_-]+)\s*:/g;
const CSS_PROPERTY_RULE = /@property\s+(--[A-Za-z0-9_-]+)/g;
const TS_CUSTOM_PROPERTY = /["'](--[A-Za-z0-9_-]+)["']\s*\]?\s*:/g;
const FRAMEWORK_VARS = new Set(["--spacing", "--scroll-fade-reveal"]);

function buildDefinitions(files: string[]): Set<string> {
  const defined = new Set<string>();
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    if (file.endsWith(".css")) {
      for (const match of source.matchAll(CSS_DECLARATION)) defined.add(match[1]!);
      for (const match of source.matchAll(CSS_PROPERTY_RULE)) defined.add(match[1]!);
    } else {
      for (const match of source.matchAll(TS_CUSTOM_PROPERTY)) defined.add(match[1]!);
    }
  }
  return defined;
}

function readRendererFile(...segments: string[]): string {
  return readFileSync(path.join(RENDERER_SRC, ...segments), "utf8");
}

function themeBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`theme block not found: ${selector}`);
  return match[1]!;
}

function tokenValue(block: string, name: string): string {
  const match = block.match(new RegExp(`${name.replace(/-/g, "\\-")}:\\s*([^;]+);`));
  if (!match) throw new Error(`token not defined: ${name}`);
  return match[1]!.trim();
}

function luminance(hex: string): number {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`not a 6-digit hex color: ${hex}`);
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrastRatio(a: string, b: string): number {
  const [bright, dim] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (bright! + 0.05) / (dim! + 0.05);
}

describe("design token references", () => {
  it("resolves every var(--name) reference to a definition", () => {
    const files = collectSources(RENDERER_SRC);
    const defined = buildDefinitions(files);

    const missing = new Map<string, Set<string>>();
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(VAR_REFERENCE)) {
        const name = match[1]!;
        if (defined.has(name) || FRAMEWORK_VARS.has(name)) continue;
        const short = path.relative(RENDERER_SRC, file);
        if (!missing.has(name)) missing.set(name, new Set());
        missing.get(name)!.add(short);
      }
    }

    const report = [...missing.entries()]
      .map(([name, locations]) => `${name} referenced in: ${[...locations].join(", ")}`)
      .sort();
    expect(report).toEqual([]);
  });
});

describe("tailwind text scale bridge", () => {
  const SCALE: Array<[string, string]> = [
    ["xs", "11px"], ["sm", "12px"], ["base", "13px"], ["md", "14px"],
    ["lg", "16px"], ["xl", "20px"], ["2xl", "28px"],
  ];

  it("maps the full token text scale into the @theme block", () => {
    const indexCss = readRendererFile("design", "index.css");
    const themeMatch = indexCss.match(/@theme\s+inline\s*\{([\s\S]*?)\n\}/);
    expect(themeMatch, "index.css @theme inline block").not.toBeNull();
    const themeBlockSource = themeMatch![1]!;
    for (const [name] of SCALE) {
      expect(themeBlockSource.includes(`--text-${name}: var(--text-${name});`)).toBe(true);
    }
  });

  it("defines the scale as px tokens in tokens.css", () => {
    const root = themeBlock(readRendererFile("design", "tokens.css"), ":root");
    for (const [name, px] of SCALE) expect(tokenValue(root, `--text-${name}`)).toBe(px);
  });
});

describe("Desktop sidebar geometry tokens", () => {
  const root = themeBlock(readRendererFile("design", "tokens.css"), ":root");
  it("defines the Figma sidebar and shell geometry", () => {
    expect(tokenValue(root, "--titlebar-height")).toBe("38px");
    expect(tokenValue(root, "--sidebar-expanded-width")).toBe("240px");
    expect(tokenValue(root, "--sidebar-collapsed-width")).toBe("0px");
    expect(tokenValue(root, "--sidebar-row-height")).toBe("28px");
    expect(tokenValue(root, "--sidebar-menu-width")).toBe("248px");
  });
});

describe("Figma semantic surface tokens", () => {
  const tokensCss = readRendererFile("design", "tokens.css");
  it("defines the OS window surfaces and success badge tokens in both modes", () => {
    for (const selector of [":root", '[data-theme="dark"]']) {
      const block = themeBlock(tokensCss, selector);
      for (const name of ["--surface-base-background", "--surface-primary", "--surface-overlay", "--surface-tertiary", "--surface-success", "--border-success", "--text-inverse"]) {
        expect(tokenValue(block, name)).toMatch(/^#/);
      }
    }
  });

  it("defines the integration icon surface and danger text tokens in both modes", () => {
    expect(tokenValue(themeBlock(tokensCss, ":root"), "--surface-card-foreground-subtle")).toBe(
      "#fafaf6",
    );
    expect(tokenValue(themeBlock(tokensCss, ":root"), "--text-danger")).toBe("#b42318");
    expect(tokenValue(themeBlock(tokensCss, '[data-theme="dark"]'), "--surface-card-foreground-subtle")).toBe(
      "#242923",
    );
    expect(tokenValue(themeBlock(tokensCss, '[data-theme="dark"]'), "--text-danger")).toBe("#f28b82");
  });
});

describe("composer focus presentation", () => {
  it("suppresses the global focus ring inside the rich prompt editor", () => {
    expect(readRendererFile("design", "index.css")).toMatch(
      /\.prompt-card \[data-slot="prompt-input-content"\]:focus-visible\s*\{[^}]*box-shadow:\s*none;/,
    );
  });
});

describe("tertiary text contrast (WCAG AA)", () => {
  const tokensCss = readRendererFile("design", "tokens.css");
  for (const [label, selector] of [["light", ":root"], ["dark", '[data-theme="dark"]']] as const) {
    it(`${label} theme --text-tertiary reaches 4.5:1 on app surfaces`, () => {
      const block = themeBlock(tokensCss, selector);
      const tertiary = tokenValue(block, "--text-tertiary");
      for (const surfaceToken of ["--bg-surface", "--bg-app"]) {
        expect(contrastRatio(tertiary, tokenValue(block, surfaceToken))).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});
