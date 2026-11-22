import type { ReactNode } from "react";
import { Button } from "../Button.js";

const actionClass = "min-h-8 max-w-full text-xs enabled:[color:inherit]!";
export const mutedStyle = { color: "var(--text-secondary,var(--muted-foreground))" };
export const borderStyle = { borderColor: "var(--border-subtle,var(--border))" };
export function ProjectSetupActionButton({
  children,
  onClick,
  disabled = false,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Button variant="secondary" size="sm" className={actionClass} disabled={disabled} onClick={onClick}>
      {children}
    </Button>
  );
}
