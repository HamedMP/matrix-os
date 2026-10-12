import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { desktopPalette } from "../../packages/brand/src/tokens";

const root = join(import.meta.dirname, "../../home/apps");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const apps = ["calculator", "clock", "todo", "task-manager", "expense-tracker", "weather", "stickies", "whiteboard", "pomodoro", "games", "profile", "social", "widgets", ...["2048", "chess", "tetris", "snake", "solitaire", "minesweeper", "backgammon"].map(game => `games/${game}`)];

describe("Matrix bundled app brand", () => {
  it.each(apps)("%s loads the brand after local styling and identifies its own accent", (app) => {
    const main = read(`${app}/src/main.tsx`);
    expect(main).toContain('matrix-brand.css');
    expect(main).toContain(`dataset.app = "${app.split('/').at(-1)}"`);
    expect(main.lastIndexOf('matrix-brand.css')).toBeGreaterThan(main.lastIndexOf('styles.css'));
  });
  it.each(apps)("%s invalidates its build when bundled canonical icons change", (app) => {
    const manifest = JSON.parse(read(`${app}/matrix.json`));
    const pattern = `${app.includes('/') ? '../../../' : '../../'}system/icons/v3-*.png`;
    expect(manifest.build.sourceGlobs).toContain(pattern);
  });
  it("uses the actual Matrix palette and bundled display/UI fonts", () => {
    const css = read("_shared/matrix-brand.css");
    for (const [name, value] of Object.entries(desktopPalette)) {
      expect(css).toContain(`--matrix-brand-${name}: ${value}`);
    }
    expect(css).toContain('Matrix App Geist');
    expect(css).toContain('Matrix App Bricolage');
    expect(css).not.toContain('prefers-color-scheme');
    expect(css).toContain('--app-bg: var(--matrix-bg, var(--matrix-brand-paper))');
    expect(css).toContain('--app-card: var(--matrix-card, var(--matrix-brand-paper))');
    expect(css).toContain('color-scheme: var(--matrix-color-scheme, light)');
  });
  it("uses canonical icons in the game shelf and internal game headings", () => {
    const source = read('_shared/default-apps.tsx');
    expect(source).toContain('src={game.icon}');
    const css = read('_shared/matrix-brand.css');
    for (const game of ['chess', 'tetris', 'snake', 'solitaire']) expect(css).toContain(`v3-${game}.png`);
  });
});
