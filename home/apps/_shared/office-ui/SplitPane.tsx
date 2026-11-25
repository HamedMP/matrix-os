import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { clamp, cx, useLatest } from "./internal";

export interface SplitPaneProps {
  /** Accessible name for the resize handle. */
  label: string;
  first: ReactNode;
  second: ReactNode;
  /** "horizontal" places panes side by side (default); "vertical" stacks them. */
  direction?: "horizontal" | "vertical";
  /** Controlled size of the first pane in px. */
  size?: number;
  /** Initial size of the first pane in px when uncontrolled (default 320). */
  defaultSize?: number;
  minSize?: number;
  maxSize?: number;
  onSizeChange?: (size: number) => void;
  /** Keyboard step in px (default 16; Shift multiplies by 4). */
  step?: number;
  className?: string;
}

/** Two resizable panes with a pointer- and keyboard-operable separator. */
export function SplitPane({
  label,
  first,
  second,
  direction = "horizontal",
  size,
  defaultSize = 320,
  minSize = 120,
  maxSize = 960,
  onSizeChange,
  step = 16,
  className,
}: SplitPaneProps) {
  const [innerSize, setInnerSize] = useState(() => clamp(defaultSize, minSize, maxSize));
  const current = clamp(size ?? innerSize, minSize, maxSize);
  const currentRef = useLatest(current);
  const drag = useRef<{ origin: number; startSize: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const horizontal = direction === "horizontal";

  const commit = (next: number) => {
    const value = Math.round(clamp(next, minSize, maxSize));
    if (size === undefined) setInnerSize(value);
    onSizeChange?.(value);
  };
  const commitRef = useLatest(commit);

  useEffect(() => {
    if (!dragging) return undefined;
    const onMove = (event: PointerEvent) => {
      const state = drag.current;
      if (!state) return;
      const position = horizontal ? event.clientX : event.clientY;
      commitRef.current(state.startSize + position - state.origin);
    };
    const onUp = () => {
      drag.current = null;
      setDragging(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [dragging, horizontal, commitRef]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    drag.current = { origin: horizontal ? event.clientX : event.clientY, startSize: currentRef.current };
    setDragging(true);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const amount = event.shiftKey ? step * 4 : step;
    const grow = horizontal ? "ArrowRight" : "ArrowDown";
    const shrink = horizontal ? "ArrowLeft" : "ArrowUp";
    if (event.key === grow) commit(current + amount);
    else if (event.key === shrink) commit(current - amount);
    else if (event.key === "Home") commit(minSize);
    else if (event.key === "End") commit(maxSize);
    else return;
    event.preventDefault();
  };

  return (
    <div
      className={cx("oui-split", horizontal ? "oui-split--horizontal" : "oui-split--vertical", dragging && "is-dragging", className)}
      style={{ gridTemplateColumns: horizontal ? `${current}px auto minmax(0, 1fr)` : undefined, gridTemplateRows: horizontal ? undefined : `${current}px auto minmax(0, 1fr)` }}
    >
      <div className="oui-split__pane">{first}</div>
      <div
        role="separator"
        aria-label={label}
        aria-orientation={horizontal ? "vertical" : "horizontal"}
        aria-valuenow={current}
        aria-valuemin={minSize}
        aria-valuemax={maxSize}
        tabIndex={0}
        className="oui-split__handle"
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
      />
      <div className="oui-split__pane">{second}</div>
    </div>
  );
}
