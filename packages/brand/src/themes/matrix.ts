import { productColors as p } from '../tokens.js';
import { mix } from './customization.js';
import type { UnifiedThemeDefinition, UnifiedThemeVariant } from './theme-types.js';

function variant(dark: boolean): UnifiedThemeVariant {
  const background = dark ? p.night : p.paper;
  const surface = dark ? p.ink : p.card;
  const foreground = dark ? p.paper : p.ink;
  const muted = dark ? p.darkMuted : p.muted;
  const line = dark ? p.darkLine : p.line;
  const primary = foreground;
  // White navigation in light mode; deep forest navigation in dark mode.
  const sidebar = dark ? mix(p.night, p.tealDark, 0.18) : '#ffffff';
  const sidebarAccent = dark ? mix(sidebar, p.green, 0.22) : mix('#ffffff', p.greenLight, 0.22);
  const sidebarBorder = dark ? mix(sidebar, p.green, 0.3) : mix('#ffffff', p.green, 0.2);
  const success = dark ? p.tealLight : p.tealDark;
  const danger = dark ? p.coralLight : p.coralDark;
  const blue = dark ? p.blueLight : p.blueDark;
  const gold = dark ? p.goldLight : p.goldDark;
  const green = dark ? p.greenLight : p.greenDark;
  const selection = dark ? p.darkLine : '#e1e0e0';
  return {
    chrome: {
      background, foreground, card: surface, cardForeground: foreground, popover: surface, popoverForeground: foreground,
      primary, primaryForeground: background, secondary: surface, secondaryForeground: foreground,
      muted: selection, mutedForeground: muted, accent: surface, accentForeground: foreground,
      destructive: danger, border: line, input: line, ring: p.gold,
      chart1: blue, chart2: success, chart3: gold, chart4: green, chart5: danger,
      sidebar, sidebarForeground: foreground, sidebarPrimary: primary, sidebarPrimaryForeground: background,
      sidebarAccent, sidebarAccentForeground: dark ? p.greenLight : p.greenDark, sidebarBorder, sidebarRing: p.gold,
      surface0: background, surface1: background, surface2: surface, surface3: dark ? p.darkLine : p.paper,
      modal: surface, modalBorder: line,
    },
    terminal: {
      background, foreground, cursor: foreground, cursorAccent: background, selectionBackground: selection, selectionForeground: foreground,
      black: dark ? p.night : p.ink, red: danger, green: success, yellow: gold, blue, magenta: dark ? '#da9481' : '#8f432d', cyan: green, white: p.card,
      brightBlack: muted, brightRed: danger, brightGreen: success, brightYellow: gold, brightBlue: blue, brightMagenta: danger, brightCyan: green, brightWhite: p.paper,
    },
    editor: {
      background, foreground, selection, cursor: foreground, gutterBackground: background, gutterForeground: muted,
      lineHighlight: surface, keyword: green, string: success, comment: muted, number: gold, function: blue,
      type: gold, operator: foreground, variable: foreground, property: blue, link: foreground, heading: foreground,
    },
  };
}
export const matrix: UnifiedThemeDefinition = { id: 'matrix', name: 'Matrix', light: variant(false), dark: variant(true) };
