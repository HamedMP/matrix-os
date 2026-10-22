import { useEffect, useState, type CSSProperties } from "react";

/** Returns the element that paints the surface's desktop background (Web: `<body>`, Electron: the background layer). */
export type GetStartedBackdropSource = () => HTMLElement | null;

interface DesktopBackdrop {
  backgroundImage?: string;
  backgroundColor?: string;
}

const TRANSPARENT = new Set(["", "transparent", "rgba(0, 0, 0, 0)"]);

function readDesktopBackdrop(element: HTMLElement | null): DesktopBackdrop | null {
  if (!element) return null;
  const style = window.getComputedStyle(element);
  const image = style.backgroundImage;
  const color = style.backgroundColor;
  const backdrop: DesktopBackdrop = {
    ...(image && image !== "none" ? { backgroundImage: image } : {}),
    ...(!TRANSPARENT.has(color) ? { backgroundColor: color } : {}),
  };
  return backdrop.backgroundImage || backdrop.backgroundColor ? backdrop : null;
}

function sameBackdrop(a: DesktopBackdrop | null, b: DesktopBackdrop | null): boolean {
  return a?.backgroundImage === b?.backgroundImage && a?.backgroundColor === b?.backgroundColor;
}

/**
 * Copies the desktop's own background (wallpaper image or colour) so the wizard can draw it
 * blurred and opaque. It follows later changes: a background layer that mounts after the
 * wizard (Electron) or a wallpaper that finishes loading. Page changes are read at most once
 * per frame, and watching stops as soon as the wizard closes.
 */
export function useDesktopBackdrop(source: GetStartedBackdropSource | undefined, active: boolean): CSSProperties | null {
  const [backdrop, setBackdrop] = useState<DesktopBackdrop | null>(null);

  useEffect(() => {
    if (!active || !source || typeof window === "undefined") return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const next = readDesktopBackdrop(source());
      setBackdrop((previous) => (sameBackdrop(previous, next) ? previous : next));
    };
    update();
    if (typeof MutationObserver === "undefined") return;
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(update);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["style", "class"] });
    return () => {
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [source, active]);

  return backdrop;
}
