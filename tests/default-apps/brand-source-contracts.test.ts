import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";

// Keep source contracts together to avoid a worker/module setup per small suite.
describe("design-refresh-layout", () => {
  const stylesheet = (app: string) => readFileSync(new URL(`../../home/apps/${app}/src/design-refresh.css`, import.meta.url), "utf8");

  describe("compact app layout safeguards", () => {
    it("keeps brief opacity feedback while removing movement for reduced motion", () => {
      for (const file of ["app-foundation.css", "theme.css"]) {
        const css = readFileSync(new URL(`../../home/apps/_shared/${file}`, import.meta.url), "utf8");
        const reduced = css.split("@media (prefers-reduced-motion: reduce)")[1];
        expect(reduced).toMatch(/animation:\s*none\s*!important/);
        expect(reduced).toMatch(/transition:\s*opacity\s+120ms\s+ease-out\s*!important/);
        expect(reduced).toMatch(/scroll-behavior:\s*auto\s*!important/);
      }
    });
    it("restores the weather location controls hidden by the older phone stylesheet", () => {
      expect(stylesheet("weather").split("@media (max-width: 760px)")[1]).toMatch(/\.sidebar\s*\{[^}]*display:\s*flex/);
    });
    it("keeps saved weather cities in one horizontal row on phones", () => {
      expect(stylesheet("weather").split("@media (max-width: 760px)")[1]).toMatch(/\.location-list\s*\{[^}]*flex-direction:\s*row/);
    });
    it("keeps the whole notes library scrollable when controls fill a short phone window", () => {
      const phone = stylesheet("notes").split("@media (max-width: 820px)")[1];
      expect(phone).toMatch(/\.sidebar\s*\{[^}]*overflow-y:\s*auto/);
      expect(phone).toMatch(/\.note-list\s*\{[^}]*flex-shrink:\s*0/);
    });
    it("gives the new-note control a theme surface in standalone dark mode", () => {
      expect(stylesheet("notes")).toMatch(/\.icon-button,\s*\.button,\s*\.search-field\s*\{\s*background:\s*var\(--card\)/);
    });
    it("bounds Weather search results inside a panel whose close bar cannot shrink", () => {
      const css = readFileSync(new URL("../../home/apps/weather/src/styles.css", import.meta.url), "utf8");
      expect(css).toMatch(/\.search-panel\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*max-height:\s*72dvh/);
      expect(css).toMatch(/\.search-bar\s*\{[^}]*flex-shrink:\s*0/);
      expect(css).toMatch(/\.search-results\s*\{[^}]*min-height:\s*0;[^}]*flex:\s*0 1 auto;[^}]*overflow-y:\s*auto/);
    });
    it("matches selected Clock repeat days to the accent foreground", () => {
      const css = readFileSync(new URL("../../home/apps/clock/src/styles.css", import.meta.url), "utf8");
      expect(css).toMatch(/\.day--on\s*\{[^}]*background:\s*var\(--app-accent\);[^}]*color:\s*var\(--app-primary-fg\)/);
    });
  });
});

