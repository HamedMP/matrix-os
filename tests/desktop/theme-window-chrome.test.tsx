// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OSWindow, TopBar } from '../../desktop/src/renderer/src/features/desktop-shell/OSWindow';
import { applyUnifiedTheme } from '../../desktop/src/renderer/src/design/themes/apply';
import { contrastRatio, getThemeVariant, unifiedThemes } from '../../packages/brand/src/themes';
import { DEFAULT_APPEARANCE } from '../../packages/brand/src/themes/preferences';
import { buildWebTheme } from '../../packages/brand/src/themes/web-theme';

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('style');
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-theme-id');
});

// Resolve inherited theme variables without relying on jsdom's unsupported
// computed CSS-variable colours. Missing declarations fail rather than pass AA.
function color(element: HTMLElement, property: 'background' | 'color'): string {
  let value = element.style[property];
  for (let depth = 0; depth < 8 && value.startsWith('var('); depth++) {
    const name = value.match(/^var\((--[\w-]+)(?:,[^)]+)?\)$/)?.[1];
    expect(name, value).toBeTruthy();
    let owner: HTMLElement | null = element;
    while (owner && !owner.style.getPropertyValue(name!)) owner = owner.parentElement;
    value = owner?.style.getPropertyValue(name!) ?? '';
  }
  expect(value, `Unresolved ${property}`).toMatch(/^#[\da-f]{6}$/i);
  return value;
}

describe('theme-owned OS window chrome', () => {
  for (const surfaceId of ['chat', 'settings']) for (const mode of ['light', 'dark'] as const) {
    it(`${surfaceId} ${mode}: paints the sidebar's traffic-light safe area with the navigation surface`, () => {
      applyUnifiedTheme('matrix', mode);
      const c = getThemeVariant('matrix', mode).chrome;
      const { container } = render(<OSWindow surfaceId={surfaceId} sidebarWidth={248} safeAreaLayout="sidebar"
        sidebar={<nav style={{ background: 'var(--sidebar)', color: 'var(--sidebar-foreground)' }}>Navigation</nav>}
        topBar={<TopBar chromePlacement="sidebar" onClose={vi.fn()} onMinimize={vi.fn()} onMaximize={vi.fn()} onDragStart={vi.fn()} />} />);
      const sidebar = container.querySelector<HTMLElement>('[data-os-window-sidebar]')!;
      expect(color(sidebar, 'background')).toBe(c.sidebar);
      expect(color(sidebar, 'color')).toBe(c.sidebarForeground);
      expect(contrastRatio(color(sidebar, 'color'), color(sidebar, 'background'))).toBeGreaterThanOrEqual(4.5);
      expect(sidebar.querySelector<HTMLElement>('[data-os-window-safe-view]')!.style.paddingTop).toBe('48px');
      expect(container.querySelector<HTMLElement>('[data-os-window-top-bar-overlay]')!.style.pointerEvents).toBe('none');
      expect(container.querySelector<HTMLElement>('[data-os-window-gesture-layer]')!.style.background).toBe('');
    });
  }

  it('keeps a custom sidebar surface live through mode changes and a hide/show cycle', () => {
    const custom = { baseThemeId: 'matrix', light: { surface: '#fbf1c7' }, dark: { surface: '#32302f' } };
    const { container, getByRole } = render(<OSWindow surfaceId="custom-chat" sidebarWidth={248} safeAreaLayout="sidebar"
      sidebar={<nav>Navigation</nav>} topBar={<TopBar showSidebarTrigger />} />);
    const sidebar = container.querySelector<HTMLElement>('[data-os-window-sidebar]')!;
    for (const mode of ['light', 'dark'] as const) {
      applyUnifiedTheme('custom', mode, custom);
      expect(color(sidebar, 'background')).toBe(custom[mode].surface);
      fireEvent.click(getByRole('button', { name: 'Toggle sidebar' }));
      expect(sidebar.hidden).toBe(true);
      fireEvent.click(getByRole('button', { name: 'Toggle sidebar' }));
      expect(sidebar.hidden).toBe(false);
      expect(color(sidebar, 'background')).toBe(custom[mode].surface);
    }
  });
});

