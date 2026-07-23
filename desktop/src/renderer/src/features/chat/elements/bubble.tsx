import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "../../../lib/cn";

// Vendored from shadcn/ui `bubble` (June 2026 chat components release), with
// shadcn theme tokens rewritten to our Operator design tokens:
//   primary/primary-foreground → --accent/--text-on-accent
//   secondary                  → --bg-sunken/--text-primary
//   muted                      → --accent-muted
//   tinted                     → --highlight-muted
//   outline (border/background)→ --border-default/--bg-surface
//   destructive                → --danger-muted/--danger
// `BubbleReactions` from the original is intentionally not ported — nothing in
// the desktop chat renders reactions today.
// Source: https://ui.shadcn.com/docs/components/base/bubble

function BubbleGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="bubble-group"
      className={cn("flex min-w-0 flex-col gap-2", className)}
      {...props}
    />
  );
}

const bubbleVariants = cva(
  "group/bubble relative flex w-fit max-w-[80%] min-w-0 flex-col gap-1 group-data-[align=end]/message:self-end data-[align=end]:self-end data-[variant=ghost]:max-w-full",
  {
    variants: {
      variant: {
        default:
          "*:data-[slot=bubble-content]:bg-[var(--accent)] *:data-[slot=bubble-content]:text-[var(--text-on-accent)]",
        secondary:
          "*:data-[slot=bubble-content]:bg-[var(--bg-sunken)] *:data-[slot=bubble-content]:text-[var(--text-primary)]",
        muted:
          "*:data-[slot=bubble-content]:bg-[var(--accent-muted)] *:data-[slot=bubble-content]:text-[var(--text-primary)]",
        tinted:
          "*:data-[slot=bubble-content]:bg-[var(--highlight-muted)] *:data-[slot=bubble-content]:text-[var(--text-primary)]",
        outline:
          "*:data-[slot=bubble-content]:border-[var(--border-default)] *:data-[slot=bubble-content]:bg-[var(--bg-surface)]",
        ghost:
          "border-none *:data-[slot=bubble-content]:rounded-none *:data-[slot=bubble-content]:bg-transparent *:data-[slot=bubble-content]:p-0",
        destructive:
          "*:data-[slot=bubble-content]:bg-[var(--danger-muted)] *:data-[slot=bubble-content]:text-[var(--danger)]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Bubble({
  variant = "default",
  align = "start",
  className,
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<typeof bubbleVariants> & {
    align?: "start" | "end";
  }) {
  return (
    <div
      data-slot="bubble"
      data-variant={variant}
      data-align={align}
      className={cn(bubbleVariants({ variant }), className)}
      {...props}
    />
  );
}

function BubbleContent({
  asChild = false,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  asChild?: boolean;
}) {
  const Comp = asChild ? Slot : "div";

  return (
    <Comp
      data-slot="bubble-content"
      className={cn(
        "w-fit max-w-full min-w-0 overflow-hidden rounded-xl border border-transparent px-3 py-2 text-sm leading-relaxed wrap-break-word group-data-[align=end]/bubble:self-end [button]:text-left",
        className,
      )}
      {...props}
    />
  );
}

export { BubbleGroup, Bubble, BubbleContent, bubbleVariants };
