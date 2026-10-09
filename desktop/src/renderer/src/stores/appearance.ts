import { create } from 'zustand';
import { applyUnifiedTheme, resolveThemeMode, type ThemeMode } from '../design/themes/apply';
import { FONT_OPTIONS, MONO_FONT_OPTIONS, isThemeId } from '../design/themes';
import { DEFAULT_APPEARANCE, normalizeAppearance, type AppearancePreferences } from '@matrix-os/brand/themes/preferences';
import { invoke, onEvent } from '../lib/operator';

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 2;
export const DEFAULT_ZOOM = 1;
export const ZOOM_STEP = 0.1;
function clampZoom(factor: number): number {
  return Number.isFinite(factor) ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(factor * 10) / 10)) : DEFAULT_ZOOM;
}
interface AppearanceState extends AppearancePreferences {
  resolvedMode: "light" | "dark"; zoom: number; hydrated: boolean; pending: boolean; error: string | null;
  load: () => Promise<void>;
  update: (patch: Partial<AppearancePreferences>) => Promise<void>;
  setMode: (mode: ThemeMode) => Promise<void>;
  setThemeId: (themeId: string) => Promise<void>;
  setZoom: (factor: number) => void;
}
function apply(value: AppearancePreferences): void {
  applyUnifiedTheme(value.themeId, value.mode, value.customTheme);
  const root = document.documentElement;
  root.style.setProperty('--font-ui', FONT_OPTIONS.find(f => f.id === value.fontId)!.family);
  root.style.setProperty('--font-mono', MONO_FONT_OPTIONS.find(f => f.id === value.monoFontId)!.family);
}
function payload(value: AppearancePreferences, zoom: number) {
  return { theme: value.mode, themeId: value.themeId, fontId: value.fontId, monoFontId: value.monoFontId, customTheme: value.customTheme, zoom };
}
function applyZoomFactor(zoom: number): void {
  void invoke('app:set-zoom', { factor: zoom }).catch(error => console.warn('[appearance] zoom failed:', error));
}
export const useAppearance = create<AppearanceState>()((set, get) => {
  let unsubscribeZoom: (() => void) | null = null;
  let media: MediaQueryList | null = null;
  let unsubscribeMode: (() => void) | null = null;
  let revision = 0;
  // Bounded, coalesced zoom writes; appearance edits wait for this writer.
  let zoomWriter: Promise<void> = Promise.resolve();
  let zoomDirty = false;
  let zoomWriting = false;
  function persistZoom(): void {
    zoomDirty = true;
    if (zoomWriting) return;
    zoomWriting = true;
    zoomWriter = (async () => {
      while (zoomDirty) {
        zoomDirty = false;
        try { await invoke('state:set', { key: 'appearance', value: payload(get(), get().zoom) }); }
        catch (error) { console.warn('[appearance] persist failed:', error); set({ error: 'Could not save appearance. Please try again.' }); }
      }
      zoomWriting = false;
    })();
  }
  function wireEvents(): void {
    unsubscribeZoom?.();
    unsubscribeZoom = onEvent('app:zoom-changed', ({ factor }) => {
      set({ zoom: clampZoom(factor) });
      zoomDirty = true;
      if (!get().pending) persistZoom();
    });
    unsubscribeMode?.();
    media = window.matchMedia?.('(prefers-color-scheme: dark)') ?? null;
    const listener = () => { if (get().mode === 'system') { apply(get()); set({ resolvedMode: resolveThemeMode(get().mode) }); } };
    media?.addEventListener?.('change', listener);
    unsubscribeMode = () => media?.removeEventListener?.('change', listener);
  }
  return {
    ...DEFAULT_APPEARANCE, resolvedMode: "light", zoom: DEFAULT_ZOOM, hydrated: false, pending: false, error: null,
    load: async () => {
      const loadRevision = revision;
      try {
        const result = await invoke('state:get', { key: 'appearance' });
        if (revision !== loadRevision) return;
        const value = result.value && typeof result.value === 'object' ? result.value as Record<string, unknown> : {};
        const preferences = normalizeAppearance({ ...value, mode: value.theme });
        const zoom = typeof value.zoom === 'number' ? clampZoom(value.zoom) : 1;
        set({ ...preferences, resolvedMode: resolveThemeMode(preferences.mode), zoom, hydrated: true }); apply(preferences); applyZoomFactor(zoom);
      } catch (error) {
        console.warn('[appearance] load failed:', error);
        set({ hydrated: true }); apply(get()); applyZoomFactor(get().zoom);
      }
      wireEvents();
    },
    update: async patch => {
      if (get().pending) return;
      const next = normalizeAppearance({ ...get(), ...patch });
      revision++;
      set({ pending: true, error: null });
      try {
        await zoomWriter;
        const savedZoom = get().zoom;
        await invoke('state:set', { key: 'appearance', value: payload(next, savedZoom) });
        set({ ...next, resolvedMode: resolveThemeMode(next.mode), pending: false }); apply(next);
        if (get().zoom !== savedZoom) zoomDirty = true;
      } catch (error) {
        console.warn('[appearance] persist failed:', error);
        set({ pending: false, error: 'Could not save appearance. Please try again.' });
      } finally {
        if (zoomDirty) persistZoom();
      }
    },
    setMode: mode => get().update({ mode }),
    setThemeId: async themeId => { if (isThemeId(themeId)) await get().update({ themeId }); },
    setZoom: factor => { if (get().pending) return; const zoom = clampZoom(factor); set({ zoom }); applyZoomFactor(zoom); persistZoom(); },
  };
});
export function resolvedAppearanceMode(): 'dark' | 'light' { return resolveThemeMode(useAppearance.getState().mode); }
