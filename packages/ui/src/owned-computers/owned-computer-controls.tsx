"use client";
/**
 * shadcn-pattern controls for the owned computers panel. They live in
 * packages/ui so Web and Electron render one implementation.
 */
import type { ComponentProps } from "react";
import { cn } from "../share/share-cn";
import { useCopy } from "../share/use-copy";
import { OWNED_COMPUTER_INSTALL_COMMAND } from "./owned-computers-model";

type ButtonVariant = "primary" | "outline" | "ghost" | "destructive";
const BUTTON_BASE = "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 h-8 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--matrix-primary,var(--accent))]";
const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-[var(--matrix-primary,var(--accent))] text-[var(--matrix-primary-fg,var(--text-on-accent))] font-semibold hover:opacity-90",
  outline: "border border-[var(--matrix-border,var(--border-subtle))] bg-transparent text-[var(--matrix-fg,var(--text-primary))] hover:bg-[var(--matrix-muted,var(--bg-hover))]",
  ghost: "bg-transparent text-[var(--matrix-muted-fg,var(--text-secondary))] hover:bg-[var(--matrix-muted,var(--bg-hover))]",
  destructive: "bg-[var(--destructive,var(--danger,#c2410c))] text-white hover:opacity-90",
};

export function OwnedButton({ variant = "outline", className, type = "button", ...props }: ComponentProps<"button"> & { variant?: ButtonVariant }) {
  return <button type={type} className={cn(BUTTON_BASE, BUTTON_VARIANT[variant], className)} {...props} />;
}

export function OwnedInput({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border border-[var(--matrix-input,var(--border-subtle))] bg-transparent px-2.5 text-sm text-[var(--matrix-fg,var(--text-primary))] outline-none focus-visible:border-[var(--matrix-primary,var(--accent))]",
        className,
      )}
      {...props}
    />
  );
}

/** Mirrors the shadcn Switch (a button with role="switch"). */
export function OwnedSwitch({
  checked,
  onCheckedChange,
  label,
  disabled,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--matrix-primary,var(--accent))]",
        checked ? "bg-[var(--matrix-primary,var(--accent))]" : "bg-[var(--matrix-input,var(--border-subtle))]",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none block size-4 rounded-full bg-white shadow-sm transition-transform",
          checked ? "translate-x-4" : "translate-x-0",
        )}
      />
    </button>
  );
}

export function OwnedStatusDot({ status }: { status: "online" | "offline" | "enrolling" }) {
  const tone = status === "online" ? "bg-[#6F8E58]" : status === "enrolling" ? "bg-[#C4A265]" : "bg-[var(--matrix-muted-fg,var(--text-tertiary))] opacity-50";
  return <span aria-hidden="true" className={cn("inline-block size-2 shrink-0 rounded-full", tone)} />;
}

export function InstallCommand() {
  const copy = useCopy();
  return (
    <div className="flex w-full min-w-0 items-center gap-2 rounded-lg border border-[var(--matrix-border,var(--border-subtle))] p-2">
      <code className="min-w-0 flex-1 truncate text-xs" title={OWNED_COMPUTER_INSTALL_COMMAND}>{OWNED_COMPUTER_INSTALL_COMMAND}</code>
      <OwnedButton aria-label="Copy install command" onClick={() => copy.copy("install", OWNED_COMPUTER_INSTALL_COMMAND)}>
        {copy.label("install", "Copy")}
      </OwnedButton>
    </div>
  );
}
