// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildWebTheme } from '../../packages/brand/src/themes/web-theme';
import { DEFAULT_APPEARANCE } from '../../packages/brand/src/themes/preferences';
import { resetThemeRuntimeCacheForTests, useThemeState } from '../../shell/src/hooks/useTheme';
import { ThemeSettings } from '../../shell/src/components/settings/ThemeSettings';

const watcher = vi.hoisted(() => ({ callback: null as null | ((path: string, event: string) => void) }));
vi.mock('../../shell/src/hooks/useFileWatcher', () => ({ useFileWatcher: (callback: typeof watcher.callback) => { watcher.callback = callback; } }));
vi.mock('../../shell/src/lib/gateway', () => ({ getGatewayUrl: () => 'http://gateway.test' }));

beforeEach(() => {
  resetThemeRuntimeCacheForTests();
  watcher.callback = null;
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); document.documentElement.removeAttribute('style'); });

describe('theme live state recovery', () => {
  it('returns newly resolved System colours to Terminal and other hook consumers', async () => {
    let onChange: (() => void) | undefined;
    const media = { matches: false, addEventListener: (_: string, fn: () => void) => { onChange = fn; }, removeEventListener: vi.fn() };
    vi.stubGlobal('matchMedia', vi.fn(() => media));
    const saved = buildWebTheme({ ...DEFAULT_APPEARANCE, mode: 'system' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => saved }));
    const { result } = renderHook(() => useThemeState());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.theme.mode).toBe('light');
    act(() => { media.matches = true; onChange?.(); });
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(result.current.theme.mode).toBe('dark');
    expect(result.current.theme.colors.background).toBe(buildWebTheme(saved.appearance, true).colors.background);
    expect(result.current.theme.appearance?.mode).toBe('system');
  });

  it('keeps the loaded theme when a later watcher read fails', async () => {
    const saved = buildWebTheme({ ...DEFAULT_APPEARANCE, themeId: 'nord' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, json: async () => saved }).mockResolvedValueOnce({ ok: false }));
    const { result } = renderHook(() => useThemeState());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    await act(async () => { watcher.callback?.('system/theme.json', 'change'); });
    expect(result.current.loaded).toBe(true);
    expect(result.current.loadError).toBe(true);
    expect(result.current.theme.appearance?.themeId).toBe('nord');
  });

  it('preserves the unsaved colour editor across failed background refreshes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, json: async () => buildWebTheme() }).mockResolvedValueOnce({ ok: false }));
    render(<ThemeSettings />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create custom theme' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Create custom theme' }));
    fireEvent.change(screen.getByLabelText('Buttons color'), { target: { value: '#123456' } });
    await act(async () => { watcher.callback?.('system/theme.json', 'change'); });
    expect((screen.getByLabelText('Buttons color') as HTMLInputElement).value).toBe('#123456');
    expect(screen.getByRole('alert').textContent).toContain('Could not load appearance');
    expect((screen.getByRole('button', { name: 'Save custom theme' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
