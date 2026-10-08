/**
 * Color classes of the Company Brain view. Each chains the Electron Desktop token first and the Web token second, so
 * one class reads right on both renderers; no `dark:` variants (the theme switches the tokens). Every class is a
 * literal here, so the Tailwind source scan of this folder sees it.
 */
export const BRAIN_TONE = {
  border: "border-[var(--border-default,var(--border))]",
  hover: "hover:bg-[var(--bg-hover,var(--muted))]",
  selected: "aria-selected:bg-[var(--bg-selected,var(--muted))] aria-selected:text-foreground",
  /**
   * `outline-none` also sets Tailwind's outline style variable to none, so the focus ring sets the style back with
   * `focus-visible:outline-solid`. Electron Desktop draws its own global focus ring instead.
   */
  focus:
    "outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring,var(--accent))]",
  /** The window surface: Electron Desktop paints app windows with --bg-surface. */
  surface: "bg-[var(--bg-surface,var(--background))] text-foreground",
  field: "border-[var(--border-default,var(--border))] bg-[var(--bg-surface,var(--background))] text-foreground",
  /** A quiet box: the brief summary and the model confirm. */
  panel: "bg-[var(--bg-hover,var(--muted))]",
  warn: "border-[color-mix(in_srgb,var(--warning)_45%,transparent)] bg-[var(--warning-muted,color-mix(in_srgb,var(--warning)_14%,transparent))] text-foreground",
  warnText: "text-warning",
  badgeWarn: "border-[color-mix(in_srgb,var(--warning)_45%,transparent)] text-warning",
  badgeGood: "border-[color-mix(in_srgb,var(--success)_45%,transparent)] text-success",
  mark: "bg-[var(--warning-muted,color-mix(in_srgb,var(--warning)_25%,transparent))]",
  accentText: "text-[var(--primary,var(--accent))]",
} as const;
