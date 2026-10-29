import { desktopPalette, productScales } from "@matrix-os/brand";
import type { CSSProperties } from "react";

/**
 * Brand accents for the Getting started app, from @matrix-os/brand. Surfaces,
 * text and borders follow the shell theme in getting-started-app.css, so the
 * app reads correctly in light and dark themes on Web and Electron.
 */
export const GETTING_STARTED_APP_BRAND_VARS = {
  "--gsa-brand-forest": desktopPalette.forest,
  "--gsa-brand-forest-deep": desktopPalette.forestDeep,
  "--gsa-brand-forest-light": productScales.teal[500],
  "--gsa-brand-gold": productScales.gold[500],
  "--gsa-brand-green": productScales.green[500],
  "--gsa-brand-teal": productScales.teal[400],
} as CSSProperties;
