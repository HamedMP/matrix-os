"use client";
import { useEffect, useState } from 'react';
import { AppearanceControls, type AppearancePreferences } from '@matrix-os/ui/appearance';
import { appearanceFromWebTheme, updateWebTheme } from '@matrix-os/brand/themes/web-theme';
import { saveTheme, useThemeState } from '@/hooks/useTheme';

export function ThemeSettings() {
  const { theme, loaded, loadError } = useThemeState();
  const value = appearanceFromWebTheme(theme);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [systemDark, setSystemDark] = useState(false);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setSystemDark(media.matches);
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  async function change(patch: Partial<AppearancePreferences>) {
    if (pending || !loaded) return;
    setPending(true); setError(null);
    try { await saveTheme(updateWebTheme(theme, patch, systemDark)); }
    catch (error) { console.warn('[appearance] save failed:', error); setError('Could not save appearance. Please try again.'); }
    setPending(false);
  }
  if (!loaded) return <p role={loadError ? 'alert' : 'status'}>{loadError ? 'Could not load appearance. Reload before making changes.' : 'Loading appearance…'}</p>;
  return <AppearanceControls value={value} resolvedMode={value.mode === 'system' ? systemDark ? 'dark' : 'light' : value.mode} pending={pending || !loaded} error={error ?? (loadError ? 'Could not load appearance. Reload before making changes.' : null)} onChange={change} />;
}
