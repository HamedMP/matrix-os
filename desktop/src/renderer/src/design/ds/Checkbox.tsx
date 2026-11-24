import { Check, Minus } from "lucide-react";
import type { ComponentProps, MouseEvent } from "react";
import { cn } from "../../lib/cn";
import { Icon } from "./Icon";

export type CheckedState = boolean | "indeterminate";

// Design-library Checkbox (16px): outlined; checked and indeterminate darken the
// border and draw a dark mark on the page colour.
export function Checkbox({
  checked,
  onCheckedChange,
  className,
  disabled,
  onClick,
  ...props
}: Omit<ComponentProps<"button">, "onChange" | "role" | "aria-checked"> & {
  checked: CheckedState;
  /** Space and Enter reach this through the button's native click. */
  onCheckedChange?: (next: boolean, event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const marked = checked !== false;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked === "indeterminate" ? "mixed" : checked}
      data-state={checked === "indeterminate" ? "indeterminate" : checked ? "checked" : "unchecked"}
      disabled={disabled}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) onCheckedChange?.(checked !== true, event);
      }}
      className={cn(
        "ds-focus grid size-4 shrink-0 place-content-center rounded-[4px] border bg-ds-background text-ds-primary shadow-ds-xs",
        "transition-[border-color] duration-[120ms] hover:border-ds-muted-foreground",
        marked ? "border-ds-primary" : "border-ds-input",
        "disabled:cursor-not-allowed disabled:border-ds-border disabled:bg-ds-muted disabled:text-ds-muted-foreground disabled:shadow-none",
        className,
      )}
      {...props}
    >
      {checked === "indeterminate" ? <Icon icon={Minus} size="xxs" /> : checked ? <Icon icon={Check} size="xxs" /> : null}
    </button>
  );
}
