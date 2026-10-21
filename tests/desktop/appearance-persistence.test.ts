import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import { createLocalStore } from '../../desktop/src/main/persistence/local-store';
it('round-trips a bounded custom theme through the real desktop state store', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'matrix-appearance-'));
  try {
    const store = createLocalStore({ dir });
    const value = { theme: 'light', themeId: 'custom', fontId: 'inter', monoFontId: 'system', zoom: 1, customTheme: { baseThemeId: 'matrix', light: { accent: '#123456' }, dark: { background: '#101010' } } };
    await store.setUnknown('appearance', value);
    expect(await store.get('appearance')).toEqual(value);
    await expect(store.setUnknown('appearance', { ...value, fontId: 'url(https://example.com)' })).rejects.toThrow();
    await expect(store.setUnknown('appearance', { ...value, customTheme: { ...value.customTheme, light: { accent: 'url(https://example.com)' } } })).rejects.toThrow();
  } finally { await rm(dir, { recursive: true }); }
});

import { readFileSync } from 'node:fs';
import { getThemeChrome } from '../../packages/brand/src/themes';
import { buildWebTheme } from '../../packages/brand/src/themes/web-theme';
import { DEFAULT_APPEARANCE } from '../../packages/brand/src/themes/preferences';
import { chromeToSemanticVars } from '../../desktop/src/renderer/src/design/themes/apply';
it('keeps both clients first-paint status and interaction colors identical to their loaded Matrix theme', () => {
  const desktop = readFileSync('desktop/src/renderer/src/design/tokens.css', 'utf8').split('[data-theme="dark"]');
  const web = readFileSync('shell/src/app/theme-defaults.css', 'utf8').split('/* Generated dark palette */');
  for (const [index, mode] of ['light', 'dark'].entries()) {
    const resolved = mode as 'light' | 'dark';
    for (const [key, value] of Object.entries(chromeToSemanticVars(getThemeChrome('matrix', resolved)))) {
      expect(desktop[index], `${mode} ${key}`).toContain(`${key}: ${value};`);
    }
    for (const [key, value] of Object.entries(buildWebTheme({ ...DEFAULT_APPEARANCE, mode: resolved }).colors)) {
      expect(web[index], `${mode} ${key}`).toContain(`--${key}: ${value};`);
    }
  }
});
