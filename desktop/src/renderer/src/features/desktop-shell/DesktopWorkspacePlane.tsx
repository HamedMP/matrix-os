import {
  forwardRef,
  useEffect,
  useRef,
  type ComponentPropsWithoutRef,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type WheelEvent,
} from "react";
import { useNativeDesktopMode, type NativeDesktopMode } from "../../stores/native-desktop-mode";

function isInsideCanvasSurface(target: EventTarget | null): boolean {
  return target instanceof Element
    && target.closest("[data-desktop-surface],button,input,a") !== null;
}

type DesktopWorkspacePlaneProps = {
  mode: NativeDesktopMode;
  children: ReactNode;
} & Omit<ComponentPropsWithoutRef<"div">, "children">;

const DesktopWorkspacePlane = forwardRef<HTMLDivElement, DesktopWorkspacePlaneProps>(function DesktopWorkspacePlane({
  mode,
  children,
  ...triggerProps
}, ref) {
  const panX = useNativeDesktopMode((state) => state.panX);
  const panY = useNativeDesktopMode((state) => state.panY);
  const zoom = useNativeDesktopMode((state) => state.zoom);
  const setCanvasTransform = useNativeDesktopMode((state) => state.setCanvasTransform);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanupRef.current?.(), []);

  const startPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (mode !== "canvas" || event.button !== 0) return;
    if (isInsideCanvasSurface(event.target)) return;
    event.preventDefault();
    cleanupRef.current?.();
    const startX = event.clientX;
    const startY = event.clientY;
    const initialPanX = panX;
    const initialPanY = panY;
    const move = (pointerEvent: PointerEvent) => {
      setCanvasTransform({
        panX: initialPanX + pointerEvent.clientX - startX,
        panY: initialPanY + pointerEvent.clientY - startY,
      });
    };
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("blur", finish);
      if (cleanupRef.current === finish) cleanupRef.current = null;
    };
    cleanupRef.current = finish;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("blur", finish);
  };

  const zoomCanvas = (event: WheelEvent<HTMLDivElement>) => {
    if (mode !== "canvas" || (!event.metaKey && !event.ctrlKey)) return;
    if (isInsideCanvasSurface(event.target)) return;
    event.preventDefault();
    const viewport = event.currentTarget.getBoundingClientRect();
    const nextZoom = Math.min(2, Math.max(0.5, zoom * Math.exp(-event.deltaY * 0.002)));
    const pointerX = event.clientX - viewport.left;
    const pointerY = event.clientY - viewport.top;
    const canvasX = (pointerX - panX) / zoom;
    const canvasY = (pointerY - panY) / zoom;
    setCanvasTransform({
      zoom: nextZoom,
      panX: pointerX - canvasX * nextZoom,
      panY: pointerY - canvasY * nextZoom,
    });
  };

  const canvas = mode === "canvas";
  return (
    <div
      {...triggerProps}
      ref={ref}
      data-testid={canvas ? "native-desktop-canvas" : "native-desktop-workspace"}
      className="absolute inset-0 overflow-hidden"
      style={canvas ? {
        backgroundImage: "radial-gradient(circle, color-mix(in srgb, var(--text-primary) 22%, transparent) 1px, transparent 1px)",
        backgroundPosition: `${panX}px ${panY}px`,
        backgroundSize: `${24 * zoom}px ${24 * zoom}px`,
        cursor: "grab",
      } : undefined}
      onPointerDown={startPan}
      onWheel={zoomCanvas}
    >
      <div
        data-testid="native-desktop-workspace-plane"
        className="absolute inset-0"
        style={{
          transform: canvas ? `translate(${panX}px, ${panY}px) scale(${zoom})` : "none",
          transformOrigin: "0 0",
          pointerEvents: canvas ? "auto" : "none",
        }}
      >
        {children}
      </div>
    </div>
  );
});

export default DesktopWorkspacePlane;
