// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildWebTheme } from '../../packages/brand/src/themes/web-theme';
import { DEFAULT_APPEARANCE } from '../../packages/brand/src/themes/preferences';
import { resetThemeRuntimeCacheForTests, saveTheme, useThemeState } from '../../shell/src/hooks/useTheme';
import { createShellSnapshotScope, loadShellSnapshot, saveShellSnapshot } from '../../shell/src/lib/shell-snapshot-cache';
import { DesignPicker } from '../../shell/src/components/settings/DesignPicker';
import { ThemeSettings } from '../../shell/src/components/settings/ThemeSettings';

const watcher = vi.hoisted(() => ({ callback: null as null | ((path: string, event: string) => void) }));
vi.mock('../../shell/src/hooks/useFileWatcher', () => ({ useFileWatcher: (callback: typeof watcher.callback) => { watcher.callback = callback; } }));
vi.mock('../../shell/src/hooks/useDesktopConfig', () => ({ saveDesktopConfigPatch: vi.fn().mockResolvedValue(undefined) }));
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


describe('shared theme write admission and cache recovery', () => {
  it.each(['custom', 'design'] as const)('prevents overlapping %s/design writes and preserves an unsaved colour draft', async (first) => {
    let finish!: (value: { ok: boolean }) => void;
    const requests: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn((_url, options) => {
      if (options?.method === 'PUT') {
        requests.push(JSON.parse(options.body));
        return new Promise(resolve => { finish = resolve; });
      }
      return Promise.resolve({ ok: true, json: async () => buildWebTheme() });
    }));
    render(<><ThemeSettings /><DesignPicker /></>);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create custom theme' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Create custom theme' }));
    fireEvent.change(screen.getByLabelText('Buttons color'), { target: { value: '#123456' } });
    const save = screen.getByRole('button', { name: 'Save custom theme' }) as HTMLButtonElement;
    const design = screen.getByRole('button', { name: /Windows XP/ }) as HTMLButtonElement;
    fireEvent.click(first === 'custom' ? save : design);
    await waitFor(() => expect(first === 'custom' ? design.disabled : save.disabled).toBe(true));
    await expect(saveTheme(buildWebTheme({ ...DEFAULT_APPEARANCE, themeId: 'nord' }))).rejects.toThrow();
    expect(requests).toHaveLength(1);
    expect((screen.getByLabelText('Buttons color') as HTMLInputElement).value).toBe('#123456');
    await act(async () => { finish({ ok: false }); });
    await waitFor(() => expect(design.disabled).toBe(false));
    expect((screen.getByLabelText('Buttons color') as HTMLInputElement).value).toBe('#123456');
    fireEvent.click(save);
    expect(requests).toHaveLength(2);
    await act(async () => { finish({ ok: true }); });
    await waitFor(() => expect(save.disabled).toBe(false));
    expect(screen.queryByText('Could not save appearance. Please try again.')).toBeNull();
    expect(requests[1]).toEqual(expect.objectContaining({ appearance: expect.objectContaining({ customTheme: expect.objectContaining({ light: expect.objectContaining({ accent: '#123456' }) }) }) }));
  });

  it('restores normalized System preferences before fetch and after failed reload within the owner scope', async () => {
    let onChange: (() => void) | undefined;
    const media = { matches: true, addEventListener: (_: string, fn: () => void) => { onChange = fn; }, removeEventListener: vi.fn() };
    vi.stubGlobal('matchMedia', vi.fn(() => media));
    const scope = createShellSnapshotScope({ userId: 'user_themes_cache', pathname: '/vm/themes-preview' })!;
    const otherScope = createShellSnapshotScope({ userId: 'user_other_cache', pathname: '/vm/themes-preview' })!;
    const saved = buildWebTheme({ ...DEFAULT_APPEARANCE, mode: 'system', fontId: 'inter' });
    saveShellSnapshot(scope, { theme: saved });
    expect(loadShellSnapshot(scope)?.theme?.appearance).toEqual(saved.appearance);
    expect(loadShellSnapshot(otherScope)).toBeNull();
    let finish!: (value: { ok: boolean }) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { finish = resolve; })));
    const { result } = renderHook(() => useThemeState({ cacheScope: scope }));
    expect(result.current.loaded).toBe(false);
    expect(result.current.theme.appearance?.mode).toBe('system');
    expect(result.current.theme.mode).toBe('dark');
    await act(async () => { finish({ ok: false }); });
    expect(result.current.loadError).toBe(true);
    expect(result.current.theme.mode).toBe('dark');
    act(() => { media.matches = false; onChange?.(); });
    expect(result.current.theme.mode).toBe('light');
    expect(result.current.theme.appearance?.fontId).toBe('inter');
  });
});
