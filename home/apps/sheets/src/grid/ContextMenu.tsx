import { useEffect, useRef } from "react";

export interface MenuItem {
  id: string;
  label: string;
  /** Draws a line above the item. */
  separated?: boolean;
  disabled?: boolean;
}

export interface ContextMenuProps {
  items: readonly MenuItem[];
  /** Position inside the grid, in pixels. */
  x: number;
  y: number;
  label: string;
  onPick(id: string): void;
  onClose(): void;
}

/** A small menu for the cells and headers. Arrow keys move, Enter picks, Escape closes. */
export function ContextMenu({ items, x, y, label, onPick, onClose }: ContextMenuProps) {
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const first = root.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
    first?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const onDown = (event: MouseEvent): void => {
      if (root.current !== null && event.target instanceof Node && !root.current.contains(event.target)) onClose();
    };
    const document = root.current?.ownerDocument;
    document?.addEventListener("mousedown", onDown, true);
    return () => document?.removeEventListener("mousedown", onDown, true);
  }, [onClose]);

  const move = (delta: number): void => {
    const buttons = Array.from(root.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    if (buttons.length === 0) return;
    const at = buttons.indexOf(root.current?.ownerDocument.activeElement as HTMLButtonElement);
    buttons[(at + delta + buttons.length) % buttons.length]?.focus({ preventScroll: true });
  };

  return (
    <div
      ref={root}
      role="menu"
      aria-label={label}
      className="sg-menu"
      style={{ left: x, top: y }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          move(1);
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          move(-1);
        } else if (event.key === "Tab") {
          event.preventDefault();
          onClose();
        }
      }}
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          tabIndex={-1}
          disabled={item.disabled}
          className={`sg-menu__item${item.separated === true ? " is-separated" : ""}`}
          onClick={() => onPick(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
