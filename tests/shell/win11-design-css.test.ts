import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WIN11_THEME } from "../../shell/src/lib/theme-presets.js";
import { THEME_VAR_MAP } from "../../shell/src/lib/os-bridge.js";

const globalsCssPath = fileURLToPath(new URL("../../shell/src/app/globals.css", import.meta.url));
const sharedThemeCssPath = fileURLToPath(new URL("../../home/apps/_shared/theme.css", import.meta.url));
const fileBrowserPath = fileURLToPath(
  new URL("../../shell/src/components/file-browser/FileBrowser.tsx", import.meta.url),
);

const globalsCss = readFileSync(globalsCssPath, "utf8");
const sharedThemeCss = readFileSync(sharedThemeCssPath, "utf8");
const fileBrowserSrc = readFileSync(fileBrowserPath, "utf8");

/** Extract the declaration body of a `[data-theme-style="<style>"] <selector> { ... }` rule. */
function designRule(css: string, style: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Tolerate `}` inside values (e.g. url()/comments): the rule body ends at a
  // closing brace on its own line, which is the file's formatting convention.
  const match = css.match(
    new RegExp(`\\[data-theme-style="${style}"\\] ${escaped} \\{([\\s\\S]*?)\\n\\}`),
  );
  if (!match) throw new Error(`missing ${style} rule for ${selector}`);
  return match[1];
}

const win11Rule = (selector: string) => designRule(globalsCss, "win11", selector);

describe("win11 design: opaque Mica content surfaces", () => {
  it("renders window cards as an opaque Mica surface — no acrylic, no backdrop blur", () => {
    const body = win11Rule('[data-slot="card"]');
    expect(body).toContain("background: var(--win11-mica)");
    expect(body).toContain("backdrop-filter: none");
    expect(body).not.toContain("--win11-acrylic");
    expect(body).not.toContain("blur(");
    expect(body).toContain("border: 1px solid var(--win11-stroke)");
  });

  it("defines --win11-mica as an opaque hex color", () => {
    const tokens = globalsCss.match(/\[data-theme-style="win11"\] \{([^}]*)\}/);
    expect(tokens).not.toBeNull();
    expect(tokens![1]).toMatch(/--win11-mica:\s*#[0-9a-fA-F]{6}\b/);
  });

  it("pins an opaque content background on canvas window containers", () => {
    const body = win11Rule(".rounded-lg.bg-card");
    expect(body).toContain("background: var(--win11-mica) !important");
    expect(body).toContain("backdrop-filter: none !important");
  });

  it("keeps translucent acrylic only on chrome/flyouts, not content", () => {
    // Flyouts keep acrylic (correct Win11 behavior for menus/popovers).
    expect(globalsCss).toContain('[data-theme-style="win11"] [data-slot="popover-content"]');
    expect(globalsCss).toContain("background: var(--win11-acrylic-strong) !important");
    // The dock keeps acrylic chrome.
    expect(win11Rule("[data-dock]")).toContain("background: var(--win11-acrylic) !important");
  });

  it("styles file-browser rows with the #0067C0 accent tint and 4px pills", () => {
    const selected = win11Rule("[data-file-browser] .bg-accent");
    expect(selected).toContain("color-mix(in srgb, var(--primary) 12%, transparent)");
    expect(selected).toContain("color: var(--foreground)");
    expect(selected).toContain("border-radius: 4px");
    expect(globalsCss).toContain(
      '[data-theme-style="win11"] [data-file-browser] .hover\\:bg-accent\\/50:hover',
    );
    expect(WIN11_THEME.colors.primary).toBe("#0067C0");
  });

  it("marks the FileBrowser root with the data-file-browser styling hook", () => {
    expect(fileBrowserSrc).toContain("data-file-browser");
    expect(fileBrowserSrc.match(/data-file-browser/g)).toHaveLength(1);
  });
});

describe("other designs: no opaque-content regressions", () => {
  it("winxp cards stay fully opaque white", () => {
    const body = designRule(globalsCss, "winxp", '[data-slot="card"]');
    expect(body).toContain("background: #ffffff");
    expect(body).not.toContain("backdrop-filter");
  });

  it("macos-glass cards keep their intentional frosted glass", () => {
    const body = designRule(globalsCss, "macos-glass", '[data-slot="card"]');
    expect(body).toContain("background: var(--glass-surface)");
    expect(body).toContain("backdrop-filter: var(--glass-blur)");
  });
});

describe("shared app theme (iframe apps): win11 opaque surfaces", () => {
  it("inherits the opaque win11 card through the host bridge in light and dark modes", () => {
    expect(WIN11_THEME.colors.card).toBe("#FAFAFA");
    expect(THEME_VAR_MAP["--card"]).toBe("--matrix-card");
    const surfaces = [...sharedThemeCss.matchAll(/--app-card:\s*([^;]+);/g)];
    expect(surfaces).toHaveLength(2);
    for (const [, surface] of surfaces)
      expect(surface).toMatch(/^var\(--matrix-card,\s*#[0-9a-f]{3,6}\)$/i);
  });

  it("keeps the shared timer and launcher surfaces opaque without backdrop blur", () => {
    // The current shared apps use these surfaces; the old card/metric/toolbar
    // classes and independent app-glass tokens were retired by the refresh.
    for (const selector of [
      ".focus-clock",
      ".play-button",
      '.focus-presets button[aria-pressed="true"]',
    ]) {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const rule = sharedThemeCss.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
      expect(rule, `${selector} must retain its content surface`).not.toBeNull();
      expect(rule![1]).toContain("background: var(--app-card)");
    }
    expect(sharedThemeCss).not.toMatch(/(?:-webkit-)?backdrop-filter\s*:/);
    expect(sharedThemeCss).not.toContain("--app-glass");
  });
});
