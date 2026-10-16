/** The room each Apps tile gives its artwork, so the names line up across a row. */
export const APP_ARTWORK_FOOTPRINT = 68;

/**
 * The shape of an app icon: a squircle, with continuous corners at about a
 * fifth of its side as on iOS. Android draws the same radius as a plain arc.
 */
export const APP_ICON_SQUIRCLE = {
  width: 64,
  height: 64,
  borderRadius: 14,
  borderCurve: "continuous",
} as const;
