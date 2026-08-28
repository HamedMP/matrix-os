export const palette = {
  forest: "#434E3F",
  forestDeep: "#2E3A2A",
  deep: "#32352E",
  cream: "#E0E1CA",
  ember: "#D06F25",
  pageBg: "#EEEEE2",
  card: "#FCFCF8",
  border: "#DCD9CC",
  mutedFg: "#5C5A4F",
  subtle: "#7A7768",
  brandInk: "#1F2D1D",
  brandTeal: "#0E3522",
  brandGold: "#F1C379",
  brandCoral: "#D06E53",
  brandMuted: "#7A786B",
} as const;

export const fonts = {
  display: "var(--font-serif-display), 'Instrument Serif', Georgia, serif",
  sans: "var(--font-instrument), 'Instrument Sans', system-ui, sans-serif",
  heading: "var(--font-bricolage), 'Bricolage Grotesque', sans-serif",
  ui: "var(--font-geist-sans), Geist, system-ui, sans-serif",
  machine: "var(--font-geist-mono), 'Geist Mono', monospace",
} as const;

/** Desktop and device-onboarding palette from the current Matrix product brand. */
export const desktopPalette = {
  forest: "#0E3422",
  forestDeep: "#092417",
  stageStart: "#16472F",
  forestHover: "#174D34",
  coral: "#D06E53",
  gold: "#F1C379",
  green: "#BED77B",
  blue: "#C5D6E2",
  paper: "#FCFCF8",
  canvas: "#F1F4E8",
  surfaceMuted: "#F7F8F1",
  textMuted: "#536259",
  danger: "#9F3F2C",
} as const;

export const desktopFonts = {
  display: '"Bricolage Grotesque", Geist, ui-sans-serif, system-ui, sans-serif',
  sans: 'Geist, ui-sans-serif, system-ui, sans-serif',
  mono: '"Geist Mono", ui-monospace, "SFMono-Regular", Consolas, monospace',
} as const;

export const cardShadow = "0 0 7.5rem 0 rgba(50, 53, 46, 0.09)";
export const cardShadowSmall = "0 0 3rem 0 rgba(50, 53, 46, 0.07)";

export const radii = { control: "0.625rem", card: "12px", pill: "999px" } as const;

export const typeScale = {
  display: "clamp(2.5rem, 6vw, 4.4rem)",
  h1: "2rem",
  h2: "1.5rem",
  body: "1rem",
  caption: "0.8125rem",
} as const;

// Status tones for StatusPill — forest/ember tints with semantic foregrounds.
export const statusTones = {
  connected: { bg: "rgba(67, 78, 63, 0.08)", fg: "#3B6D11" },
  ready: { bg: "rgba(67, 78, 63, 0.08)", fg: "#3B6D11" },
  pending: { bg: "rgba(208, 111, 37, 0.10)", fg: "#993C1D" },
} as const;

// On-dark foreground (cream text on the deep CTA / light SectionTitle).
export const lightFg = "#FAFAF5";
// Translucent card surface for the outline CTA.
export const cardTranslucent = "rgba(252, 252, 248, 0.7)";
