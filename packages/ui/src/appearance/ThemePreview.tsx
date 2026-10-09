import React from 'react';
import type { UnifiedThemeVariant } from '@matrix-os/brand/themes';

/** A real UI specimen shared by Settings and the visual regression gallery. */
export function ThemePreview({ variant, compact = false, fontFamily, monoFamily }: { variant: UnifiedThemeVariant; compact?: boolean; fontFamily?: string; monoFamily?: string }) {
  const { chrome: c, editor: e } = variant;
  return <div aria-hidden={compact || undefined} style={{ background: c.background, color: c.foreground, border: `1px solid ${c.border}`, borderRadius: 8, overflow: 'hidden', fontFamily, textAlign: 'left' }}>
    <div style={{ display: 'flex', minHeight: compact ? 74 : 190 }}>
      <div style={{ width: compact ? 30 : 104, flexShrink: 0, background: c.sidebar, color: c.sidebarForeground, borderRight: `1px solid ${c.sidebarBorder}`, padding: compact ? 6 : 12 }}>
        {compact ? <><div style={{ height: 4, background: c.foreground, borderRadius: 2, marginBottom: 8 }} /><div style={{ height: 4, background: c.mutedForeground, borderRadius: 2 }} /></> : <><strong style={{ fontSize: 13 }}>Matrix</strong><div style={{ marginTop: 18, padding: 6, background: c.sidebarAccent, color: c.sidebarAccentForeground, borderRadius: 4 }}>Overview</div><div style={{ padding: 6, color: c.mutedForeground }}>Projects</div></>}
      </div>
      <div style={{ padding: compact ? 9 : 20, flex: 1, minWidth: 0 }}>
        {compact ? <><div style={{ height: 5, width: '60%', background: c.foreground, borderRadius: 2 }} /><div style={{ height: 4, width: '80%', background: c.mutedForeground, borderRadius: 2, marginTop: 6 }} /><div style={{ display: 'flex', gap: 5, marginTop: 12 }}><div style={{ width: 30, height: 14, background: c.primary, borderRadius: 3 }} /><div style={{ width: 26, height: 14, border: `1px solid ${c.border}`, borderRadius: 3 }} /></div></> : <>
          <strong style={{ fontSize: 18 }}>A space for your ideas</strong>
          <p style={{ margin: '5px 0 16px', color: c.mutedForeground, fontSize: 13 }}>Everything you need, in your own colors.</p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><span style={{ background: c.primary, color: c.primaryForeground, padding: '7px 12px', borderRadius: 6, fontSize: 12 }}>New project</span><span style={{ border: `1px solid ${c.border}`, borderRadius: 6, padding: '6px 12px', fontSize: 12 }}>Settings</span><span style={{ color: c.chart2, fontSize: 12 }}>✓ Saved</span></div>
          <div style={{ background: e.background, color: e.foreground, fontFamily: monoFamily, fontSize: 12, borderTop: `1px solid ${c.border}`, marginTop: 18, paddingTop: 12 }}><span style={{ color: e.keyword }}>const</span> theme = <span style={{ color: e.string }}>"yours"</span>;<br /><span style={{ color: e.comment }}>// Make yourself at home</span></div>
        </>}
      </div>
    </div>
  </div>;
}
