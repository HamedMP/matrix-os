import { useLayoutEffect, type RefObject } from "react";

/** Native dialog centering is viewport-relative, even inside a floating app. */
export function chatDialogOffset(main: Pick<DOMRect, "left" | "width">, viewportWidth: number): number {
  return main.width > 0 ? main.left + main.width / 2 - viewportWidth / 2 : 0;
}

export function useChatDialogAnchor(main: RefObject<HTMLElement | null>, geometry: unknown, sidebarShown: boolean) {
  useLayoutEffect(() => {
    const pane = main.current;
    if (!pane) return;
    const measure = () => pane.style.setProperty("--matrix-chat-dialog-offset", `${chatDialogOffset(pane.getBoundingClientRect(), window.innerWidth)}px`);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(pane);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [main, geometry, sidebarShown]);
}
