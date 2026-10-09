import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

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
