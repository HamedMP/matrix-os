import type { CSSProperties } from "react";

/**
 * Button paints its variant with inline styles; this routes color and spacing
 * through CSS variables so shortcuts.css can drive hover and disabled states.
 */
export const quietButtonStyle: CSSProperties = {
  background: "transparent",
  color: "var(--mxs-quiet-fg)",
  padding: "4px 6px",
  fontSize: "13px",
  fontWeight: 500,
  borderRadius: "6px",
  cursor: "var(--mxs-quiet-cursor, pointer)",
};
