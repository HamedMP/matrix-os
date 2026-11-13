/**
 * Theme tokens for the MCP settings surfaces. Each value prefers the Electron
 * Desktop token, then the Web shell (shadcn) token, so one shared component
 * reads correctly in Web Canvas, Web Desktop, and Electron Desktop.
 */
export const mcpTokens = {
  surface: "var(--bg-surface, var(--card))",
  sunken: "var(--bg-sunken, var(--muted))",
  hover: "var(--bg-hover, var(--muted))",
  border: "var(--border-subtle, var(--border))",
  borderStrong: "var(--border-default, var(--border))",
  text: "var(--text-primary, var(--foreground))",
  secondary: "var(--text-secondary, var(--muted-foreground))",
  muted: "var(--text-tertiary, var(--muted-foreground))",
  accent: "var(--matrix-accent, #D06F25)",
  /** Primary action fill: shadcn --primary in Web, --accent (#242323) in Electron Desktop. */
  primary: "var(--primary, var(--accent, #242323))",
  primaryFg: "var(--primary-foreground, var(--text-on-accent, #FAFAFA))",
  success: "var(--success, var(--matrix-success, #3A7D44))",
  warning: "var(--warning, var(--matrix-warning, #E0A12E))",
  danger: "var(--danger, var(--destructive, var(--matrix-destructive, #D74A3A)))",
  mono: "var(--matrix-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
} as const;

export type McpStatusTone = "success" | "warning" | "danger" | "neutral";

/** Maps a saved MCP server status to a short label and tone (shared by catalog and inventory). */
export function mcpStatusPresentation(status: string): { label: string; tone: McpStatusTone } {
  switch (status) {
    case "ready": return { label: "Connected", tone: "success" };
    case "auth_required": return { label: "Sign-in required", tone: "warning" };
    case "action_required": return { label: "Action required", tone: "warning" };
    case "degraded": return { label: "Degraded", tone: "danger" };
    case "disabled": return { label: "Disabled", tone: "neutral" };
    case "pending": return { label: "Pending", tone: "neutral" };
    default: return { label: "Needs attention", tone: "warning" };
  }
}

export function toneColor(tone: McpStatusTone): string {
  return tone === "success" ? mcpTokens.success : tone === "warning" ? mcpTokens.warning : tone === "danger" ? mcpTokens.danger : mcpTokens.muted;
}
