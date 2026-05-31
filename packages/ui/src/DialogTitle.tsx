import { type HTMLAttributes, type ReactNode } from "react";
import { cn } from "./cn.js";

export interface DialogTitleProps extends HTMLAttributes<HTMLHeadingElement> {
  children?: ReactNode;
}

export function DialogTitle({ className, style, children, ...rest }: DialogTitleProps) {
  return (
    <h2
      className={cn("matrix-dialog-title", className)}
      style={{
        margin: "0 0 16px",
        fontSize: "1.25rem",
        fontWeight: 600,
        color: "var(--matrix-fg)",
        ...style,
      }}
      {...rest}
    >
      {children}
    </h2>
  );
}
