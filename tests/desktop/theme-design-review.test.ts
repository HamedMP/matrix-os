// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { getThemeVariant, unifiedThemes, contrastRatio } from '../../packages/brand/src/themes';
import { DEFAULT_APPEARANCE, normalizeAppearance } from '../../packages/brand/src/themes/preferences';
import { buildWebTheme } from '../../packages/brand/src/themes/web-theme';
import { chromeToSemanticVars } from '../../desktop/src/renderer/src/design/themes/apply';

describe('designer review regressions', () => {
  it('keeps eleven distinct presets and migrates removed choices without changing mode', () => {
    expect(unifiedThemes).toHaveLength(11);
    for (const themeId of ['tokyo-night', 'solarized', 'catppuccin']) for (const mode of ['light', 'dark', 'system'] as const) {
      expect(normalizeAppearance({ themeId, mode })).toMatchObject({ themeId: 'matrix', mode });
      expect(buildWebTheme({ ...DEFAULT_APPEARANCE, themeId, mode }).appearance.themeId).toBe('matrix');
    }
  });
  it('maps hover, fills and text separately using brand status scales', () => {
    const c = getThemeVariant('matrix', 'light').chrome;
    const v = chromeToSemanticVars(c);
    expect(c.popover).toBe('#fafafa');
    expect(v['--accent-hover']).toBe('#475926');
    expect(v['--border-subtle']).toBe(c.border);
    expect(v['--success']).toBe('#288a5b');
    expect(v['--warning']).toBe('#d2932d');
    expect(v['--danger']).toBe('#ba5236');
    expect(v['--success-muted']).toBe('#eef7f2');
    expect(v['--warning-muted']).toBe('#fcf5e8');
    expect(v['--danger-muted']).toBe('#faeeeb');
    expect(v['--info-muted']).toBe('#edf3f7');
    expect(buildWebTheme().radius).toBe('0.5rem');
  });
  it('gives Neon a neutral action and meaningful ANSI colors in both modes', () => {
    for (const mode of ['light', 'dark'] as const) {
      const { chrome: c, terminal: t } = getThemeVariant('matrix-neon', mode);
      expect(c.primary).toBe(mode === 'light' ? '#242323' : '#fafafa');
      expect(c.primary).not.toBe(c.chart2);
      expect(new Set([t.red, t.green, t.yellow, t.blue]).size).toBe(4);
      expect(c.ring).toBe('#e0aa52');
      expect(c.background).toBe(mode === 'light' ? '#f9fbf5' : '#0d0c0c');
    }
  });
  for (const theme of unifiedThemes) for (const mode of ['light', 'dark'] as const) {
    it(`${theme.id} ${mode}: text on every raised, selected and status surface passes AA`, () => {
      const { chrome: c, editor: e, terminal } = getThemeVariant(theme.id, mode);
      const vars = chromeToSemanticVars(c);
      for (const bg of [c.background, c.card, c.popover, c.surface3, c.muted, c.accent, c.secondary, c.sidebar]) {
        expect(contrastRatio(c.mutedForeground, bg), `secondary on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
      for (const tone of ['success', 'warning', 'danger', 'info']) {
        const text = vars[`--${tone}-text`];
        const fillText = vars[`--text-on-${tone}`];
        expect(text).toBeDefined(); expect(fillText).toBeDefined();
        expect(contrastRatio(text!, vars[`--${tone}-muted`]!)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(fillText!, vars[`--${tone}`]!)).toBeGreaterThanOrEqual(4.5);
      }
      for (const key of ['keyword', 'string', 'comment', 'number', 'function', 'type', 'variable', 'property'] as const) for (const bg of [e.background, e.lineHighlight, e.selection]) expect(contrastRatio(e[key], bg), `${key} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      for (const key of ['red', 'green', 'yellow', 'blue'] as const) expect(contrastRatio(terminal[key], terminal.background), `ANSI ${key}`).toBeGreaterThanOrEqual(4.5);
      expect(c.popover).not.toBe(c.accent);
      expect(vars['--accent-hover']).not.toBe(vars['--accent']);
      expect(contrastRatio(vars['--text-on-accent-hover']!, vars['--accent-hover']!)).toBeGreaterThanOrEqual(4.5);
    });
  }
});
