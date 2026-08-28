import type { TerminalThemeId } from "./terminal-settings-types";

export interface AnsiPalette {
  black: string; red: string; green: string; yellow: string;
  blue: string; magenta: string; cyan: string; white: string;
  brightBlack: string; brightRed: string; brightGreen: string; brightYellow: string;
  brightBlue: string; brightMagenta: string; brightCyan: string; brightWhite: string;
}

export interface TerminalThemeOption {
  id: TerminalThemeId;
  label: string;
}

const palettes = {
  light: {
    black: "#282828", red: "#CC241D", green: "#79740E", yellow: "#B57614",
    blue: "#458588", magenta: "#B16286", cyan: "#689D6A", white: "#3C3836",
    brightBlack: "#A89984", brightRed: "#9D0006", brightGreen: "#79740E", brightYellow: "#AF3A03",
    brightBlue: "#076678", brightMagenta: "#8F3F71", brightCyan: "#427B58", brightWhite: "#282828",
  },
  "matrix-dark": {
    black: "#0C0C0C", red: "#D85E5E", green: "#0AD18B", yellow: "#C9A24A",
    blue: "#6AA0FF", magenta: "#B58CFF", cyan: "#00E5C0", white: "#BFBFBF",
    brightBlack: "#5B5B5B", brightRed: "#F06A6A", brightGreen: "#7FE0A0", brightYellow: "#E0A12E",
    brightBlue: "#8CB8FF", brightMagenta: "#CFAAFF", brightCyan: "#74F7E0", brightWhite: "#F0EFE5",
  },
  matrix: {
    black: "#020A02", red: "#2FBF55", green: "#2FBF55", yellow: "#5BF08A",
    blue: "#1FB04E", magenta: "#39FF6A", cyan: "#39FF6A", white: "#2FBF55",
    brightBlack: "#176B30", brightRed: "#5BF08A", brightGreen: "#39FF6A", brightYellow: "#9BFF8F",
    brightBlue: "#5BF08A", brightMagenta: "#8DFFAA", brightCyan: "#B3FFC6", brightWhite: "#D8FFD9",
  },
  "powerlevel10k-lean": {
    black: "#1D2021", red: "#EA6962", green: "#A9B665", yellow: "#D8A657",
    blue: "#7DAEA3", magenta: "#D3869B", cyan: "#89B482", white: "#D4BE98",
    brightBlack: "#665C54", brightRed: "#EA6962", brightGreen: "#A9B665", brightYellow: "#D8A657",
    brightBlue: "#7DAEA3", brightMagenta: "#D3869B", brightCyan: "#89B482", brightWhite: "#F2E5BC",
  },
  "powerlevel10k-lean-8-colors": {
    black: "#000000", red: "#CC5555", green: "#55AA55", yellow: "#CDCD55",
    blue: "#5555CC", magenta: "#CC55CC", cyan: "#55CCCC", white: "#CCCCCC",
    brightBlack: "#555555", brightRed: "#FF5555", brightGreen: "#55FF55", brightYellow: "#FFFF55",
    brightBlue: "#5555FF", brightMagenta: "#FF55FF", brightCyan: "#55FFFF", brightWhite: "#FFFFFF",
  },
  "powerlevel10k-classic": {
    black: "#181825", red: "#F38BA8", green: "#A6E3A1", yellow: "#F9E2AF",
    blue: "#89B4FA", magenta: "#F5C2E7", cyan: "#94E2D5", white: "#BAC2DE",
    brightBlack: "#585B70", brightRed: "#F38BA8", brightGreen: "#A6E3A1", brightYellow: "#F9E2AF",
    brightBlue: "#89B4FA", brightMagenta: "#F5C2E7", brightCyan: "#94E2D5", brightWhite: "#CDD6F4",
  },
  "powerlevel10k-rainbow": {
    black: "#070B14", red: "#FF5C7C", green: "#5AF78E", yellow: "#F3F99D",
    blue: "#57C7FF", magenta: "#FF6AC1", cyan: "#9AEDFE", white: "#E6E6E6",
    brightBlack: "#686868", brightRed: "#FF7092", brightGreen: "#69FF94", brightYellow: "#FFFFA5",
    brightBlue: "#6DD5FF", brightMagenta: "#FF92DF", brightCyan: "#A4FFFF", brightWhite: "#FFFFFF",
  },
  "powerlevel10k-pure": {
    black: "#1B1D1E", red: "#F92672", green: "#A6E22E", yellow: "#FD971F",
    blue: "#66D9EF", magenta: "#AE81FF", cyan: "#38CCD1", white: "#D7D7D7",
    brightBlack: "#75715E", brightRed: "#FF669D", brightGreen: "#BEED5F", brightYellow: "#E6DB74",
    brightBlue: "#89E4F4", brightMagenta: "#C6A3FF", brightCyan: "#66E5E8", brightWhite: "#F8F8F2",
  },
} satisfies Record<TerminalThemeId, AnsiPalette>;

const terminalThemePresets = {
  light: {
    label: "Light", background: "#FBF1C7", foreground: "#3C3836",
    cursor: "#79740E", selectionBackground: "#79740E33",
  },
  "matrix-dark": {
    label: "Matrix OS Dark", background: "#0C0C0C", foreground: "#BFBFBF",
    cursor: "#0AD18B", selectionBackground: "#00E5C033",
  },
  matrix: {
    label: "Matrix", background: "#020A02", foreground: "#2FBF55",
    cursor: "#39FF6A", selectionBackground: "#39FF6A33",
  },
  "powerlevel10k-lean": {
    label: "P10k Lean", background: "#1D2021", foreground: "#D4BE98",
    cursor: "#A9B665", selectionBackground: "#A9B66533",
  },
  "powerlevel10k-lean-8-colors": {
    label: "P10k Lean · 8 colors", background: "#111111", foreground: "#CCCCCC",
    cursor: "#55FF55", selectionBackground: "#55FFFF33",
  },
  "powerlevel10k-classic": {
    label: "P10k Classic", background: "#1E1E2E", foreground: "#CDD6F4",
    cursor: "#89B4FA", selectionBackground: "#89B4FA33",
  },
  "powerlevel10k-rainbow": {
    label: "P10k Rainbow", background: "#0B1020", foreground: "#E6E6E6",
    cursor: "#57C7FF", selectionBackground: "#FF6AC133",
  },
  "powerlevel10k-pure": {
    label: "P10k Pure", background: "#1B1D1E", foreground: "#D7D7D7",
    cursor: "#AE81FF", selectionBackground: "#AE81FF33",
  },
} satisfies Record<TerminalThemeId, {
  label: string;
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
}>;

const TERMINAL_THEME_IDS = [
  "light",
  "matrix-dark",
  "matrix",
  "powerlevel10k-lean",
  "powerlevel10k-lean-8-colors",
  "powerlevel10k-classic",
  "powerlevel10k-rainbow",
  "powerlevel10k-pure",
] as const satisfies readonly TerminalThemeId[];

export const TERMINAL_THEME_OPTIONS: TerminalThemeOption[] = TERMINAL_THEME_IDS.map((id) => ({
  id,
  label: terminalThemePresets[id].label,
}));

export function getTerminalThemePreset(themeId: TerminalThemeId) {
  return {
    ...terminalThemePresets[themeId],
    ...palettes[themeId],
  };
}
