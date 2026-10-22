import type { UnifiedThemeVariant } from './theme-types.js';
import { mix, readable, polishVariant } from './customization.js';

// Light companions retain each original palette's hue family. The neutral
// ground and ink are explicit so light mode never silently renders dark.
export function lightCompanion(dark: UnifiedThemeVariant, paper: string, ink: string): UnifiedThemeVariant {
  const c = dark.chrome;
  const surface = mix(paper, '#ffffff', 0.55);
  const muted = mix(paper, ink, 0.065);
  const border = mix(paper, ink, 0.24);
  const accent = readable(c.ring, [paper, surface]);
  return polishVariant({
    chrome: { ...c, background: paper, foreground: ink, card: surface, cardForeground: ink, popover: surface, popoverForeground: ink,
      primary: accent, primaryForeground: '#ffffff', secondary: muted, secondaryForeground: ink, muted, mutedForeground: mix(ink, paper, 0.28),
      accent: muted, accentForeground: ink, destructive: readable(c.destructive, [paper]), border, input: border, ring: accent,
      sidebar: muted, sidebarForeground: ink, sidebarPrimary: accent, sidebarPrimaryForeground: '#ffffff', sidebarAccent: surface, sidebarAccentForeground: ink,
      sidebarBorder: border, sidebarRing: accent, surface0: muted, surface1: paper, surface2: surface, surface3: '#ffffff', modal: surface, modalBorder: border,
      chart1: readable(c.chart1, [paper]), chart2: readable(c.chart2, [paper]), chart3: readable(c.chart3, [paper]), chart4: readable(c.chart4, [paper]), chart5: readable(c.chart5, [paper]) },
    terminal: { ...dark.terminal, background: paper, foreground: ink, cursor: accent, cursorAccent: paper, selectionBackground: border, selectionForeground: ink, black: ink, white: muted, brightWhite: '#ffffff' },
    editor: { ...dark.editor, background: paper, foreground: ink, gutterBackground: paper, gutterForeground: mix(ink, paper, 0.28), selection: border, cursor: accent, lineHighlight: muted, variable: ink, heading: ink },
  });
}
