import { forwardRef, type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode } from "react";
import { cx, focusableWithin, moveFocus } from "./internal";

export interface ToolbarProps {
  /** Accessible name, e.g. "Formatting". */
  label: string;
  children: ReactNode;
  className?: string;
}

/** role="toolbar" with Left/Right/Home/End moving focus between its controls. */
export function Toolbar({ label, children, className }: ToolbarProps) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const target = event.target as HTMLElement;
    if (target.matches("input, textarea, select, [contenteditable='true']")) return;
    if (target.closest("[role='menu']")) return;
    const items = focusableWithin(event.currentTarget).filter((el) => !el.closest("[role='menu']"));
    if (moveFocus(items, document.activeElement, event.key, "horizontal") >= 0) event.preventDefault();
  };
  return (
    <div role="toolbar" aria-label={label} aria-orientation="horizontal" className={cx("oui-toolbar", className)} onKeyDown={onKeyDown}>
      {children}
    </div>
  );
}

export interface ToolbarGroupProps {
  label: string;
  children: ReactNode;
  className?: string;
}

export function ToolbarGroup({ label, children, className }: ToolbarGroupProps) {
  return (
    <div role="group" aria-label={label} className={cx("oui-toolbar__group", className)}>
      {children}
    </div>
  );
}

export interface ToolbarButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** Accessible name and tooltip text. */
  label: string;
  icon?: ReactNode;
  /** Render the label next to the icon (always rendered when there is no icon). */
  showLabel?: boolean;
  /** Toggle state; sets aria-pressed when defined. */
  pressed?: boolean;
  /** Keyboard shortcut shown in the tooltip, e.g. "Ctrl+B". */
  shortcut?: string;
  variant?: "default" | "primary" | "danger";
}

export const ToolbarButton = forwardRef<HTMLButtonElement, ToolbarButtonProps>(function ToolbarButton(
  { label, icon, showLabel = false, pressed, shortcut, variant = "default", className, type = "button", ...rest },
  ref,
) {
  const visibleLabel = showLabel || !icon;
  return (
    <button
      ref={ref}
      type={type}
      aria-label={visibleLabel ? undefined : label}
      aria-pressed={pressed}
      aria-keyshortcuts={shortcut}
      title={shortcut ? `${label} (${shortcut})` : label}
      className={cx("oui-toolbar__button", variant !== "default" && `oui-toolbar__button--${variant}`, pressed && "is-pressed", className)}
      {...rest}
    >
      {icon && <span className="oui-toolbar__icon" aria-hidden="true">{icon}</span>}
      {visibleLabel && <span className="oui-toolbar__label">{label}</span>}
    </button>
  );
});

export function ToolbarSeparator() {
  return <span role="separator" aria-orientation="vertical" className="oui-toolbar__separator" />;
}
