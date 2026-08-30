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

type TerminalThemeId = import("@/stores/terminal-settings").TerminalThemeId;
type Theme = import("@/hooks/useTheme").Theme;
type XtermTheme = {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
} & AnsiPalette;

const palettes: Record<string, AnsiPalette> = {
  "matrix-shell-dark": {
    black: "#0C0C0C",
    red: "#D85E5E",
    green: "#0AD18B",
    yellow: "#C9A24A",
    blue: "#6AA0FF",
    magenta: "#B58CFF",
    cyan: "#00E5C0",
    white: "#BFBFBF",
    brightBlack: "#5B5B5B",
    brightRed: "#F06A6A",
    brightGreen: "#7FE0A0",
    brightYellow: "#E0A12E",
    brightBlue: "#8CB8FF",
    brightMagenta: "#CFAAFF",
    brightCyan: "#74F7E0",
    brightWhite: "#F0EFE5",
  },
  "matrix-shell-light": {
    // Gruvbox dark0. ANSI color 0 is an explicit foreground and must not reuse
    // the Paper light background, otherwise SGR 30 and palette index 0 vanish.
    black: "#282828",
    red: "#CC241D",
    green: "#79740E",
    yellow: "#B57614",
    blue: "#458588",
    magenta: "#B16286",
    cyan: "#689D6A",
    white: "#3C3836",
    brightBlack: "#A89984",
    brightRed: "#9D0006",
    brightGreen: "#79740E",
    brightYellow: "#AF3A03",
    brightBlue: "#076678",
    brightMagenta: "#8F3F71",
    brightCyan: "#427B58",
    brightWhite: "#282828",
  },
  "matrix-shell-neon": {
    black: "#020A02",
    red: "#2FBF55",
    green: "#2FBF55",
    yellow: "#5BF08A",
    blue: "#1FB04E",
    magenta: "#39FF6A",
    cyan: "#39FF6A",
    white: "#2FBF55",
    brightBlack: "#176B30",
    brightRed: "#5BF08A",
    brightGreen: "#39FF6A",
    brightYellow: "#9BFF8F",
    brightBlue: "#5BF08A",
    brightMagenta: "#8DFFAA",
    brightCyan: "#B3FFC6",
    brightWhite: "#D8FFD9",
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
  "dark": {
    label: "Matrix OS Dark",
    background: "#0C0C0C",
    foreground: "#BFBFBF",
    cursor: "#0AD18B",
    selectionBackground: "#00E5C033",
  },
  "light": {
    label: "Light",
    background: "#FBF1C7",
    foreground: "#3C3836",
    cursor: "#79740E",
    selectionBackground: "#79740E33",
  },
  "matrix": {
    label: "Matrix",
    background: "#020A02",
    foreground: "#2FBF55",
    cursor: "#39FF6A",
    selectionBackground: "#39FF6A33",
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
  Exclude<TerminalThemeId, "system">,
  {
    label: string;
    background: string;
    foreground: string;
    cursor: string;
    selectionBackground: string;
  }
>;

export const TERMINAL_THEME_OPTIONS: TerminalThemeOption[] = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Matrix OS Dark" },
  { id: "matrix", label: "Matrix" },
  { id: "powerlevel10k-lean", label: "P10k Lean" },
  { id: "powerlevel10k-lean-8-colors", label: "P10k Lean · 8 colors" },
  { id: "powerlevel10k-classic", label: "P10k Classic" },
  { id: "powerlevel10k-rainbow", label: "P10k Rainbow" },
  { id: "powerlevel10k-pure", label: "P10k Pure" },
];

function inferMode(bg: string): "light" | "dark" {
  const rgbMatch = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/.exec(bg.trim());
  if (rgbMatch) {
    const r = Number(rgbMatch[1]);
    const g = Number(rgbMatch[2]);
    const b = Number(rgbMatch[3]);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance < 0.5 ? "dark" : "light";
  }
  const hex = bg.replace("#", "");
  if (hex.length < 6) return "dark";
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance < 0.5 ? "dark" : "light";
}

export const TERMINAL_MINIMUM_CONTRAST_RATIO = 4.5;
const XTERM_DEFAULT_MINIMUM_CONTRAST_RATIO = 1;

/**
 * Keep contrast enforcement terminal-local and bounded to light backgrounds.
 * xterm applies this option in its normal renderer and the WebGL addon.
 */
export function getTerminalMinimumContrastRatio(
  theme: Pick<XtermTheme, "background">,
): number {
  return inferMode(theme.background) === "light"
    ? TERMINAL_MINIMUM_CONTRAST_RATIO
    : XTERM_DEFAULT_MINIMUM_CONTRAST_RATIO;
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
  themeId: Exclude<TerminalThemeId, "system">,
) {
  const mappedThemeId =
    themeId.startsWith("powerlevel10k-")
      ? themeId
      : themeId === "one-light" || themeId === "solarized-light" || themeId === "github-light"
      ? "light"
      : themeId === "matrix"
        ? "matrix"
        : themeId === "dark" || themeId === "light"
          ? themeId
          : "dark";
  const shellPalette = mappedThemeId === "light"
    ? palettes["matrix-shell-light"]
    : mappedThemeId === "matrix"
      ? palettes["matrix-shell-neon"]
      : mappedThemeId.startsWith("powerlevel10k-")
        ? palettes[mappedThemeId]
        : palettes["matrix-shell-dark"];
  return {
    ...terminalThemePresets[mappedThemeId],
    ...shellPalette,
  };
}

export function buildXtermTheme(theme: Theme, terminalThemeId: TerminalThemeId): XtermTheme {
  if (terminalThemeId !== "system") {
    return getTerminalThemePreset(terminalThemeId);
  }

  const background = theme.colors.background || "#1a1a2e";
  const foreground = theme.colors.foreground || "#e0e0e0";
  const cursor = theme.colors.primary || "#c2703a";
  const slug = (theme as { slug?: string }).slug ?? "";
  const ansi = getAnsiPalette(slug, background);
  const selectionBackground = `${cursor}44`;

  return {
    background,
    foreground,
    cursor,
    selectionBackground,
    ...ansi,
  };
}
