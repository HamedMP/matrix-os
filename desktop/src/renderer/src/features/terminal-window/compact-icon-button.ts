import type { CSSProperties } from "react";

// The shared Button sized for the Terminal window's 28 px pane headers and tab bar. The ghost
// variant's inline transparent background is dropped so the hover class can colour it.
export const COMPACT_ICON_BUTTON: CSSProperties = {
  color: "var(--text-secondary, var(--color-muted-foreground))",
  width: 24,
  height: 24,
  padding: 0,
  justifyContent: "center",
  background: undefined,
};
export const COMPACT_ICON_BUTTON_CLASS = "outline-none hover:bg-[var(--border-subtle)] focus-visible:ring-2 focus-visible:ring-current";
