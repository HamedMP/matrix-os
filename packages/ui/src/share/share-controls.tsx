"use client";
/**
 * shadcn-pattern controls for the Share popover. They mirror
 * shell/src/components/ui (Button, Input, Textarea, Tabs, Collapsible) but live
 * in packages/ui so Web and Electron render one implementation; the shell copies
 * depend on the `@/` alias, which Electron cannot resolve.
 */
import type { ComponentProps } from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import * as CollapsiblePrimitive from "@radix-ui/react-collapsible";
import { cn } from "./share-cn";

type ButtonVariant = "primary" | "outline" | "ghost" | "link";
type ButtonSize = "sm" | "md" | "icon";
const BUTTON_BASE = "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium transition-colors disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg]:shrink-0";
const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-[var(--share-primary)] text-[var(--share-primary-fg)] font-semibold hover:opacity-90 disabled:bg-[var(--share-muted)] disabled:text-[var(--share-subtle-fg)] disabled:opacity-100",
  outline: "border border-[var(--share-border)] bg-[var(--share-bg)] text-[var(--share-fg)] shadow-xs hover:bg-[var(--share-muted)] disabled:opacity-50",
  ghost: "bg-transparent text-[var(--share-subtle-fg)] hover:bg-[var(--share-muted)] hover:text-[var(--share-fg)] disabled:opacity-50",
  link: "h-7 bg-transparent px-1 text-xs font-normal text-[var(--share-subtle-fg)] underline underline-offset-2 hover:text-[var(--share-fg)] disabled:opacity-50",
};
const BUTTON_SIZE: Record<ButtonSize, string> = {
  sm: "h-8 px-2.5 text-xs",
  md: "h-10 px-3.5 text-[13px]",
  icon: "size-7 rounded-md p-0",
};

export function ShareButton({ variant = "outline", size = "md", className, type = "button", ...props }: ComponentProps<"button"> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button type={type} data-slot="button" className={cn(BUTTON_BASE, BUTTON_VARIANT[variant], variant === "link" ? "" : BUTTON_SIZE[size], className)} {...props} />;
}

export function ShareInput({ className, ...props }: ComponentProps<"input">) {
  return <input data-slot="input" className={cn("h-10 w-full min-w-0 rounded-lg border border-[var(--share-input)] bg-[var(--share-bg)] px-3 text-[13px] text-[var(--share-fg)] outline-none placeholder:text-[var(--share-subtle-fg)] disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-[var(--share-danger-border)]", className)} {...props} />;
}

export function ShareTextarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea data-slot="textarea" className={cn("w-full resize-none rounded-lg border border-[var(--share-input)] bg-[var(--share-bg)] px-3 py-2 text-[13px] leading-[18px] text-[var(--share-fg)] outline-none placeholder:text-[var(--share-subtle-fg)]", className)} {...props} />;
}

export const ShareTabs = TabsPrimitive.Root;
export function ShareTabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List data-slot="tabs-list" className={cn("flex gap-0.5 rounded-[11px] bg-[var(--share-muted)] p-[3px]", className)} {...props} />;
}
export function ShareTabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return <TabsPrimitive.Trigger data-slot="tabs-trigger" className={cn("flex h-9 min-w-0 flex-auto items-center justify-center gap-1.5 rounded-lg px-1.5 text-[13px] font-medium whitespace-nowrap [&_svg]:shrink-0 text-[var(--share-muted-fg)] data-[state=active]:bg-[var(--share-bg)] data-[state=active]:text-[var(--share-fg)] data-[state=active]:shadow-[0_1px_2px_rgba(24,24,27,0.10),0_0_0_1px_rgba(24,24,27,0.05)]", className)} {...props} />;
}
export const ShareTabsContent = TabsPrimitive.Content;

export const ShareCollapsible = CollapsiblePrimitive.Root;
export const ShareCollapsibleTrigger = CollapsiblePrimitive.Trigger;
export const ShareCollapsibleContent = CollapsiblePrimitive.Content;

export function OnDot({ label = "on" }: { label?: string }) {
  return <span role="img" aria-label={label} className="size-1.5 shrink-0 rounded-full bg-[var(--share-success)]" />;
}

export function Spinner({ className }: { className?: string }) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" className={cn("size-3.5 matrix-share-spin", className)}><circle cx="12" cy="12" r="8" strokeOpacity="0.25" /><path d="M20 12a8 8 0 0 0-8-8" /></svg>;
}

export function InlineError({ children }: { children: string }) {
  return <p role="alert" className="m-0 text-xs font-medium text-[var(--share-danger-fg)]">{children}</p>;
}
