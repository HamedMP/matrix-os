// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME_ID, getThemeVariant, unifiedThemes } from '../../desktop/src/renderer/src/design/themes';
import { normalizeCustomTheme, customizeVariant, contrastRatio, FONT_OPTIONS } from '../../packages/brand/src/themes/customization';

describe('theme customization', () => {
  it('defaults to Matrix and gives every preset real light and dark variants', () => {
    expect(DEFAULT_THEME_ID).toBe('matrix');
    for (const theme of unifiedThemes) {
      expect(theme.light, theme.id).toBeDefined();
      expect(theme.dark, theme.id).toBeDefined();
      expect(theme.light?.chrome.background).not.toBe(theme.dark?.chrome.background);
    }
  });
  it('gives Matrix distinct navigation surfaces in both modes and projects them to the web', () => {
    expect(unifiedThemes[0]?.id).toBe('matrix');
    expect(DEFAULT_APPEARANCE.themeId).toBe('matrix');
    expect(DEFAULT_APPEARANCE.mode).toBe('light');
    const light = getThemeVariant('matrix', 'light').chrome;
    expect(light.sidebar).toBe('#ffffff');
    for (const mode of ['light', 'dark'] as const) {
      const c = getThemeVariant('matrix', mode).chrome;
      expect(c.sidebar).not.toBe(c.card);
      expect(contrastRatio(c.sidebarForeground, c.sidebar)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(c.sidebarAccentForeground, c.sidebarAccent)).toBeGreaterThanOrEqual(4.5);
      const green = parseInt(c.sidebarAccent.slice(3, 5), 16);
      expect(green).toBeGreaterThan(parseInt(c.sidebarAccent.slice(1, 3), 16));
      const web = buildWebTheme({ ...DEFAULT_APPEARANCE, mode });
      expect(web.colors.sidebar).toBe(c.sidebar);
      expect(web.colors['sidebar-accent']).toBe(c.sidebarAccent);
    }
    const dark = getThemeVariant('matrix', 'dark').chrome;
    expect(parseInt(dark.sidebar.slice(3, 5), 16)).toBeGreaterThan(parseInt(dark.sidebar.slice(1, 3), 16));
  });
  it('keeps small text readable on every chrome surface and editor', () => {
    for (const theme of unifiedThemes) for (const mode of ['light', 'dark'] as const) {
      const { chrome: c, editor: e } = getThemeVariant(theme.id, mode);
      for (const bg of [c.background, c.card, c.accent]) {
        expect(contrastRatio(c.mutedForeground, bg), `${theme.id} ${mode} muted on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrastRatio(c.primaryForeground, c.primary), `${theme.id} ${mode} button`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(e.comment, e.background), `${theme.id} ${mode} comment`).toBeGreaterThanOrEqual(4.5);
    }
  });
  it('normalizes bounded custom colors and rejects CSS injection', () => {
    const value = normalizeCustomTheme({ baseThemeId: 'matrix', light: { background: '#fffFFF', accent: 'url(https://bad)', unknown: '#112233' }, dark: null });
    expect(value).toEqual({ baseThemeId: 'matrix', light: { background: '#ffffff' }, dark: {} });
    expect(normalizeCustomTheme(null)).toBeNull();
  });
  it('derives readable foregrounds and restyles all three layers without mutating presets', () => {
    const base = getThemeVariant('matrix', 'dark');
    const before = JSON.stringify(base);
    const next = customizeVariant(base, { background: '#fefefe', surface: '#ffffff', text: '#ffffff', accent: '#ffff00' });
    expect(contrastRatio(next.chrome.foreground, next.chrome.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(next.chrome.primaryForeground, next.chrome.primary)).toBeGreaterThanOrEqual(4.5);
    expect(next.terminal.background).toBe('#fefefe');
    expect(next.editor.background).toBe('#fefefe');
    expect(contrastRatio(next.editor.foreground, next.editor.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(next.editor.cursor, next.editor.background)).toBeGreaterThanOrEqual(4.5);
    expect(JSON.stringify(base)).toBe(before);
    expect(FONT_OPTIONS.some(font => font.id === 'geist')).toBe(true);
  });
});

import { normalizeAppearance, DEFAULT_APPEARANCE } from '../../packages/brand/src/themes/preferences';
import { buildWebTheme } from '../../packages/brand/src/themes/web-theme';

describe('shared appearance preferences', () => {
  it('starts in light mode even on a dark device, and follows the device only on request', () => {
    expect(buildWebTheme(DEFAULT_APPEARANCE, true).mode).toBe('light');
    expect(buildWebTheme({ ...DEFAULT_APPEARANCE, mode: 'system' }, true).mode).toBe('dark');
  });
  it('rejects untrusted font names, unknown bases and custom without a saved theme', () => {
    expect(normalizeAppearance({ fontId: 'url(https://bad)', themeId: 'custom' })).toEqual(DEFAULT_APPEARANCE);
    expect(normalizeAppearance({ customTheme: { baseThemeId: 'missing', light: {}, dark: {} } }).customTheme?.baseThemeId).toBe('matrix');
  });
  it('retains both custom variants and projects identical colors into Web Desktop and Web Canvas', () => {
    const preferences = normalizeAppearance({ themeId: 'custom', customTheme: { baseThemeId: 'nord', light: { accent: '#224466' }, dark: { accent: '#88bbdd' } }, fontId: 'inter', monoFontId: 'system' });
    const light = buildWebTheme(preferences);
    const dark = buildWebTheme({ ...preferences, mode: 'dark' });
    expect(light.colors.primary).toBe('#224466');
    expect(dark.colors.primary).toBe('#88bbdd');
    expect(light.fonts.sans).toContain('Inter');
    expect(dark.fonts.mono).toContain('ui-monospace');
  });
});

import { updateWebTheme, appearanceFromWebTheme } from '../../packages/brand/src/themes/web-theme';
import { codeMirrorThemeStyles } from '../../packages/brand/src/themes/editor';
describe('appearance review regressions', () => {
  it('preserves every legacy color, radius, style and unrelated font when changing typography', () => {
    const legacy = { name: 'retro', mode: 'light' as const, style: 'neumorphic', colors: { background: '#eeeeee', primary: '#442255', shadow: '#112233' }, fonts: { sans: 'Inter, sans-serif', mono: 'ui-monospace, monospace' }, radius: '0.5rem' };
    const next = updateWebTheme(legacy, { fontId: 'serif' });
    expect(next.colors).toEqual(legacy.colors);
    expect(next.radius).toBe('0.5rem');
    expect(next.style).toBe('neumorphic');
    expect(next.name).toBe('retro');
    expect(next.fonts.mono).toBe(legacy.fonts.mono);
    expect(next.fonts.sans).toContain('Georgia');
    expect(appearanceFromWebTheme(legacy).monoFontId).toBe('system');
  });
  it('keeps shared Electron text visible on opposing custom panel and app colors', () => {
    const c = customizeVariant(getThemeVariant('matrix', 'dark'), { surface: '#ffffff' }).chrome;
    expect(contrastRatio(c.foreground, c.card)).toBeGreaterThan(4);
    expect(contrastRatio(c.foreground, c.background)).toBeGreaterThan(4);
    expect(contrastRatio(c.cardForeground, c.card)).toBeGreaterThanOrEqual(4.5);
  });
  it('projects cursor and selected text from the shared editor palette', () => {
    const e = getThemeVariant('matrix', 'dark').editor;
    const styles = codeMirrorThemeStyles(e);
    expect(styles['.cm-cursor, .cm-dropCursor'].borderLeftColor).toBe(e.cursor);
    expect(styles['&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection'].backgroundColor).toBe(e.selection);
  });
});
