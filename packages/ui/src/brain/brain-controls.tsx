"use client";

import type { ButtonHTMLAttributes, InputHTMLAttributes, Ref, SelectHTMLAttributes } from "react";
import { BRAIN_TONE, BRAIN_TYPE } from "./brain-tone.js";

export type BrainButtonVariant = "primary" | "outline" | "ghost" | "secondary" | "link" | "destructive";
export type BrainButtonSize = "sm" | "default";

/** DESIGN.md buttons: 44 px high, 10 px corners, Geist Medium 14/20, no shadow. */
const BUTTON_BASE = `inline-flex shrink-0 items-center justify-center gap-1.5 rounded-[10px] font-medium ${BRAIN_TYPE.label} `
  + `${BRAIN_TONE.motion} disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0`;

/** Filled, outline, secondary and text-only; destructive is text in Coral 500, never a fill. `ghost` is text-only. */
const BUTTON_VARIANTS: Readonly<Record<BrainButtonVariant, string>> = {
  primary: "bg-[var(--brain-primary)] text-[var(--brain-on-primary)] hover:opacity-90",
  outline: "border border-[var(--brain-outline-border)] bg-[var(--brain-outline)] text-[var(--brain-on-control)] hover:bg-[var(--brain-fill)]",
  ghost: `bg-transparent text-[var(--brain-on-control)] ${BRAIN_TONE.hover}`,
  secondary: "bg-[var(--brain-secondary)] text-[var(--brain-on-secondary)] hover:opacity-90",
  link: `bg-transparent text-[var(--brain-on-control)] underline underline-offset-2 hover:opacity-80 ${BRAIN_TONE.hit}`,
  destructive: `bg-transparent text-[var(--brain-danger)] ${BRAIN_TONE.hover}`,
};

/** One line by default; `wrap` lets a long label (a person's name and key) grow in height instead. */
const BUTTON_SIZES: Readonly<Record<BrainButtonSize, { readonly line: string; readonly wrap: string }>> = {
  sm: { line: "h-11 whitespace-nowrap px-3", wrap: "h-auto min-h-11 whitespace-normal px-3 py-3" },
  default: { line: "h-11 whitespace-nowrap px-4", wrap: "h-auto min-h-11 whitespace-normal px-4 py-3" },
};
/** A link inside a line of text keeps the line's height; its touch area is still 44 px tall. */
const LINK_SIZE = "align-baseline";

export interface BrainButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: BrainButtonVariant;
  readonly size?: BrainButtonSize;
  readonly wrap?: boolean;
  readonly ref?: Ref<HTMLButtonElement>;
}

export function BrainButton({
  variant = "primary", size = "default", wrap = false, className, type = "button", ...props
}: BrainButtonProps) {
  const sizing = variant === "link" ? LINK_SIZE : wrap ? BUTTON_SIZES[size].wrap : BUTTON_SIZES[size].line;
  return (
    <button
      type={type}
      className={[BUTTON_BASE, BRAIN_TONE.focus, sizing, BUTTON_VARIANTS[variant], className].filter(Boolean).join(" ")}
      {...props}
    />
  );
}

/** A full-radius choice in a group of them: Today or This week, Decisions, Commitments or Risks. */
export function BrainChip({ selected, className, ...props }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> & {
  readonly selected: boolean;
}) {
  const tone = selected ? "bg-[var(--brain-chip-selected)] text-[var(--brain-on-chip-selected)]"
    : "bg-[var(--brain-chip)] text-[var(--brain-text)] hover:opacity-80";
  return (
    <button type="button" aria-pressed={selected}
      className={[`inline-flex h-9 shrink-0 items-center rounded-full px-3 font-medium ${BRAIN_TYPE.caption}`,
        BRAIN_TONE.hit, BRAIN_TONE.motion, BRAIN_TONE.focus, "disabled:pointer-events-none disabled:opacity-50", tone,
        className].filter(Boolean).join(" ")}
      {...props} />
  );
}

/** DESIGN.md fields: the fill, 14 px corners, Geist 15/22, and a 1.5 px primary-text border while focused. */
const FIELD = `h-11 rounded-[14px] border-[1.5px] border-transparent bg-[var(--brain-fill)] px-3.5 font-normal ${BRAIN_TYPE.callout} `
  + `text-[var(--brain-text)] outline-none placeholder:text-[var(--brain-text-tertiary)] focus:border-[var(--brain-text)] `
  + `aria-invalid:border-[var(--brain-danger)] disabled:opacity-50 ${BRAIN_TONE.motion}`;

/** A text field; every native prop passes through (`type`, `maxLength`, `aria-invalid`, `ref`...). */
export function BrainInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement> & {
  readonly ref?: Ref<HTMLInputElement>;
}) {
  return <input className={[FIELD, "w-full min-w-0", className].filter(Boolean).join(" ")} {...props} />;
}

export function BrainSelect({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={[FIELD, "pr-2.5", className].filter(Boolean).join(" ")} {...props} />;
}

/** A native checkbox or radio in the primary color, with the gold focus ring; its label row is 44 px tall. */
export const BRAIN_CHECK = `size-4 shrink-0 accent-[var(--brain-primary)] ${BRAIN_TONE.focus}`;
export const BRAIN_CHECK_ROW = `flex min-h-11 items-center gap-2 ${BRAIN_TYPE.label}`;
