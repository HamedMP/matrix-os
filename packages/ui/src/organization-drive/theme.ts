import type { CSSProperties } from "react";
/** Use the host Web/Electron theme while sharing the Library's presentation CSS. */
export const driveWorkspaceStyle = {
  "--mw-paper": "var(--background)",
  "--mw-canvas": "var(--muted, var(--bg-sunken))",
  "--mw-ink": "var(--foreground)",
  "--mw-muted": "var(--muted-foreground, var(--text-secondary))",
  "--mw-primary": "var(--primary, var(--accent))",
  "--mw-green": "var(--accent)",
  "--mw-gold": "var(--accent)",
  "--mw-border": "var(--border, var(--border-default))",
  "--mw-danger": "var(--destructive, var(--text-danger))",
  "--mw-blue": "var(--primary, var(--accent))",
  color: "var(--foreground)",
  backgroundColor: "var(--background)",
  fontFamily: "inherit",
} as CSSProperties;
