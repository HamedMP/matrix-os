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

// Read the emitted inline declaration; jsdom's background shorthand getter can be empty.
function renderedColor(element: Element, property: 'background' | 'color'): string {
  const declaration = element.getAttribute('style')?.split(';').find(value => value.trim().startsWith(`${property}:`));
  expect(declaration, `Missing rendered ${property} declaration`).toBeDefined();
  return cssColor(declaration!.trim().slice(property.length + 1).trim());
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
      const fill = renderedColor(hover!, 'background');
      const ink = renderedColor(hover!, 'color');
      expect(fill).toBe(cssColor(web.colors['primary-hover']));
      expect(ink).toBe(cssColor(web.colors['primary-hover-foreground']));
      expect(fill).toBe(cssColor(electron['--accent-hover']!));
      expect(ink).toBe(cssColor(electron['--text-on-accent-hover']!));
    });
  }
});