// Hue is measured independently from the production interpolation. Neutral
// colours have no meaningful hue; their paired foreground still must pass AA.
function hue(hex: string): number | null {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r!, g!, b!), min = Math.min(r!, g!, b!), delta = max - min;
  if (delta < 0.03) return null;
  const sector = max === r ? (g! - b!) / delta : max === g ? (b! - r!) / delta + 2 : (r! - g!) / delta + 4;
  return (sector * 60 + 360) % 360;
}

describe('palette-owned primary actions', () => {
  it('restores Gruvbox dark warm primary actions in Web and Electron', () => {
    applyUnifiedTheme('gruvbox', 'dark');
    const web = buildWebTheme({ ...DEFAULT_APPEARANCE, themeId: 'gruvbox', mode: 'dark' });
    expect(web.colors.primary).toBe('#fabd2f');
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#fabd2f');
    const hover = document.documentElement.style.getPropertyValue('--accent-hover');
    expect(hue(hover)).toBeGreaterThanOrEqual(30);
    expect(hue(hover)).toBeLessThanOrEqual(55);
    expect(web.colors['primary-hover']).toBe(hover);
  });

  for (const theme of unifiedThemes) for (const mode of ['light', 'dark'] as const) {
    it(`${theme.id} ${mode}: preserves its palette and readable action foregrounds`, () => {
      applyUnifiedTheme(theme.id, mode);
      const web = buildWebTheme({ ...DEFAULT_APPEARANCE, themeId: theme.id, mode });
      const hover = document.documentElement.style.getPropertyValue('--accent-hover');
      const foreground = document.documentElement.style.getPropertyValue('--text-on-accent-hover');
      expect(web.colors['primary-hover']).toBe(hover);
      expect(web.colors['primary-hover-foreground']).toBe(foreground);
      expect(contrastRatio(foreground, hover)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(web.colors.primary, web.colors['primary-foreground'])).toBeGreaterThanOrEqual(4.5);
      expect(hover).not.toBe(web.colors.primary);
      if (theme.id === 'matrix' || theme.id === 'matrix-neon') {
        expect(hover).toBe(mode === 'dark' ? '#bed77b' : '#475926');
      } else {
        const primaryHue = hue(web.colors.primary), hoverHue = hue(hover);
        if (primaryHue !== null) {
          expect(hoverHue).not.toBeNull();
          const distance = Math.abs(primaryHue - hoverHue!);
          expect(Math.min(distance, 360 - distance)).toBeLessThan(20);
        }
      }
    });
  }

  for (const accent of ['#fabd2f', '#b32682', '#236f9d', '#fafafa']) {
    it(`keeps custom ${accent} actions independent of the Matrix fallback`, () => {
      const custom = { baseThemeId: 'matrix', light: { accent }, dark: { accent } };
      for (const mode of ['light', 'dark'] as const) {
        applyUnifiedTheme('custom', mode, custom);
        const web = buildWebTheme({ ...DEFAULT_APPEARANCE, themeId: 'custom', mode, customTheme: custom });
        const hover = document.documentElement.style.getPropertyValue('--accent-hover');
        expect(web.colors.primary).toBe(accent);
        expect(web.colors['primary-hover']).toBe(hover);
        expect(contrastRatio(web.colors['primary-hover-foreground'], hover)).toBeGreaterThanOrEqual(4.5);
        const primaryHue = hue(accent), hoverHue = hue(hover);
        if (primaryHue !== null) {
          expect(hoverHue).not.toBeNull();
          const distance = Math.abs(primaryHue - hoverHue!);
          expect(Math.min(distance, 360 - distance)).toBeLessThan(20);
        }
      }
    });
  }
});
