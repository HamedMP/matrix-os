import { productScales as s } from '../tokens.js';
import { matrix } from './matrix.js';
import type { UnifiedThemeDefinition, UnifiedThemeVariant } from './theme-types.js';

function variant(dark: boolean): UnifiedThemeVariant {
  const base = matrix[dark ? 'dark' : 'light']!;
  const background = dark ? s.neutral[900] : s.green[25];
  const card = dark ? s.neutral[800] : s.green[50];
  const selected = dark ? s.neutral[700] : s.green[100];
  const foreground = dark ? s.neutral[25] : s.neutral[800];
  const mutedForeground = dark ? s.neutral[300] : s.neutral[600];
  const accent = dark ? s.green[300] : s.green[700];
  const border = dark ? s.neutral[700] : s.green[200];
  const red = dark ? s.coral[300] : s.coral[600];
  const green = dark ? s.teal[300] : s.teal[600];
  const yellow = dark ? s.gold[300] : s.gold[700];
  const blue = dark ? s.blue[200] : s.blue[600];
  return {
    chrome: { ...base.chrome, background, foreground, card, cardForeground: foreground,
      popover: dark ? s.neutral[900] : s.green[25], popoverForeground: foreground,
      secondary: selected, secondaryForeground: foreground, muted: selected, mutedForeground,
      accent: card, accentForeground: foreground, border, input: border,
      chart1: blue, chart2: green, chart3: yellow, chart4: accent, chart5: red, destructive: dark ? s.coral[300] : s.coral[500],
      sidebar: background, sidebarForeground: foreground, sidebarAccent: selected, sidebarAccentForeground: foreground, sidebarBorder: border,
      surface0: background, surface1: background, surface2: card, surface3: selected, modal: card, modalBorder: border },
    terminal: { ...base.terminal, background, foreground, cursor: accent, cursorAccent: background,
      selectionBackground: selected, selectionForeground: foreground,
      red, green, yellow, blue, magenta: red, cyan: accent,
      brightRed: red, brightGreen: green, brightYellow: yellow, brightBlue: blue, brightMagenta: red, brightCyan: accent,
      black: dark ? s.neutral[900] : s.neutral[800], white: foreground, brightBlack: mutedForeground, brightWhite: foreground },
    editor: { ...base.editor, background, foreground, selection: selected, cursor: accent,
      gutterBackground: background, gutterForeground: mutedForeground, lineHighlight: card,
      keyword: accent, string: green, comment: mutedForeground, number: yellow, function: blue,
      type: yellow, operator: foreground, variable: foreground, property: blue, link: accent, heading: foreground },
  };
}
export const matrixNeon: UnifiedThemeDefinition = { id: 'matrix-neon', name: 'Matrix Neon', light: variant(false), dark: variant(true) };
