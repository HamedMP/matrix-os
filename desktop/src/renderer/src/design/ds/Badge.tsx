import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { dsCn as cn } from "./cn";

// Design-library Badge: a tinted, informational label (never a button).
export const badgeVariants = cva(
  "group/badge inline-flex w-fit shrink-0 items-center justify-center gap-1.5 rounded-sm border px-1.5 font-ds-sans font-medium whitespace-nowrap [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        neutral: "border-ds-tint-neutral-border bg-ds-tint-neutral-fill text-ds-tint-neutral-text",
        success: "border-ds-tint-success-border bg-ds-tint-success-fill text-ds-tint-success-text",
        warning: "border-ds-tint-warning-border bg-ds-tint-warning-fill text-ds-tint-warning-text",
        destructive: "border-ds-tint-destructive-border bg-ds-tint-destructive-fill text-ds-tint-destructive-text",
        info: "border-ds-tint-info-border bg-ds-tint-info-fill text-ds-tint-info-text",
      },
      size: {
        sm: "h-5.5 text-ds-ui-xs [&_svg]:size-3",
        md: "h-6 text-ds-ui-sm [&_svg]:size-3",
      },
    },
    defaultVariants: { variant: "neutral", size: "sm" },
  },
);

export type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>;

export function Badge({ className, variant, size, ...props }: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="ds-badge" data-variant={variant ?? "neutral"} className={cn(badgeVariants({ variant, size }), className)} {...props} />;
}

const DOT_COLOR: Record<BadgeVariant, string> = {
  neutral: "bg-ds-muted-foreground",
  success: "bg-ds-success",
  warning: "bg-ds-warning",
  destructive: "bg-ds-destructive",
  info: "bg-ds-info",
};

/** A status dot in the badge's solid status colour. */
export function BadgeDot({ variant = "neutral", className }: { variant?: BadgeVariant; className?: string }) {
  return <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", DOT_COLOR[variant], className)} />;
}
