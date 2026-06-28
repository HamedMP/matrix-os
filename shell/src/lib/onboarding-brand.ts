import { palette as brand } from "@matrix-os/brand";

export const MATRIX_ONBOARDING_BRAND_VERSION = "matrix-onboarding-v1";

export const matrixOnboardingPalette = {
  stone: brand.cream,
  sage: brand.forest,
  forest: brand.forest,
  ember: brand.ember,
  ink: brand.deep,
  lichen: brand.cream,
  pebble: brand.card,
} as const;

export const matrixOnboardingMotion = {
  fastMs: 140,
  baseMs: 220,
  deliberateMs: 420,
  easing: "cubic-bezier(0.22, 1, 0.36, 1)",
  reducedMotionDurationMs: 1,
} as const;

export const matrixOnboardingTypography = {
  brand: "var(--font-sans)",
  body: "var(--font-sans)",
  technical: "var(--font-mono)",
} as const;
