/**
 * Chat Agents render in Web, Electron, and standalone brand hosts. Keep the
 * semantic-token order here so a missing host-specific token cannot invalidate
 * the whole CSS declaration.
 */
export const chatAgentSurfaceStyle = {
  background: "var(--bg-surface, var(--matrix-card, var(--card)))",
  color: "var(--text-primary, var(--matrix-card-fg, var(--foreground)))",
  border: "1px solid var(--border-default, var(--matrix-border, var(--border)))",
} as const;

export const chatAgentMutedStyle = {
  color: "var(--text-secondary, var(--matrix-muted-fg, var(--muted-foreground)))",
} as const;

// Web's --accent is a secondary surface. Prefer its --ring while Electron
// keeps its established --accent focus color.
export const chatAgentButtonClass = "rounded-lg border px-3 py-2 text-sm outline-none hover:enabled:bg-[var(--bg-hover,var(--matrix-secondary,var(--secondary)))] focus-visible:ring-2 focus-visible:ring-[var(--ring,var(--accent,var(--matrix-accent,var(--matrix-ring))))] disabled:opacity-50";
export const chatAgentInputClass = "w-full min-w-0 rounded-lg border bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring,var(--accent,var(--matrix-accent,var(--matrix-ring))))]";
export const chatAgentLauncherClass = "flex min-h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-sm outline-none hover:bg-[var(--bg-hover,var(--matrix-secondary,var(--secondary)))] focus-visible:ring-2 focus-visible:ring-[var(--ring,var(--accent,var(--matrix-accent,var(--matrix-ring))))]";
