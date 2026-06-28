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
