import React, { useState } from 'react';
import { COLOR_FIELDS, FONT_OPTIONS, MONO_FONT_OPTIONS, getThemeVariant, unifiedThemes, type CustomTheme, type FontId, type MonoFontId } from '@matrix-os/brand/themes';
import { ThemePreview } from './ThemePreview';

import type { AppearancePreferences } from "@matrix-os/brand/themes/preferences";
export type { AppearancePreferences } from "@matrix-os/brand/themes/preferences";
export interface AppearanceControlsProps {
  value: AppearancePreferences; resolvedMode: 'light' | 'dark'; pending?: boolean; error?: string | null;
  onChange: (patch: Partial<AppearancePreferences>) => void | Promise<void>;
}
const labels = { background: 'Background', surface: 'Panels', text: 'Text', accent: 'Buttons', border: 'Borders' };
const fieldStyle: React.CSSProperties = { padding: '8px 10px', border: '1px solid var(--appearance-border, var(--border-default, var(--border, #c8c6c6)))', borderRadius: 6, background: 'transparent', color: 'inherit', font: 'inherit' };
export function AppearanceControls({ value, resolvedMode, pending, error, onChange }: AppearanceControlsProps) {
  const [draft, setDraft] = useState<CustomTheme | null>(null);
  const [editingMode, setEditingMode] = useState<'light' | 'dark'>(resolvedMode);
  const variant = getThemeVariant(value.themeId, resolvedMode, value.customTheme);
  const font = FONT_OPTIONS.find(f => f.id === value.fontId) ?? FONT_OPTIONS[0];
  const mono = MONO_FONT_OPTIONS.find(f => f.id === value.monoFontId) ?? MONO_FONT_OPTIONS[0];
  const choices = [...unifiedThemes, ...(value.customTheme ? [{ id: 'custom', name: 'Custom' }] : [])];
  const button = (active: boolean): React.CSSProperties => ({ ...fieldStyle, cursor: 'pointer', background: active ? variant.chrome.primary : 'transparent', color: active ? variant.chrome.primaryForeground : 'inherit' });
  const change = (patch: Partial<AppearancePreferences>) => { if (!pending) void onChange(patch); };
  const startCustom = () => { setDraft(value.customTheme ?? { baseThemeId: value.themeId, light: {}, dark: {} }); setEditingMode(resolvedMode); };
  const preview = draft ? getThemeVariant('custom', editingMode, draft) : variant;
  return <div style={{ display: 'grid', gap: 24, fontSize: 14 }}>
    <section style={{ display: 'grid', gap: 10 }} aria-label="Color mode">
      <strong>Mode</strong>
      <div style={{ display: 'flex', gap: 8 }}>{(['light', 'dark', 'system'] as const).map(mode => <button type="button" disabled={pending} key={mode} aria-pressed={value.mode === mode} style={button(value.mode === mode)} onClick={() => change({ mode })}>{mode === 'system' ? 'System' : mode === 'light' ? 'Light' : 'Dark'}</button>)}</div>
      <span style={{ color: variant.chrome.mutedForeground, fontSize: 12 }}>New installations start in Matrix light. System follows your device.</span>
    </section>
    <ThemePreview variant={variant} fontFamily={font.family} monoFamily={mono.family} />
    <section style={{ display: 'grid', gap: 12 }} aria-label="Themes">
      <strong>Theme</strong>
      <div role="radiogroup" aria-label="Theme" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
        {choices.map((theme, index) => <button type="button" key={theme.id} role="radio" aria-label={`Use ${theme.name} theme`} aria-checked={theme.id === value.themeId} tabIndex={theme.id === value.themeId ? 0 : -1} aria-disabled={!!pending}
          style={{ ...fieldStyle, padding: 8, textAlign: 'left', cursor: 'pointer', outline: theme.id === value.themeId ? `2px solid ${variant.chrome.primary}` : undefined, outlineOffset: 1 }}
          onClick={() => change({ themeId: theme.id })} onKeyDown={event => {
            if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(event.key)) return;
            event.preventDefault();
            if (pending) return;
            const offset = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
            const next = choices[(index + offset + choices.length) % choices.length]!;
            change({ themeId: next.id });
            const siblings = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
            siblings?.[(index + offset + choices.length) % choices.length]?.focus();
          }}>
          <ThemePreview compact variant={getThemeVariant(theme.id, resolvedMode, value.customTheme)} />
          <span style={{ display: 'flex', justifyContent: 'space-between', marginTop: 9, gap: 6 }}><span>{theme.name}</span>{theme.id === value.themeId && <span aria-hidden>✓</span>}</span>
          <span style={{ display: 'block', color: variant.chrome.mutedForeground, fontSize: 11, marginTop: 3 }}>{theme.id === 'matrix' ? 'Default · light + dark' : 'Light + dark'}</span>
        </button>)}
      </div>
    </section>
    <section style={{ display: 'grid', gap: 12 }} aria-label="Fonts"><strong>Typography</strong>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <label style={{ display: 'grid', gap: 6, flex: '1 1 180px' }}>Interface font<select aria-label="Interface font" style={fieldStyle} disabled={pending} value={value.fontId} onChange={e => change({ fontId: e.target.value as FontId })}>{FONT_OPTIONS.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}</select></label>
        <label style={{ display: 'grid', gap: 6, flex: '1 1 180px' }}>Code font<select aria-label="Code font" style={fieldStyle} disabled={pending} value={value.monoFontId} onChange={e => change({ monoFontId: e.target.value as MonoFontId })}>{MONO_FONT_OPTIONS.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}</select></label>
      </div>
    </section>
    <section style={{ display: 'grid', gap: 12 }} aria-label="Custom theme"><div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}><strong>Your colors</strong><button type="button" style={button(false)} disabled={pending} onClick={startCustom}>{value.customTheme ? 'Edit custom theme' : 'Create custom theme'}</button></div>
      <span style={{ color: variant.chrome.mutedForeground, fontSize: 12 }}>Start from a preset. Text contrast adjusts for readability.</span>
      {draft && <>
        <label style={{ display: 'grid', gap: 6 }}>Base theme<select style={fieldStyle} value={draft.baseThemeId} onChange={e => setDraft({ ...draft, baseThemeId: e.target.value })}>{unifiedThemes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
        <div style={{ display: 'flex', gap: 8 }}>{(['light', 'dark'] as const).map(mode => <button type="button" key={mode} style={button(editingMode === mode)} aria-pressed={editingMode === mode} onClick={() => setEditingMode(mode)}>Edit {mode}</button>)}</div>
        <ThemePreview variant={preview} fontFamily={font.family} monoFamily={mono.family} />
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>{COLOR_FIELDS.map(key => {
          const base = getThemeVariant(draft.baseThemeId, editingMode).chrome;
          const color = draft[editingMode][key] ?? base[key === 'surface' ? 'card' : key === 'text' ? 'foreground' : key === 'accent' ? 'primary' : key];
          return <label key={key} style={{ display: 'grid', gap: 6 }}>{labels[key]}<input type="color" aria-label={`${labels[key]} color`} value={/^#[\da-f]{6}$/i.test(color) ? color : '#888888'} onChange={e => setDraft({ ...draft, [editingMode]: { ...draft[editingMode], [key]: e.target.value } })} style={{ width: 56, height: 34, cursor: 'pointer' }} /></label>;
        })}</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><button type="button" disabled={pending} style={button(true)} onClick={() => change({ themeId: 'custom', customTheme: draft })}>Save custom theme</button><button type="button" disabled={pending} style={button(false)} onClick={() => setDraft({ ...draft, [editingMode]: {} })}>Reset {editingMode} colors</button><button type="button" style={button(false)} onClick={() => setDraft(null)}>Close editor</button></div>
      </>}
    </section>
    {pending && <p role="status">Saving appearance…</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
