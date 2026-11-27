import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { cx, layerHost, useFocusTrap, useIsomorphicLayoutEffect, useOutsidePointer } from "./internal";

export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  /** Element the popover is positioned against; focus returns to it on close. */
  anchorRef: RefObject<HTMLElement | null>;
  children: ReactNode;
  /** Accessible name of the popover dialog. */
  label: string;
  placement?: "bottom-start" | "bottom-end" | "top-start" | "top-end";
  className?: string;
}

interface Position {
  top: number;
  left: number;
}

/** Position a floating panel next to its anchor, kept inside the viewport. */
export function placeFloating(anchor: DOMRect, panel: DOMRect, placement: NonNullable<PopoverProps["placement"]>): Position {
  const gap = 6;
  const vw = window.innerWidth || 1024;
  const vh = window.innerHeight || 768;
  let top = placement.startsWith("top") ? anchor.top - panel.height - gap : anchor.bottom + gap;
  let left = placement.endsWith("end") ? anchor.right - panel.width : anchor.left;
  if (top + panel.height > vh - 4) top = Math.max(4, anchor.top - panel.height - gap);
  if (top < 4) top = Math.min(vh - panel.height - 4, anchor.bottom + gap);
  left = Math.min(Math.max(4, left), Math.max(4, vw - panel.width - 4));
  return { top, left };
}

/**
 * Non-modal floating panel anchored to an element. Escape and outside clicks
 * close it; focus moves in on open and back to the anchor on close. It renders
 * in the layer holding its anchor (see layerHost), so one opened in a dialog,
 * the backstage or another popover stays above it, and a click in it is not a
 * click outside its parent.
 */
export function Popover({ open, onClose, anchorRef, children, label, placement = "bottom-start", className }: PopoverProps) {
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <PopoverSurface onClose={onClose} anchorRef={anchorRef} label={label} placement={placement} className={className}>
      {children}
    </PopoverSurface>,
    layerHost(anchorRef.current),
  );
}

function PopoverSurface({ onClose, anchorRef, children, label, placement, className }: Omit<PopoverProps, "open"> & { placement: NonNullable<PopoverProps["placement"]> }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<Position>({ top: -9999, left: -9999 });
  useFocusTrap(panelRef, true, { onEscape: onClose });
  useOutsidePointer([panelRef, anchorRef], true, onClose);
  // Runs after the trap's cleanup: when the opener never took focus (browsers
  // that do not focus a clicked button), focus would stay in the closing panel or fall to the
  // page, so return it to the anchor.
  useIsomorphicLayoutEffect(() => () => {
    const active = document.activeElement;
    if (!active || active === document.body || panelRef.current?.contains(active)) anchorRef.current?.focus();
  }, [anchorRef]);

  useIsomorphicLayoutEffect(() => {
    const update = () => {
      const anchor = anchorRef.current;
      const panel = panelRef.current;
      if (!anchor || !panel) return;
      setPosition(placeFloating(anchor.getBoundingClientRect(), panel.getBoundingClientRect(), placement));
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchorRef, placement]);

  return (
    <div ref={panelRef} role="dialog" aria-label={label} tabIndex={-1} data-oui-layer="" className={cx("oui-popover", className)} style={{ top: position.top, left: position.left }}>
      {children}
    </div>
  );
}

export interface TooltipProps {
  content: ReactNode;
  /** A single element that accepts ref-less event props (button, span…). */
  children: ReactElement<Record<string, unknown>>;
  /** Delay before showing on hover, in ms (default 500). Focus shows immediately. */
  delay?: number;
  placement?: "top" | "bottom";
}

/** Describes its child on hover and keyboard focus; Escape hides it. */
export function Tooltip({ content, children, delay = 500, placement = "top" }: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = useId();

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);

  useEffect(() => {
    if (!visible) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setVisible(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [visible]);

  if (!isValidElement(children)) return children;
  const props = children.props;
  const chain = (name: string, fn: () => void) => (event: unknown) => {
    const original = props[name];
    if (typeof original === "function") original(event);
    fn();
  };
  const show = () => {
    clear();
    timer.current = setTimeout(() => setVisible(true), delay);
  };
  const hide = () => {
    clear();
    setVisible(false);
  };

  return (
    <span className={cx("oui-tooltip-anchor", `oui-tooltip-anchor--${placement}`)}>
      {cloneElement(children, {
        "aria-describedby": visible ? id : props["aria-describedby"],
        onMouseEnter: chain("onMouseEnter", show),
        onMouseLeave: chain("onMouseLeave", hide),
        onFocus: chain("onFocus", () => {
          clear();
          setVisible(true);
        }),
        onBlur: chain("onBlur", hide),
      })}
      {visible && (
        <span role="tooltip" id={id} className="oui-tooltip">{content}</span>
      )}
    </span>
  );
}
