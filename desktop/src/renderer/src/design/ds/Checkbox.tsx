import { Check, Minus } from "lucide-react";
import type { ComponentProps, KeyboardEvent, MouseEvent } from "react";
import { dsCn as cn } from "./cn";
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
  onKeyDown,
  ...props
}: Omit<ComponentProps<"button">, "onChange" | "role" | "aria-checked"> & {
  checked: CheckedState;
  onCheckedChange?: (next: boolean, event: MouseEvent<HTMLButtonElement> | KeyboardEvent<HTMLButtonElement>) => void;
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
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || (event.key !== " " && event.key !== "Enter")) return;
        // Handled here (not by the native click) so the key never also reaches a
        // parent row that uses Space for its own selection.
        event.preventDefault();
        event.stopPropagation();
        onCheckedChange?.(checked !== true, event);
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
