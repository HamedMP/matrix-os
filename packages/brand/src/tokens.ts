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
} as const;

export const fonts = {
  display: "var(--font-serif-display), 'Instrument Serif', Georgia, serif",
  sans: "var(--font-instrument), 'Instrument Sans', system-ui, sans-serif",
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
