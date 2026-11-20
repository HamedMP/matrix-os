import type { CSSProperties } from "react";

/** Shared class and token vocabulary, matching the project conversation list and agent inbox. */
export const tone = {
  primary: { color: "var(--text-primary, var(--foreground))" } satisfies CSSProperties,
  secondary: { color: "var(--text-secondary, var(--muted-foreground))" } satisfies CSSProperties,
  muted: { color: "var(--text-tertiary, var(--muted-foreground))" } satisfies CSSProperties,
  border: { borderColor: "var(--border-subtle, var(--border))" } satisfies CSSProperties,
};

export const focusRing = "outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring,var(--accent))]";
export const chipButtonClass = `flex h-8 shrink-0 items-center whitespace-nowrap gap-1.5 rounded-lg px-2.5 text-[13px] hover:bg-[var(--bg-hover)] aria-pressed:bg-[var(--bg-hover)] aria-pressed:font-medium aria-expanded:bg-[var(--bg-hover)] ${focusRing}`;
export const primaryButtonClass = `inline-flex h-8 shrink-0 items-center whitespace-nowrap gap-1.5 rounded-[10px] bg-[var(--primary)] px-3 text-[13px] font-medium text-[var(--primary-foreground)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`;
export const secondaryButtonClass = `inline-flex h-8 shrink-0 items-center whitespace-nowrap gap-1.5 rounded-[10px] border border-[var(--border-subtle,var(--border))] px-3 text-[13px] font-medium text-[var(--text-primary,var(--foreground))] hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`;
export const menuSurfaceStyle: CSSProperties = {
  borderColor: "var(--border-default, var(--border))", background: "var(--bg-overlay, var(--popover, var(--card)))",
  color: "var(--text-primary, var(--foreground))",
};

/** Stable callback ref: focuses a field the person just opened, once on mount (an inline ref would refocus every render). */
export function focusOnMount(element: HTMLElement | null): void {
  element?.focus();
}
