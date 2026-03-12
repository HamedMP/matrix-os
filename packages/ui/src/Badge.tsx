import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "./cn.js";

export type BadgeVariant = "default" | "success" | "warning" | "error";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  children?: ReactNode;
}

const baseStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "4px",
  padding: "2px 10px",
  fontSize: "0.75rem",
  fontWeight: 500,
  borderRadius: "9999px",
  lineHeight: 1.5,
  whiteSpace: "nowrap",
};

const variantStyles: Record<BadgeVariant, React.CSSProperties> = {
  default: {
    background: "rgba(194, 112, 58, 0.1)",
    color: "var(--matrix-primary)",
    border: "1px solid rgba(194, 112, 58, 0.3)",
  },
  success: {
    background: "rgba(34, 197, 94, 0.1)",
    color: "var(--matrix-success)",
    border: "1px solid rgba(34, 197, 94, 0.3)",
  },
  warning: {
    background: "rgba(234, 179, 8, 0.1)",
    color: "var(--matrix-warning)",
    border: "1px solid rgba(234, 179, 8, 0.3)",
  },
  error: {
    background: "rgba(239, 68, 68, 0.1)",
    color: "var(--matrix-destructive)",
    border: "1px solid rgba(239, 68, 68, 0.3)",
  },
};

export function Badge({ variant = "default", className, style, children, ...rest }: BadgeProps) {
  return (
    <span
      className={cn("matrix-badge", `matrix-badge-${variant}`, className)}
      style={{ ...baseStyle, ...variantStyles[variant], ...style }}
      {...rest}
    >
      {children}
    </span>
  );
}
