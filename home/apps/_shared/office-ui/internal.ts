import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/** Join class names, skipping falsy values. */
export function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(" ");
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
  "[contenteditable='true']",
].join(",");

/** Focusable descendants in DOM order, excluding hidden and inert subtrees. */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute("inert") && !el.closest("[inert]") && el.getAttribute("aria-hidden") !== "true",
  );
}

export const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Keep the latest callback in a ref so effects need not resubscribe on every render. */
export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useIsomorphicLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

/** Active focus traps, innermost last. Only the innermost one handles keys whose focus was lost. */
const activeTraps: HTMLElement[] = [];

/** True when no element has focus, as after the focused element was removed from the page. */
function focusIsLost(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || active === document.documentElement;
}

/**
 * Modal focus management: on activation remember the focused element, move focus
 * inside the container, keep Tab cycling inside it, call onEscape for Escape and
 * restore focus to the remembered element when deactivated or unmounted. When
 * the focused control inside is removed (focus falls back to the page), the
 * innermost trap still answers Escape and Tab.
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
  options: { onEscape?: () => void; initialFocusRef?: RefObject<HTMLElement | null> } = {},
): void {
  const onEscape = useLatest(options.onEscape);
  const initialFocusRef = options.initialFocusRef;

  useIsomorphicLayoutEffect(() => {
    if (!active) return undefined;
    const container = containerRef.current;
    if (!container) return undefined;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const initial = initialFocusRef?.current ?? focusableWithin(container)[0] ?? container;
    initial.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (!onEscape.current) return;
        event.stopPropagation();
        event.preventDefault();
        onEscape.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusableWithin(container);
      if (items.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      if (event.shiftKey && (current === first || !container.contains(current))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (current === last || !container.contains(current))) {
        event.preventDefault();
        first.focus();
      }
    };
    const onLostFocusKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !focusIsLost() || activeTraps[activeTraps.length - 1] !== container) return;
      onKeyDown(event);
    };
    activeTraps.push(container);
    container.addEventListener("keydown", onKeyDown);
    document.addEventListener("keydown", onLostFocusKeyDown);
    return () => {
      container.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keydown", onLostFocusKeyDown);
      const at = activeTraps.lastIndexOf(container);
      if (at !== -1) activeTraps.splice(at, 1);
      if (previous && previous.isConnected) previous.focus();
    };
  }, [active, containerRef, initialFocusRef, onEscape]);
}

/** Call handler when a pointer goes down outside every given element. */
export function useOutsidePointer(
  refs: Array<RefObject<HTMLElement | null>>,
  active: boolean,
  handler: () => void,
): void {
  const latest = useLatest(handler);
  const refsRef = useLatest(refs);
  useEffect(() => {
    if (!active) return undefined;
    const onDown = (event: MouseEvent | PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (refsRef.current.some((ref) => ref.current?.contains(target))) return;
      latest.current();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [active, latest, refsRef]);
}

/** Move focus among items with arrow keys (roving focus). Returns the new index or -1. */
export function moveFocus(items: HTMLElement[], current: Element | null, key: string, orientation: "horizontal" | "vertical"): number {
  if (items.length === 0) return -1;
  const index = items.findIndex((item) => item === current || item.contains(current));
  const next = orientation === "horizontal" ? "ArrowRight" : "ArrowDown";
  const prev = orientation === "horizontal" ? "ArrowLeft" : "ArrowUp";
  let target = -1;
  if (key === next) target = index < 0 ? 0 : (index + 1) % items.length;
  else if (key === prev) target = index <= 0 ? items.length - 1 : index - 1;
  else if (key === "Home") target = 0;
  else if (key === "End") target = items.length - 1;
  if (target >= 0) items[target].focus();
  return target;
}
