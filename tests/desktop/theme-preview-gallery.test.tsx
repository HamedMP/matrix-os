// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getThemeVariant, unifiedThemes } from '../../packages/brand/src/themes';
import { DEFAULT_APPEARANCE } from '../../packages/brand/src/themes/preferences';
import { buildWebTheme } from '../../packages/brand/src/themes/web-theme';
import { chromeToSemanticVars } from '../../packages/brand/src/themes/desktop-theme';

const gallery = vi.hoisted(() => ({ markup: '' }));
vi.mock('react-dom/client', () => ({
  createRoot: () => ({ render: (node: ReactNode) => { gallery.markup = renderToStaticMarkup(node); } }),
}));
vi.mock('../../desktop/src/renderer/src/features/settings/sections/AppearanceSection', () => ({ default: () => null }));
vi.mock('../../desktop/src/renderer/src/stores/appearance', () => ({
  useAppearance: { getState: () => { throw new Error('Gallery must not load owner appearance state'); } },
}));

afterEach(() => {
  document.body.replaceChildren();
  window.history.replaceState(null, '', '/');
  vi.resetModules();
});

function cssColor(value: string): string {
  const sample = document.createElement('span');
  sample.style.color = value;
  expect(sample.style.color).not.toBe('');
  return sample.style.color;
}

describe('theme review gallery matches app hover colors', () => {
  for (const theme of unifiedThemes) for (const mode of ['light', 'dark'] as const) {
    it(`${theme.id} ${mode}: Action hover matches Web and Electron`, async () => {
      document.body.innerHTML = '<div id="root"></div>';
      window.history.replaceState(null, '', `/?view=gallery&stage=after&theme=${theme.id}&mode=${mode}`);
      gallery.markup = '';
      await import('../../scripts/dev/theme-preview/main');
      const output = document.createElement('div');
      output.innerHTML = gallery.markup;
      const specimens = output.querySelectorAll('[data-theme-specimen]');
      expect(specimens).toHaveLength(1);
      expect(specimens[0]!.getAttribute('data-theme-specimen')).toBe(theme.id);
      const hover = [...specimens[0]!.querySelectorAll('span')].find(node => node.textContent === 'Action hover');
      expect(hover).toBeDefined();
      const web = buildWebTheme({ ...DEFAULT_APPEARANCE, themeId: theme.id, mode });
      const electron = chromeToSemanticVars(getThemeVariant(theme.id, mode).chrome, theme.id);
      expect(hover!.style.background).toBe(cssColor(web.colors['primary-hover']));
      expect(hover!.style.color).toBe(cssColor(web.colors['primary-hover-foreground']));
      expect(hover!.style.background).toBe(cssColor(electron['--accent-hover']!));
      expect(hover!.style.color).toBe(cssColor(electron['--text-on-accent-hover']!));
    });
  }
});
