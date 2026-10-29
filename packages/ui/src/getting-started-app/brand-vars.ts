import { desktopFonts, desktopPalette, productScales } from "@matrix-os/brand";
import type { CSSProperties } from "react";


/**
 * Brand values for the Getting started app, from @matrix-os/brand (Matrix DS
 * tints, Figma 1938:645). Surfaces, text and borders follow the shell theme in
 * getting-started-app.css; dark themes re-derive the tints there.
 */
export const GETTING_STARTED_APP_BRAND_VARS = {
  "--gsa-font-ui": `var(--font-geist-sans, ${desktopFonts.sans})`,
  "--gsa-font-display": `var(--font-bricolage, ${desktopFonts.display})`,
  "--gsa-brand-forest": desktopPalette.forest,
  "--gsa-brand-forest-deep": desktopPalette.forestDeep,
  "--gsa-brand-glow": productScales.teal[400],
  "--gsa-brand-glow-soft": productScales.green[300],
  "--gsa-brand-fill": productScales.green[500],
  "--gsa-brand-gold": productScales.gold[500],
  /** Text and marks on the forest and ink panels. */
  "--gsa-on-brand": productScales.neutral[25],
  "--gsa-ink": productScales.neutral[800],
  "--gsa-brand-green": productScales.green[500],
  "--gsa-brand-teal": productScales.teal[400],
  "--gsa-tint-gold-bg": productScales.gold[50],
  "--gsa-tint-gold-border": productScales.gold[200],
  "--gsa-tint-gold-text": productScales.gold[700],
  "--gsa-tint-brand-bg": productScales.green[50],
  "--gsa-tint-brand-border": productScales.green[200],
  "--gsa-tint-brand-text": productScales.green[800],
  "--gsa-tint-success-bg": productScales.teal[50],
  "--gsa-tint-success-border": productScales.teal[100],
  "--gsa-tint-success-text": productScales.teal[700],
  "--gsa-tint-gold-bg-dark": productScales.gold[900],
  "--gsa-tint-gold-border-dark": productScales.gold[800],
  "--gsa-tint-gold-text-dark": productScales.gold[300],
  "--gsa-tint-brand-bg-dark": productScales.green[900],
  "--gsa-tint-brand-border-dark": productScales.green[800],
  "--gsa-tint-brand-text-dark": productScales.green[300],
  "--gsa-tint-success-bg-dark": productScales.teal[900],
  "--gsa-tint-success-border-dark": productScales.teal[800],
  "--gsa-tint-success-text-dark": productScales.teal[300],
} as CSSProperties;
