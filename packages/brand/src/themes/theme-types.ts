// Three-layer unified theme model. Each theme carries chrome (app shell CSS
// variables), terminal (xterm palette), and editor (CodeMirror chrome +
// syntax token) colors so every surface switches together.

/** App chrome palette; mapped onto the semantic CSS variables in tokens.css. */
export interface ChromeColors {
  background: string;
  foreground: string;
  card: string;
  cardForeground: string;
  popover: string;
  popoverForeground: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  destructive: string;
  border: string;
  input: string;
  ring: string;
  chart1: string;
  chart2: string;
  chart3: string;
  chart4: string;
  chart5: string;
  sidebar: string;
  sidebarForeground: string;
  sidebarPrimary: string;
  sidebarPrimaryForeground: string;
  sidebarAccent: string;
  sidebarAccentForeground: string;
  sidebarBorder: string;
  sidebarRing: string;
  surface0: string;
  surface1: string;
  surface2: string;
  surface3: string;
  modal: string;
  modalBorder: string;
}

/** Structural mirror of xterm.js ITheme — no @xterm/xterm dependency here. */
export interface TerminalThemeColors {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionForeground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/** Editor chrome plus syntax token colors for CodeMirror. */
export interface EditorThemeColors {
  background: string;
  foreground: string;
  selection: string;
  cursor: string;
  gutterBackground: string;
  gutterForeground: string;
  lineHighlight: string;
  keyword: string;
  string: string;
  comment: string;
  number: string;
  function: string;
  type: string;
  operator: string;
  variable: string;
  property: string;
  link: string;
  heading: string;
}

/** A single variant (dark or light) of a unified theme. */
export interface UnifiedThemeVariant {
  chrome: ChromeColors;
  terminal: TerminalThemeColors;
  editor: EditorThemeColors;
}

/** A complete unified theme with dark and/or light variants. */
export interface UnifiedThemeDefinition {
  id: string;
  name: string;
  dark?: UnifiedThemeVariant;
  light?: UnifiedThemeVariant;
}
