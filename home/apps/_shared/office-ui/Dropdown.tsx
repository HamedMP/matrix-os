import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cx, moveFocus, useOutsidePointer } from "./internal";

export interface DropdownItem {
  id: string;
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  /** Draw a divider above this item. */
  separatorBefore?: boolean;
  /** Shows a check mark (menuitemcheckbox) when defined. */
  checked?: boolean;
}

export interface DropdownProps {
  /** Trigger content. */
  label: ReactNode;
  /** Accessible name when the trigger shows only an icon. */
  ariaLabel?: string;
  items: readonly DropdownItem[];
  onSelect: (id: string) => void;
  align?: "start" | "end";
  disabled?: boolean;
  className?: string;
}

/** Menu button: Enter/Space/ArrowDown opens, arrows move, Escape closes and returns focus. */
export function Dropdown({ label, ariaLabel, items, onSelect, align = "start", disabled, className }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const focusFirst = useRef<"first" | "last">("first");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useOutsidePointer([triggerRef, menuRef], open, () => setOpen(false));

  useEffect(() => {
    if (!open) return;
    const menuItems = menuItemsOf(menuRef.current);
    const target = focusFirst.current === "last" ? menuItems[menuItems.length - 1] : menuItems[0];
    target?.focus();
  }, [open]);

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      focusFirst.current = event.key === "ArrowUp" ? "last" : "first";
      setOpen(true);
    }
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === "Tab") {
      close(false);
      return;
    }
    if (moveFocus(menuItemsOf(menuRef.current), document.activeElement, event.key, "vertical") >= 0) event.preventDefault();
  };

  return (
    <div className={cx("oui-dropdown", className)}>
      <button
        ref={triggerRef}
        type="button"
        className="oui-toolbar__button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => {
          focusFirst.current = "first";
          setOpen((value) => !value);
        }}
        onKeyDown={onTriggerKeyDown}
      >
        {label}
        <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
      </button>
      {open && (
        <div ref={menuRef} id={menuId} role="menu" className={cx("oui-menu", align === "end" && "oui-menu--end")} onKeyDown={onMenuKeyDown}>
          {items.map((item) => (
            <div key={item.id} role="none">
              {item.separatorBefore && <hr className="oui-menu__separator" />}
              <button
                type="button"
                role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
                aria-checked={item.checked}
                tabIndex={-1}
                disabled={item.disabled}
                className={cx("oui-menu__item", item.danger && "is-danger")}
                onClick={() => {
                  close(true);
                  onSelect(item.id);
                }}
              >
                <span className="oui-menu__icon" aria-hidden="true">{item.checked ? "✓" : item.icon}</span>
                <span className="oui-menu__label">{item.label}</span>
                {item.shortcut && <kbd className="oui-menu__shortcut">{item.shortcut}</kbd>}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function menuItemsOf(menu: HTMLElement | null): HTMLElement[] {
  if (!menu) return [];
  return Array.from(menu.querySelectorAll<HTMLElement>("[role^='menuitem']:not([disabled])"));
}
