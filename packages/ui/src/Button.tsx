import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "./cn.js";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive";
export type ButtonSize = "sm" | "md" | "lg" | "icon";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children?: ReactNode;
}

const baseStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "8px",
  fontWeight: 600,
  fontFamily: "var(--matrix-font-sans)",
  borderRadius: "var(--matrix-radius-md)",
  cursor: "pointer",
  transition: "opacity 0.1s ease-out, background-color 0.1s ease-out",
  border: "none",
  outline: "none",
  textDecoration: "none",
  lineHeight: 1,
};

const variantStyles: Record<ButtonVariant, React.CSSProperties> = {
  primary: {
    background: "var(--matrix-primary)",
    color: "var(--matrix-primary-fg)",
  },
  secondary: {
    background: "transparent",
    color: "var(--matrix-fg)",
    border: "1px solid var(--matrix-border)",
  },
  ghost: {
    background: "transparent",
    color: "var(--matrix-fg)",
  },
  destructive: {
    background: "var(--matrix-destructive)",
    color: "#ffffff",
  },
};

const sizeStyles: Record<ButtonSize, React.CSSProperties> = {
  sm: { padding: "6px 12px", fontSize: "0.8125rem" },
  md: { padding: "8px 20px", fontSize: "0.875rem" },
  lg: { padding: "12px 28px", fontSize: "1rem" },
  icon: { padding: "8px", width: "36px", height: "36px" },
};

export function Button({
  variant = "primary",
  size = "md",
  className,
  style,
  disabled,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={cn("matrix-btn", `matrix-btn-${variant}`, className)}
      style={{
        ...baseStyle,
        ...variantStyles[variant],
        ...sizeStyles[size],
        ...(disabled ? { opacity: 0.5, cursor: "not-allowed" } : {}),
        ...style,
      }}
      disabled={disabled}
      {...rest}
    >
      {children}
    </button>
  );
}
