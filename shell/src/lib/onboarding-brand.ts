export const MATRIX_ONBOARDING_BRAND_VERSION = "matrix-onboarding-v1";

export const matrixOnboardingPalette = {
  stone: "#e7e0d4",
  sage: "#9aa889",
  forest: "#17281f",
  ember: "#d6653b",
  ink: "#111612",
  lichen: "#c9d2bd",
  pebble: "#f4f0e8",
} as const;

export const matrixOnboardingMotion = {
  fastMs: 140,
  baseMs: 220,
  deliberateMs: 420,
  easing: "cubic-bezier(0.22, 1, 0.36, 1)",
  reducedMotionDurationMs: 1,
} as const;

export const matrixOnboardingTypography = {
  brand: "Orbitron, var(--font-sans)",
  body: "var(--font-sans)",
  technical: "var(--font-mono)",
} as const;
