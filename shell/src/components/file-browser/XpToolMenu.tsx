"use client";

import { useEffect, useEffectEvent, useRef } from "react";

export interface XpMenuItem {
  label: string;
  action: () => void;
  checked?: boolean;
  disabled?: boolean;
}

interface XpToolMenuProps {
  open: boolean;
  onClose: () => void;
  trigger: React.ReactNode;
  items: XpMenuItem[];
}

/**
 * Minimal Luna-style dropdown anchored under its trigger. Mirrors the outside
 * pointerdown/Escape dismissal used by the shell MenuBar dropdowns.
 */
export function XpToolMenu({ open, onClose, trigger, items }: XpToolMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseEvent = useEffectEvent(onClose);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onCloseEvent();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseEvent();
    };
    document.addEventListener("pointerdown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="xp-menu-anchor" ref={ref}>
      {trigger}
      {open && (
        <div className="xp-menu" role="menu">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className="xp-menu-item"
              data-checked={item.checked ? "true" : undefined}
              disabled={item.disabled}
              onClick={() => {
                item.action();
                onClose();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
