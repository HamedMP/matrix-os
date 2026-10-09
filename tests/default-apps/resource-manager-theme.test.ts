import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";

const repoRoot = process.cwd();
const resourceManagerCss = join(repoRoot, "home/apps/resource-manager/src/styles.css");

describe("Resource Manager theme tokens", () => {
  it("uses Matrix shell tokens instead of app-local blue accents", async () => {
    const css = await readFile(resourceManagerCss, "utf8");

    expect(css).toContain("var(--matrix-primary");
    expect(css).toContain("var(--matrix-accent");
    expect(css).toContain("var(--matrix-success");
    expect(css).not.toContain("#356f8c");
    expect(css).not.toContain("#19495f");
    expect(css).not.toContain("#edf6fa");
    expect(css).not.toContain("#9db1bc");
  });
});

/** Resolve the shipped cascade at an embedded app viewport; jsdom has no layout engine. */
async function appStyles(app: string, width: number, height: number, markup: string) {
  const dom = new JSDOM(`<div id="root">${markup}</div>`);
  const source = dom.window.document.createElement("style");
  const files = [join(repoRoot, `home/apps/${app}/src/styles.css`)];
  if (app.startsWith("games/")) files.push(join(repoRoot, "home/apps/_shared/game-refresh.css"));
  source.textContent = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n").replace(/@import[^;]+;/g, "");
  dom.window.document.head.append(source);
  function activeMedia(condition: string) {
    if (/prefers-/.test(condition)) return false;
    return Array.from(condition.matchAll(/\((min|max)-(width|height):\s*(\d+)px\)/g)).every(([, bound, axis, value]) =>
      bound === "max" ? (axis === "width" ? width : height) <= Number(value) : (axis === "width" ? width : height) >= Number(value));
  }
  function flatten(rules: CSSRuleList): string {
    return Array.from(rules).map((rule) => {
      if (rule.type === 4) {
        const media = rule as CSSMediaRule;
        return activeMedia(media.media.mediaText) ? flatten(media.cssRules) : "";
      }
      return rule.type === 1 ? rule.cssText : "";
    }).join("\n");
  }
  const resolved = dom.window.document.createElement("style");
  resolved.textContent = flatten(source.sheet!.cssRules);
  source.remove();
  dom.window.document.head.append(resolved);
  const style = (selector: string) => dom.window.getComputedStyle(dom.window.document.querySelector(selector)!);
  return { dom, style };
}

describe("Sculpted app short-window reachability", () => {
  it("keeps the stacked Chess board row intrinsic at 640x480", async () => {
    const { dom, style } = await appStyles("games/chess", 640, 480,
      '<main class="chess-app"><section class="board-stage"><div class="board-frame"></div><div class="board-actions"></div></section><aside class="side-panel"></aside></main>');
    try {
      expect(style(".board-stage").minHeight).toBe("auto");
      expect(style(".board-stage").overflow).toBe("visible");
      expect(style(".chess-app").overflowY).toBe("auto");
    } finally { dom.window.close(); }
  });

  it.each([[960, 500], [800, 400]])("keeps Chess actions reachable below its unshrunk board at %sx%s", async (width, height) => {
    const { dom, style } = await appStyles("games/chess", width, height,
      '<main class="chess-app"><section class="board-stage"><div class="board-frame"></div><div class="board-actions"></div></section></main>');
    try {
      expect(style(".board-frame").flexShrink).toBe("0");
      // The board plus setup/status/actions exceeds these short viewports.
      // At least one containing surface must permit vertical scrolling.
      expect([".board-stage", ".chess-app", "body"].some((selector) =>
        /^(auto|scroll)$/.test(style(selector).overflowY || style(selector).overflow))).toBe(true);
    } finally { dom.window.close(); }
  });

  it("reserves visible Services and Processes content in Resource Manager at 960x600", async () => {
    const { dom, style } = await appStyles("resource-manager", 960, 600,
      '<main class="resource-app"><section class="content-grid"><section class="panel"><div class="panel-heading"><h2>Services</h2></div><div class="service-list"><div class="service-row">Gateway</div></div></section></section></main>');
    try {
      const panel = style(".panel");
      const heading = style("h2");
      const required = parseFloat(panel.paddingTop) + parseFloat(panel.paddingBottom)
        + parseFloat(heading.fontSize) * parseFloat(heading.lineHeight)
        + parseFloat(panel.rowGap || panel.gap) + parseFloat(style(".service-row").minHeight);
      const rowMinimum = parseFloat(style(".content-grid").minHeight);
      expect(rowMinimum).toBeGreaterThanOrEqual(required);
      expect(style(".resource-app").overflow).toBe("auto");
    } finally { dom.window.close(); }
  });

  it("keeps every Intermediate Minesweeper row reachable at 640x480 when cells hit their 12px minimum", async () => {
    const { dom, style } = await appStyles("games/minesweeper", 640, 480,
      '<div class="ms-root"><div class="ms-frame"><header class="ms-header"></header><div class="ms-board-area"><div class="ms-grid"></div></div><footer class="ms-footer"></footer></div></div>');
    try {
      const area = style(".ms-board-area");
      expect(area.overflowY || area.overflow).toMatch(/^(auto|scroll)$/);
      // Centering an oversized board hides its leading rows beyond scrollTop=0.
      expect(area.alignItems).toMatch(/^(flex-start|start|safe center)$/);
      expect(area.justifyContent).toMatch(/^(flex-start|start|safe center)$/);
    } finally { dom.window.close(); }
  });
});
