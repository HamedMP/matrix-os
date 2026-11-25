import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { DropdownItem } from "./Dropdown";
import { cx, layerHost, moveFocus, useIsomorphicLayoutEffect, useLatest } from "./internal";
import { placeFloating } from "./Popover";

export interface FloatingMenuProps {
  anchorRef: RefObject<HTMLElement | null>;
  label: string;
  items: readonly DropdownItem[];
  onSelect: (id: string) => void;
  /** Close request; returnFocus is true for Escape and selection, false for Tab and outside clicks. */
  onClose: (returnFocus: boolean) => void;
  initialFocus?: "first" | "last";
  id?: string;
}

function menuItemsOf(menu: HTMLElement | null): HTMLElement[] {
  if (!menu) return [];
  return Array.from(menu.querySelectorAll<HTMLElement>("[role^='menuitem']:not([disabled])"));
}

/**
 * A menu rendered outside clipping containers (the ribbon row hides overflow),
 * in the layer holding its anchor (see layerHost) so it stays above it.
 * Keys are handled with a native listener so an enclosing popover's focus trap
 * never sees the menu's Escape.
 */
export function FloatingMenu({ anchorRef, label, items, onSelect, onClose, initialFocus = "first", id }: FloatingMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: -9999, left: -9999 });
  const close = useLatest(onClose);

  useIsomorphicLayoutEffect(() => {
    const update = () => {
      const anchor = anchorRef.current;
      const menu = menuRef.current;
      if (!anchor || !menu) return;
      setPosition(placeFloating(anchor.getBoundingClientRect(), menu.getBoundingClientRect(), "bottom-start"));
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchorRef]);

  useEffect(() => {
    const items = menuItemsOf(menuRef.current);
    (initialFocus === "last" ? items[items.length - 1] : items[0])?.focus();
  }, [initialFocus]);

  useEffect(() => {
    const menu = menuRef.current;
    if (!menu) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close.current(true);
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        event.stopPropagation();
        close.current(true);
        return;
      }
      if (moveFocus(menuItemsOf(menu), document.activeElement, event.key, "vertical") >= 0) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target || menu.contains(target) || anchorRef.current?.contains(target)) return;
      close.current(false);
    };
    menu.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onDown);
    return () => {
      menu.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onDown);
    };
  }, [anchorRef, close]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={menuRef}
      id={id}
      role="menu"
      aria-label={label}
      data-oui-float=""
      data-oui-layer=""
      className="oui-menu oui-menu--floating"
      style={{ top: position.top, left: position.left }}
    >
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
              close.current(true);
              onSelect(item.id);
            }}
          >
            <span className="oui-menu__icon" aria-hidden="true">{item.checked ? "✓" : item.icon}</span>
            <span className="oui-menu__label">{item.label}</span>
            {item.shortcut && <kbd className="oui-menu__shortcut">{item.shortcut}</kbd>}
          </button>
        </div>
      ))}
    </div>,
    layerHost(anchorRef.current),
  );
}

/** State and trigger props for a button that opens a FloatingMenu. */
export function useMenuTrigger() {
  const [open, setOpen] = useState(false);
  const [initialFocus, setInitialFocus] = useState<"first" | "last">("first");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };
  const triggerProps = {
    ref: triggerRef,
    "aria-haspopup": "menu" as const,
    "aria-expanded": open,
    "aria-controls": open ? menuId : undefined,
    onClick: () => {
      setInitialFocus("first");
      setOpen((value) => !value);
    },
    onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      event.stopPropagation();
      setInitialFocus(event.key === "ArrowUp" ? "last" : "first");
      setOpen(true);
    },
  };
  return { open, close, triggerRef, triggerProps, menuId, initialFocus };
}
