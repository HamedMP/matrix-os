export interface AnsiPalette {
  black: string; red: string; green: string; yellow: string;
  blue: string; magenta: string; cyan: string; white: string;
  brightBlack: string; brightRed: string; brightGreen: string; brightYellow: string;
  brightBlue: string; brightMagenta: string; brightCyan: string; brightWhite: string;
}

export interface TerminalThemeOption {
  id: import("@/stores/terminal-settings").TerminalThemeId;
  label: string;
}

const palettes: Record<string, AnsiPalette> = {
  "one-dark": {
    black: "#282c34",
    red: "#e06c75",
    green: "#98c379",
    yellow: "#e5c07b",
    blue: "#61afef",
    magenta: "#c678dd",
    cyan: "#56b6c2",
    white: "#abb2bf",
    brightBlack: "#5c6370",
    brightRed: "#e06c75",
    brightGreen: "#98c379",
    brightYellow: "#e5c07b",
    brightBlue: "#61afef",
    brightMagenta: "#c678dd",
    brightCyan: "#56b6c2",
    brightWhite: "#ffffff",
  },
  "one-light": {
    black: "#383a42",
    red: "#e45649",
    green: "#50a14f",
    yellow: "#c18401",
    blue: "#4078f2",
    magenta: "#a626a4",
    cyan: "#0184bc",
    white: "#a0a1a7",
    brightBlack: "#696c77",
    brightRed: "#e45649",
    brightGreen: "#50a14f",
    brightYellow: "#c18401",
    brightBlue: "#4078f2",
    brightMagenta: "#a626a4",
    brightCyan: "#0184bc",
    // Was #fafafa which equals the background — bold/bright-white text
    // disappeared. Use a very light neutral that still has contrast.
    brightWhite: "#dcdcdc",
  },
  "catppuccin-mocha": {
    black: "#45475a",
    red: "#f38ba8",
    green: "#a6e3a1",
    yellow: "#f9e2af",
    blue: "#89b4fa",
    magenta: "#f5c2e7",
    cyan: "#94e2d5",
    white: "#bac2de",
    brightBlack: "#585b70",
    brightRed: "#f38ba8",
    brightGreen: "#a6e3a1",
    brightYellow: "#f9e2af",
    brightBlue: "#89b4fa",
    brightMagenta: "#f5c2e7",
    brightCyan: "#94e2d5",
    // Catppuccin "text" — the brightest fg variant. Was previously subtext0
    // which is *darker* than `white` and made bold text look dim.
    brightWhite: "#cdd6f4",
  },
  "dracula": {
    black: "#21222c",
    red: "#ff5555",
    green: "#50fa7b",
    yellow: "#f1fa8c",
    blue: "#bd93f9",
    magenta: "#ff79c6",
    cyan: "#8be9fd",
    white: "#f8f8f2",
    brightBlack: "#6272a4",
    brightRed: "#ff6e6e",
    brightGreen: "#69ff94",
    brightYellow: "#ffffa5",
    brightBlue: "#d6acff",
    brightMagenta: "#ff92df",
    brightCyan: "#a4ffff",
    brightWhite: "#ffffff",
  },
  "nord": {
    black: "#3b4252",
    red: "#bf616a",
    green: "#a3be8c",
    yellow: "#ebcb8b",
    blue: "#81a1c1",
    magenta: "#b48ead",
    cyan: "#88c0d0",
    white: "#e5e9f0",
    brightBlack: "#4c566a",
    brightRed: "#bf616a",
    brightGreen: "#a3be8c",
    brightYellow: "#ebcb8b",
    brightBlue: "#81a1c1",
    brightMagenta: "#b48ead",
    brightCyan: "#8fbcbb",
    brightWhite: "#eceff4",
  },
  "solarized-dark": {
    black: "#073642",
    red: "#dc322f",
    green: "#859900",
    yellow: "#b58900",
    blue: "#268bd2",
    magenta: "#d33682",
    cyan: "#2aa198",
    white: "#eee8d5",
    // brightBlack used to equal the background (#002b36) which made dim
    // text invisible. Use base01 instead — Solarized's intended "comment"
    // color, slightly brighter than base02.
    brightBlack: "#586e75",
    brightRed: "#cb4b16",
    brightGreen: "#859900",
    brightYellow: "#b58900",
    brightBlue: "#268bd2",
    brightMagenta: "#6c71c4",
    brightCyan: "#2aa198",
    brightWhite: "#fdf6e3",
  },
  "solarized-light": {
    black: "#eee8d5",
    red: "#dc322f",
    green: "#859900",
    yellow: "#b58900",
    blue: "#268bd2",
    magenta: "#d33682",
    cyan: "#2aa198",
    white: "#eee8d5",
    // For light mode, brightBlack should still be a dim grey on a light
    // background — base1 (#93a1a1). The previous value (#fdf6e3) was the
    // background itself, hiding all dim text.
    brightBlack: "#93a1a1",
    brightRed: "#cb4b16",
    brightGreen: "#859900",
    brightYellow: "#b58900",
    brightBlue: "#268bd2",
    brightMagenta: "#6c71c4",
    brightCyan: "#2aa198",
    brightWhite: "#fdf6e3",
  },
  "github-dark": {
    black: "#484f58",
    red: "#ff7b72",
    green: "#3fb950",
    yellow: "#d29922",
    blue: "#58a6ff",
    magenta: "#bc8cff",
    // GitHub's primer palette has no dedicated "cyan" — previously this
    // was set to a green hex which collided with `green`/`brightGreen`
    // and made cyan-output invisible on green backgrounds.
    cyan: "#76e3ea",
    white: "#b1bac4",
    brightBlack: "#6e7681",
    brightRed: "#ffa198",
    brightGreen: "#56d364",
    brightYellow: "#e3b341",
    brightBlue: "#79c0ff",
    brightMagenta: "#d2a8ff",
    brightCyan: "#a5f3fc",
    brightWhite: "#f0f6fc",
  },
  "github-light": {
    black: "#24292f",
    red: "#cf222e",
    green: "#116329",
    yellow: "#9a6700",
    blue: "#0969da",
    magenta: "#8250df",
    cyan: "#1b7c83",
    white: "#6e7781",
    brightBlack: "#57606a",
    brightRed: "#a40e26",
    brightGreen: "#1a7f37",
    // Was #633c01 (almost-black brown) which is unreadable as "yellow".
    brightYellow: "#bf8700",
    brightBlue: "#218bff",
    brightMagenta: "#a475f9",
    brightCyan: "#3192aa",
    // brightWhite must be lighter than `white` — was darker, swapping
    // visual weight on bold text.
    brightWhite: "#d0d7de",
  },
};

