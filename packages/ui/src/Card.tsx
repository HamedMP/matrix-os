import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "./cn.js";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
  glass?: boolean;
}

const cardStyle: React.CSSProperties = {
  background: "var(--matrix-card)",
  color: "var(--matrix-card-fg)",
  border: "1px solid var(--matrix-border)",
  borderRadius: "var(--matrix-radius-lg)",
  boxShadow: "0 1px 3px rgba(0, 0, 0, 0.08)",
  overflow: "hidden",
};

const glassStyle: React.CSSProperties = {
  background: "rgba(255, 255, 255, 0.8)",
  backdropFilter: "blur(8px)",
  WebkitBackdropFilter: "blur(8px)",
  borderRadius: "var(--matrix-radius-xl)",
};

export function Card({ className, style, glass, children, ...rest }: CardProps) {
  return (
    <div
      className={cn("matrix-card", glass && "matrix-card-glass", className)}
      style={{ ...cardStyle, ...(glass ? glassStyle : {}), ...style }}
      {...rest}
    >
      {children}
    </div>
  );
}

export interface CardHeaderProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
}

export function CardHeader({ className, style, children, ...rest }: CardHeaderProps) {
  return (
    <div
      className={cn("matrix-card-header", className)}
      style={{ padding: "16px 16px 0", ...style }}
      {...rest}
    >
      {children}
    </div>
  );
}

export interface CardTitleProps extends HTMLAttributes<HTMLHeadingElement> {
  children?: ReactNode;
}

export function CardTitle({ className, style, children, ...rest }: CardTitleProps) {
  return (
    <h3
      className={cn("matrix-card-title", className)}
      style={{
        margin: 0,
        fontSize: "1.125rem",
        fontWeight: 600,
        color: "var(--matrix-fg)",
        lineHeight: 1.4,
        ...style,
      }}
      {...rest}
    >
      {children}
    </h3>
  );
}

export interface CardContentProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
}

export function CardContent({ className, style, children, ...rest }: CardContentProps) {
  return (
    <div
      className={cn("matrix-card-content", className)}
      style={{ padding: "16px", ...style }}
      {...rest}
    >
      {children}
    </div>
  );
}

export interface CardFooterProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
}

export function CardFooter({ className, style, children, ...rest }: CardFooterProps) {
  return (
    <div
      className={cn("matrix-card-footer", className)}
      style={{
        padding: "0 16px 16px",
        display: "flex",
        alignItems: "center",
        gap: "8px",
        ...style,
      }}
      {...rest}
    >
      {children}
    </div>
  );
}