describe("sculpted-icon-identities", () => {
  const games = ['2048', 'backgammon', 'chess', 'minesweeper', 'snake', 'solitaire', 'tetris'];

  describe('bundled game icon identities', () => {
    it.each(games)('%s declares its own semantic artwork', (slug) => {
      const manifest = JSON.parse(readFileSync(resolve('home/apps/games', slug, 'matrix.json'), 'utf8'));
      expect(manifest.icon).toBe(`v3-${slug}`);
      const asset = readFileSync(resolve('home/system/icons', `${manifest.icon}.png`));
      expect(asset.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    });
  });
});

describe("gallery-vector-artwork", () => {
  it.each(['wallet','notebook','book-open','briefcase','dumbbell','utensils'])('keeps the %s fallback as a small standalone vector',name=>{
   for(const dir of ['home/system/icons','home/apps/app-gallery/src/assets/icons']){
    const svg=readFileSync(resolve(dir,`${name}.svg`),'utf8');
    expect(svg).not.toContain('data:image');
    expect(Buffer.byteLength(svg)).toBeLessThan(2048);
    expect(svg).toContain('<svg');
   }
  });

  const appFallbacks = ['hiring', 'deliveries', 'follow-ups', 'projects', 'campaigns', 'support', 'pipeline', 'releases', 'meeting-briefs', 'agenda', 'company-spend', 'cashflow', 'folio', 'subscriptions', 'revenue', 'people', 'analytics', 'reading-library'];

  it.each(['home/system/icons', 'home/apps/app-gallery/src/assets/icons'])('keeps app fallback identities distinct in %s', dir => {
   const glyphs = appFallbacks.map(name => {
    const svg = readFileSync(resolve(dir, `${name}.svg`), 'utf8');
    const glyph = svg.match(/<g\b[^>]*>([\s\S]*?)<\/g>/)?.[1];
    expect(glyph, `${name} must have a semantic vector glyph`).toBeTruthy();
    expect(Buffer.byteLength(svg)).toBeLessThan(2048);
    return glyph;
   });
   expect(new Set(glyphs).size).toBe(appFallbacks.length);
  });

  it.each(appFallbacks)('ships the same %s fallback identity in Gallery and the host', name => {
   expect(readFileSync(resolve('home/apps/app-gallery/src/assets/icons', `${name}.svg`), 'utf8')).toBe(readFileSync(resolve('home/system/icons', `${name}.svg`), 'utf8'));
  });
});

describe("bundled-brand-review-regressions", () => {
  const css = (file: string) => readFileSync(new URL(`../../home/apps/${file}`, import.meta.url), 'utf8');

  const brand = () => css('_shared/matrix-brand.css');

  describe('bundled app review regressions', () => {
    it('keeps calculator results and error feedback on the dark readout', () => {
      expect(brand()).toMatch(/:root\[data-app='calculator'\] \.preview\s*\{[^}]*background:\s*transparent/);
      expect(brand()).toMatch(/:root\[data-app='calculator'\] \.preview--error\s*\{[^}]*color:\s*var\(--matrix-brand-gold\)/);
      expect(brand()).toMatch(/\.tetris-app \.preview/);
      expect(brand()).not.toMatch(/\.control-card, \.preview, \.stat/);
    });
    it('sizes the weather empty state to its remaining stage with a scroll path', () => {
      const styles = css('weather/src/design-refresh.css');
      expect(styles).toMatch(/\.stage\s*\{[^}]*overflow-y:\s*auto/);
      expect(styles).toMatch(/\.empty-state\s*\{[^}]*height:\s*auto[^}]*min-height:\s*100%/);
    });
    it('allows the short task board and columns to scroll down to quick-add', () => {
      const styles = css('task-manager/src/design-refresh.css');
      expect(styles).toMatch(/\.board\s*\{[^}]*overflow-y:\s*auto/);
      const short = styles.split('@media (max-height: 480px)')[1];
      expect(short).toMatch(/\.board-shell\s*\{[^}]*overflow-y:\s*auto/);
      expect(short).toMatch(/\.board\s*\{[^}]*min-height:\s*240px/);
    });
    it('keeps the canonical game shelf appearance in one authoritative stylesheet', () => {
      const local = css('games/src/styles.css');
      expect(local).not.toMatch(/\.game-art\s*\{[^}]*\bbackground\s*:/);
      expect(local).not.toMatch(/\.game-art\s*\{[^}]*\b(?:box-shadow|text-shadow)\s*:/);
      expect(brand()).toContain(':root .game-cover .game-art');
    });
    it('keeps newly added 2048 tile and chess board colors in the shared Matrix palette', () => {
      const added = css('games/2048/src/styles.css').split('/* A compact sculpted game tray;')[1];
      expect(added).not.toMatch(/\.tile-(?:8|16|128|256|512|1024) \.tile-inner/);
      expect(css('games/chess/src/styles.css')).not.toContain('--sq-light: #ece8dd');
      expect(brand()).toContain('--sq-dark: var(--matrix-brand-green)');
    });
  });
});