const themeMapping: Record<string, string> = {
  "default-dark": "one-dark",
  "default-light": "one-light",
  "catppuccin": "catppuccin-mocha",
  "dracula": "dracula",
  "nord": "nord",
  "solarized-dark": "solarized-dark",
  "solarized-light": "solarized-light",
  "github-dark": "github-dark",
  "github-light": "github-light",
};

const terminalThemePresets = {
  "one-dark": {
    label: "One Dark",
    background: "#1e2127",
    foreground: "#abb2bf",
    cursor: "#61afef",
    selectionBackground: "#61afef33",
  },
  "one-light": {
    label: "One Light",
    background: "#fafafa",
    foreground: "#383a42",
    cursor: "#4078f2",
    selectionBackground: "#4078f233",
  },
  "catppuccin-mocha": {
    label: "Catppuccin Mocha",
    background: "#1e1e2e",
    foreground: "#cdd6f4",
    cursor: "#89b4fa",
    selectionBackground: "#89b4fa33",
  },
  "dracula": {
    label: "Dracula",
    background: "#282a36",
    foreground: "#f8f8f2",
    cursor: "#ff79c6",
    selectionBackground: "#ff79c633",
  },
  "nord": {
    label: "Nord",
    background: "#2e3440",
    foreground: "#e5e9f0",
    cursor: "#88c0d0",
    selectionBackground: "#88c0d033",
  },
  "solarized-dark": {
    label: "Solarized Dark",
    background: "#002b36",
    foreground: "#93a1a1",
    cursor: "#268bd2",
    selectionBackground: "#268bd233",
  },
  "solarized-light": {
    label: "Solarized Light",
    background: "#fdf6e3",
    foreground: "#657b83",
    cursor: "#268bd2",
    selectionBackground: "#268bd233",
  },
  "github-dark": {
    label: "GitHub Dark",
    background: "#0d1117",
    foreground: "#c9d1d9",
    cursor: "#58a6ff",
    selectionBackground: "#58a6ff33",
  },
  "github-light": {
    label: "GitHub Light",
    background: "#ffffff",
    foreground: "#24292f",
    cursor: "#0969da",
    selectionBackground: "#0969da33",
  },
} satisfies Record<
  Exclude<import("@/stores/terminal-settings").TerminalThemeId, "system">,
  {
    label: string;
    background: string;
    foreground: string;
    cursor: string;
    selectionBackground: string;
  }
>;

export const TERMINAL_THEME_OPTIONS: TerminalThemeOption[] = [
  { id: "system", label: "Match OS" },
  ...Object.entries(terminalThemePresets).map(([id, preset]) => ({
    id: id as Exclude<import("@/stores/terminal-settings").TerminalThemeId, "system">,
    label: preset.label,
  })),
];

function inferMode(bg: string): "light" | "dark" {
  const hex = bg.replace("#", "");
  if (hex.length < 6) return "dark";
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance < 0.5 ? "dark" : "light";
}

export function getAnsiPalette(themeSlug: string, backgroundHex: string): AnsiPalette {
  const paletteName = themeMapping[themeSlug];
  if (paletteName && palettes[paletteName]) {
    return palettes[paletteName];
  }
  const mode = inferMode(backgroundHex);
  return mode === "dark" ? palettes["one-dark"]! : palettes["one-light"]!;
}

export function getTerminalThemePreset(
  themeId: Exclude<import("@/stores/terminal-settings").TerminalThemeId, "system">,
) {
  return {
    ...terminalThemePresets[themeId],
    ...palettes[themeId],
  };
}
