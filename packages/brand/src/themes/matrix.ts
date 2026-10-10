import { productColors as p, productScales as scales } from '../tokens.js';
import type { UnifiedThemeDefinition, UnifiedThemeVariant } from './theme-types.js';

function variant(dark: boolean): UnifiedThemeVariant {
  const background = dark ? p.night : p.paper;
  const surface = dark ? p.ink : p.card;
  const foreground = dark ? p.paper : p.ink;
  const muted = dark ? scales.neutral[300] : p.muted;
  const line = dark ? p.darkLine : p.line;
  const primary = foreground;
  // Light navigation stays paper-white; dark navigation uses the teal scale.
  const sidebar = dark ? scales.teal[900] : scales.neutral[25];
  const sidebarAccent = dark ? scales.neutral[700] : scales.neutral[100];
  const sidebarBorder = line;
  const success = dark ? p.tealLight : p.tealDark;
  const danger = dark ? p.coralLight : p.coral;
  const blue = dark ? p.blueLight : p.blueDark;
  const gold = dark ? p.goldLight : p.goldDark;
  const green = dark ? p.greenLight : p.greenDark;
  const selection = dark ? p.darkLine : '#e1e0e0';
  return {
    chrome: {
      background, foreground, card: surface, cardForeground: foreground, popover: dark ? p.ink : p.paper, popoverForeground: foreground,
      primary, primaryForeground: background, secondary: sidebarAccent, secondaryForeground: foreground,
      muted: selection, mutedForeground: muted, accent: sidebarAccent, accentForeground: foreground,
      destructive: danger, border: line, input: line, ring: p.gold,
      chart1: dark ? p.blueLight : p.blue, chart2: dark ? p.tealLight : p.teal, chart3: dark ? p.goldLight : scales.gold[500], chart4: green, chart5: danger,
      sidebar, sidebarForeground: foreground, sidebarPrimary: primary, sidebarPrimaryForeground: background,
      sidebarAccent, sidebarAccentForeground: foreground, sidebarBorder, sidebarRing: p.gold,
      surface0: background, surface1: background, surface2: surface, surface3: dark ? p.darkLine : p.paper,
      modal: surface, modalBorder: line,
    },
    terminal: {
      background, foreground, cursor: foreground, cursorAccent: background, selectionBackground: selection, selectionForeground: foreground,
      black: dark ? p.night : p.ink, red: dark ? p.coralLight : p.coralDark, green: success, yellow: gold, blue, magenta: dark ? p.coralLight : p.coralDark, cyan: green, white: p.card,
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
