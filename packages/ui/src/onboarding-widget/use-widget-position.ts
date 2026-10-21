import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import {
  ONBOARDING_EDGE_GAP,
  onboardingPlacement,
  onboardingPositionFromRect,
  type OnboardingWidgetBox,
  type OnboardingWidgetPlacement,
  type OnboardingWidgetPosition,
} from "./position.js";

/** Pointer travel that turns a press into a drag, so a slightly shaky click still clicks. */
const DRAG_THRESHOLD_PX = 4;
/** Controls inside a drag handle that keep their own pointer behavior. */
const NOT_A_HANDLE = "button, a, input, textarea, select, [role='menu']";

export interface WidgetDragHandle {
  onPointerDown(event: ReactPointerEvent<HTMLElement>): void;
  onPointerMove(event: ReactPointerEvent<HTMLElement>): void;
  onPointerUp(event: ReactPointerEvent<HTMLElement>): void;
  onPointerCancel(): void;
}

interface DragSession {
  pointerId: number;
  startX: number;
  startY: number;
  rect: DOMRect;
  moved: boolean;
  dx: number;
  dy: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function subscribeToResize(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

/**
 * Drags the whole widget from a handle (the header or the bubble). The widget follows the pointer
 * with a transform, stays on screen, and is saved as a corner-anchored position on drop.
 */
export function useWidgetDrag(
  rootRef: RefObject<HTMLDivElement | null>,
  onDrop: (position: OnboardingWidgetPosition) => void,
): { handle: WidgetDragHandle; onClickCapture(event: ReactMouseEvent): void } {
  const sessionRef = useRef<DragSession | null>(null);
  const swallowClickRef = useRef(false);

  const finish = (): DragSession | null => {
    const session = sessionRef.current;
    sessionRef.current = null;
    const root = rootRef.current;
    if (root) {
      root.style.transform = "";
      delete root.dataset.dragging;
    }
    return session;
  };

  const handle: WidgetDragHandle = {
    onPointerDown(event) {
      if (event.button !== 0) return;
      const control = event.target instanceof Element ? event.target.closest(NOT_A_HANDLE) : null;
      if (control && control !== event.currentTarget) return;
      const root = rootRef.current;
      if (!root) return;
      sessionRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        rect: root.getBoundingClientRect(),
        moved: false,
        dx: 0,
        dy: 0,
      };
      // Captured from the press so a release outside the handle still ends the session.
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    onPointerMove(event) {
      const session = sessionRef.current;
      const root = rootRef.current;
      if (!session || !root || event.pointerId !== session.pointerId) return;
      if (event.buttons === 0) {
        finish();
        return;
      }
      const travelX = event.clientX - session.startX;
      const travelY = event.clientY - session.startY;
      if (!session.moved) {
        if (Math.hypot(travelX, travelY) < DRAG_THRESHOLD_PX) return;
        session.moved = true;
        root.dataset.dragging = "";
      }
      const { rect } = session;
      session.dx = clamp(travelX, ONBOARDING_EDGE_GAP - rect.left, window.innerWidth - ONBOARDING_EDGE_GAP - rect.right);
      session.dy = clamp(travelY, ONBOARDING_EDGE_GAP - rect.top, window.innerHeight - ONBOARDING_EDGE_GAP - rect.bottom);
      root.style.transform = `translate(${session.dx}px, ${session.dy}px)`;
    },
    onPointerUp(event) {
      if (sessionRef.current?.pointerId !== event.pointerId) return;
      const session = finish();
      if (!session?.moved) return;
      // The browser still fires a click on the handle after a drag; that click must not open or toggle anything.
      swallowClickRef.current = true;
      window.setTimeout(() => {
        swallowClickRef.current = false;
      }, 0);
      const { rect } = session;
      onDrop(onboardingPositionFromRect(
        { left: rect.left + session.dx, top: rect.top + session.dy, width: rect.width, height: rect.height },
        { width: window.innerWidth, height: window.innerHeight },
      ));
    },
    onPointerCancel() {
      finish();
    },
  };

  const onClickCapture = (event: ReactMouseEvent) => {
    if (!swallowClickRef.current) return;
    swallowClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  return { handle, onClickCapture };
}

/** The window size, or null before it is known (server render, before hydration). */
export function useViewportSize(): OnboardingWidgetBox | null {
  const width = useSyncExternalStore(subscribeToResize, () => window.innerWidth, () => 0);
  const height = useSyncExternalStore(subscribeToResize, () => window.innerHeight, () => 0);
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * The CSS offsets for the saved position, re-fitted whenever the window or the widget changes size
 * so a card opened from a spot that only fit the bubble is still fully visible.
 */
export function useWidgetPlacement(
  rootRef: RefObject<HTMLDivElement | null>,
  position: OnboardingWidgetPosition,
  onSizeChange?: (size: OnboardingWidgetBox) => void,
): OnboardingWidgetPlacement {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const viewport = useViewportSize();

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const box = root.getBoundingClientRect();
      setSize((prev) => (prev.width === box.width && prev.height === box.height ? prev : { width: box.width, height: box.height }));
      onSizeChange?.({ width: box.width, height: box.height });
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, [onSizeChange, rootRef]);

  return onboardingPlacement(position, size, viewport);
}
