import { cva, type VariantProps } from "class-variance-authority";
import * as RadixTooltip from "@radix-ui/react-tooltip";
import type { ComponentProps, ReactNode } from "react";
import { dsCn as cn } from "./cn";
import { tooltipContentClass, tooltipLayerStyle } from "./Tooltip";

// Design-library Button: primary is neutral, destructive is coral, sizes 28 · 32 · 36px,
// every size an 8px radius. Focus is the shared gold ring.
export const buttonVariants = cva(
  [
    "ds-focus no-drag relative inline-flex shrink-0 items-center justify-center gap-1.5 font-ds-sans font-medium whitespace-nowrap select-none",
    "transition-[color,background-color,border-color] duration-[120ms]",
    "disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        primary: "bg-ds-primary text-ds-primary-foreground shadow-ds-xs hover:bg-ds-primary-hover",
        secondary: "border border-ds-border bg-ds-secondary text-ds-foreground shadow-ds-xs hover:bg-ds-secondary-hover",
        ghost: "text-ds-foreground hover:bg-ds-ghost-hover",
        destructive: "bg-ds-destructive text-ds-destructive-foreground shadow-ds-xs hover:bg-ds-destructive-hover",
        "ghost-destructive": "text-ds-destructive-text hover:bg-ds-tint-destructive-fill",
        link: "h-auto! px-0! text-ds-foreground underline decoration-1 underline-offset-4 hover:text-ds-primary-hover",
      },
      size: {
        xs: "h-7 rounded-md px-2.5 text-ds-ui-sm has-[>svg:first-child]:pl-2 has-[>svg:last-child]:pr-2 [&_svg]:size-3.5",
        sm: "h-8 rounded-md px-3 text-ds-ui has-[>svg:first-child]:pl-2.5 has-[>svg:last-child]:pr-2.5 [&_svg]:size-4",
        md: "h-9 rounded-md px-3.5 text-ds-ui has-[>svg:first-child]:pl-3 has-[>svg:last-child]:pr-3 [&_svg]:size-4",
      },
      square: { true: "aspect-square px-0!" },
    },
    defaultVariants: { variant: "secondary", size: "sm", square: false },
  },
);

export type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>["variant"]>;
export type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>["size"]>;

export type ButtonProps = ComponentProps<"button"> & VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, square, type = "button", ...props }: ButtonProps) {
  return (
    <button
      type={type}
      data-slot="ds-button"
      data-variant={variant ?? "secondary"}
      className={cn(buttonVariants({ variant, size, square }), className)}
      {...props}
    />
  );
}

/**
 * Icon-only button: square, always labelled, with a tooltip that repeats the label
 * (and an optional shortcut hint). Needs a Radix Tooltip.Provider above it.
 */
export function IconButton({
  label,
  shortcut,
  variant = "ghost",
  size = "sm",
  children,
  tooltip = true,
  ...props
}: Omit<ButtonProps, "aria-label" | "square"> & { label: string; shortcut?: string; tooltip?: boolean; children: ReactNode }) {
  const button = (
    <Button aria-label={label} variant={variant} size={size} square {...props}>
      {children}
    </Button>
  );
  if (!tooltip) return button;
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{button}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content sideOffset={6} className={tooltipContentClass} style={tooltipLayerStyle}>
          {label}
          {shortcut ? <span className="ml-1.5 opacity-70">{shortcut}</span> : null}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
