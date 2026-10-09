import React from 'react';
import { createRoot } from 'react-dom/client';
import * as Tooltip from '@radix-ui/react-tooltip';
import { ThemePreview } from '../../../packages/ui/src/appearance/ThemePreview';
import { unifiedThemes, getThemeVariant } from '../../../packages/brand/src/themes';
import AppearanceSection from '../../../desktop/src/renderer/src/features/settings/sections/AppearanceSection';
import { useAppearance } from '../../../desktop/src/renderer/src/stores/appearance';
import '../../../desktop/src/renderer/src/design/index.css';
import before from './before.json';

window.operator = {
  invoke: async (channel: string, args: any) => {
    if (channel === 'state:get') return { value: JSON.parse(localStorage.getItem('theme-review') ?? 'null') };
    if (channel === 'state:set') localStorage.setItem('theme-review', JSON.stringify(args.value));
    return { ok: true };
  },
  on: () => () => {},
} as typeof window.operator;
const params = new URLSearchParams(location.search);
const stage = params.get('stage') ?? 'after';
const mode = params.get('mode') === 'dark' ? 'dark' : 'light';
const id = params.get('theme');
const gallery = params.get('view') === 'gallery';
const source = stage === 'before' ? before : unifiedThemes;
Object.assign(document.body.style, { overflow: 'visible', height: 'auto', minHeight: '100vh', position: 'static' });
Object.assign(document.documentElement.style, { overflow: 'auto', height: 'auto', position: 'static' });
Object.assign(document.getElementById('root')!.style, { overflow: 'visible', height: 'auto' });
function Gallery() {
  return <main style={{ padding: 32, maxWidth: 1440, margin: 'auto', fontFamily: 'Geist, sans-serif' }}>
    <h1 style={{ fontSize: 26, fontWeight: 600 }}>Matrix themes · {mode} · {stage}</h1>
    <p style={{ color: '#635f5f', margin: '8px 0 24px' }}>Shared UI specimens · app chrome and code colors</p>
    <div style={{ display: 'grid', gridTemplateColumns: id ? '1fr' : 'repeat(2, minmax(0, 1fr))', gap: 24 }}>
      {source.filter(theme => !id || theme.id === id).map(theme => {
        const variant = stage === 'before' ? theme[mode] ?? theme.dark ?? theme.light : getThemeVariant(theme.id, mode);
        return <section key={theme.id} data-theme-specimen={theme.id}><h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>{theme.name} {!theme[mode] && '(dark fallback)'}</h2><ThemePreview variant={variant!} fontFamily="Geist, sans-serif" monoFamily="JetBrains Mono, monospace" /></section>;
      })}
    </div>
  </main>;
}
function Settings() { return <Tooltip.Provider><main style={{ maxWidth: 940, padding: 32, margin: 'auto' }}><AppearanceSection /></main></Tooltip.Provider>; }
if (!gallery) void useAppearance.getState().load();
createRoot(document.getElementById('root')!).render(gallery ? <Gallery /> : <Settings />);
