import React from 'react';
import { createRoot } from 'react-dom/client';
import * as Tooltip from '@radix-ui/react-tooltip';
import { ThemePreview } from '../../../packages/ui/src/appearance/ThemePreview';
import { unifiedThemes, getThemeVariant, themeSemantics } from '../../../packages/brand/src/themes';
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
function ReviewStates({ variant }: { variant: ReturnType<typeof getThemeVariant> }) {
  const c = variant.chrome;
  const semantic = themeSemantics(c);
  const tones = ['success', 'warning', 'danger', 'info'] as const;
  return <div style={{ background: c.card, color: c.foreground, padding: 12, border: `1px solid ${c.border}`, borderRadius: 8, marginTop: 8, fontSize: 12 }}>
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <span style={{ background: semantic.primaryHover, color: semantic.primaryHoverForeground, padding: '6px 10px', borderRadius: 8 }}>Action hover</span>
      <span style={{ background: c.muted, color: c.mutedForeground, padding: '6px 10px', borderRadius: 8 }}>Disabled</span>
      <div style={{ background: c.popover, padding: 3, borderRadius: 8 }}><span style={{ display: 'block', padding: '3px 10px', background: c.accent, color: c.accentForeground, borderRadius: 6 }}>Menu hover</span></div>
    </div>
    <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>{tones.map(tone => <span key={tone} style={{ padding: '5px 9px', borderRadius: 8, background: semantic[`${tone}Muted`], color: semantic[`${tone}Text`] }}>{tone === 'danger' ? 'Error' : tone}</span>)}</div>
    {variant === getThemeVariant('matrix-neon', mode) && <div style={{ fontFamily: 'JetBrains Mono, monospace', marginTop: 8 }}>{(['red', 'green', 'yellow', 'blue'] as const).map(color => <span key={color} style={{ color: variant.terminal[color], marginRight: 12 }}>{color}</span>)}</div>}
  </div>;
}
function Gallery() {
  return <main style={{ padding: 32, maxWidth: 1440, margin: 'auto', fontFamily: 'Geist, sans-serif' }}>
    <h1 style={{ fontSize: 26, fontWeight: 600 }}>Matrix themes · {mode} · {stage}</h1>
    <p style={{ color: '#635f5f', margin: '8px 0 24px' }}>Shared UI specimens · app chrome and code colors</p>
    <div style={{ display: 'grid', gridTemplateColumns: id ? '1fr' : 'repeat(2, minmax(0, 1fr))', gap: 24 }}>
      {source.filter(theme => !id || theme.id === id).map(theme => {
        const variant = stage === 'before' ? theme[mode] ?? theme.dark ?? theme.light : getThemeVariant(theme.id, mode);
        return <section key={theme.id} data-theme-specimen={theme.id}><h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>{theme.name} {!theme[mode] && '(dark fallback)'}</h2><ThemePreview variant={variant!} fontFamily="Geist, sans-serif" monoFamily="JetBrains Mono, monospace" />{stage === "after" && <ReviewStates variant={variant!} />}</section>;
      })}
    </div>
  </main>;
}
function Settings() { return <Tooltip.Provider><main style={{ maxWidth: 940, padding: 32, margin: 'auto' }}><AppearanceSection /></main></Tooltip.Provider>; }
if (!gallery) void useAppearance.getState().load();
createRoot(document.getElementById('root')!).render(gallery ? <Gallery /> : <Settings />);
