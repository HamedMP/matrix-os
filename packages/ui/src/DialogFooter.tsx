import { type HTMLAttributes, type ReactNode } from "react";
import { cn } from "./cn.js";

export interface DialogFooterProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
}

export function DialogFooter({ className, style, children, ...rest }: DialogFooterProps) {
  return (
    <div
      className={cn("matrix-dialog-footer", className)}
      style={{
        display: "flex",
        justifyContent: "flex-end",
        gap: "8px",
        marginTop: "24px",
        ...style,
      }}
      {...rest}
    >
      {children}
    </div>
  );
}
