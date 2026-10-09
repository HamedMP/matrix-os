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
