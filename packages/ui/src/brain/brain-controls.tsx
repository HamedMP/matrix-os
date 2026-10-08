"use client";

import type { ButtonHTMLAttributes, InputHTMLAttributes, Ref, SelectHTMLAttributes } from "react";
import { BRAIN_TONE } from "./brain-tone.js";

export type BrainButtonVariant = "primary" | "outline" | "ghost" | "secondary" | "link" | "destructive";
export type BrainButtonSize = "sm" | "default";

const BUTTON_BASE = "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium transition-colors "
  + "disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0";

const BUTTON_VARIANTS: Readonly<Record<BrainButtonVariant, string>> = {
  primary: "bg-[var(--primary,var(--accent))] text-[var(--primary-foreground,var(--text-on-accent))] hover:brightness-105",
  outline: "border border-[var(--border-default,var(--border))] bg-transparent text-foreground hover:bg-[var(--bg-hover,var(--muted))]",
  ghost: "bg-transparent text-muted-foreground hover:bg-[var(--bg-hover,var(--muted))] hover:text-foreground",
  secondary: "bg-[var(--bg-selected,var(--muted))] text-foreground",
  link: "bg-transparent text-foreground underline-offset-2 hover:underline",
  destructive: "bg-[var(--danger-muted,color-mix(in_srgb,var(--destructive)_12%,transparent))] text-destructive hover:brightness-105",
};

/** One line by default; `wrap` lets a long label (a person's name and key) grow in height instead. */
const BUTTON_SIZES: Readonly<Record<BrainButtonSize, { readonly line: string; readonly wrap: string }>> = {
  sm: { line: "h-8 whitespace-nowrap px-3 text-xs", wrap: "h-auto min-h-8 whitespace-normal px-3 py-1 text-xs" },
  default: { line: "h-9 whitespace-nowrap px-4 text-sm", wrap: "h-auto min-h-9 whitespace-normal px-4 py-1.5 text-sm" },
};
const LINK_SIZES: Readonly<Record<BrainButtonSize, string>> = { sm: "text-xs", default: "text-sm" };

export interface BrainButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: BrainButtonVariant;
  readonly size?: BrainButtonSize;
  readonly wrap?: boolean;
  readonly ref?: Ref<HTMLButtonElement>;
}

/** The view's button, after the Electron Desktop primitives: medium weight, rounded, token colors. */
export function BrainButton({
  variant = "primary", size = "default", wrap = false, className, type = "button", ...props
}: BrainButtonProps) {
  const sizing = variant === "link" ? LINK_SIZES[size] : wrap ? BUTTON_SIZES[size].wrap : BUTTON_SIZES[size].line;
  return (
    <button
      type={type}
      className={[BUTTON_BASE, BRAIN_TONE.focus, sizing, BUTTON_VARIANTS[variant], className].filter(Boolean).join(" ")}
      {...props}
    />
  );
}

const FIELD = "h-9 rounded-md border px-2 text-sm placeholder:text-muted-foreground aria-invalid:border-destructive "
  + "disabled:opacity-50";

/** A text field; every native prop passes through (`type`, `maxLength`, `aria-invalid`, `ref`...). */
export function BrainInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement> & {
  readonly ref?: Ref<HTMLInputElement>;
}) {
  return (
    <input className={[FIELD, "w-full min-w-0", BRAIN_TONE.field, BRAIN_TONE.focus, className].filter(Boolean).join(" ")}
      {...props} />
  );
}

export function BrainSelect({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={[FIELD, BRAIN_TONE.field, BRAIN_TONE.focus, className].filter(Boolean).join(" ")} {...props} />;
}
