import type { ReactNode } from "react";
import { Button } from "../Button.js";

export const mutedStyle = { color: "var(--text-secondary,var(--muted-foreground))" };
export const borderStyle = { borderColor: "var(--border-subtle,var(--border))" };

export function ProjectSetupActionButton({
  children,
  onClick,
  disabled = false,
  variant = "secondary",
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "ghost";
}) {
  return (
    <Button
      variant={variant}
      size="sm"
      className="min-h-7 max-w-full text-left focus-visible:outline-2! focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]!"
      style={{
        borderRadius: "6px",
        padding: "4px 9px",
        fontWeight: 500,
        lineHeight: "1.25",
        ...(variant === "secondary" && !disabled ? {
          background: "var(--bg-raised,var(--card))",
          borderColor: "var(--border-subtle,var(--border))",
          color: "inherit",
        } : {}),
      }}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}
