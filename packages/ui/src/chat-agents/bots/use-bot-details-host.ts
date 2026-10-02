import { useLayoutEffect } from "react";

/** Reserve space only inside the actual Chat surface; narrow panes use an overlay. */
export function useBotDetailsHost(container: HTMLElement | null | undefined, opened: boolean) {
  useLayoutEffect(() => {
    if (!container || !opened) return;
    const property = "--matrix-bot-details-reserve";
    const previous = container.style.getPropertyValue(property);
    let active = true;
    const measure = () => {
      if (!active) return;
      // Read the border box: reserving padding must not change the decision itself.
      const reserve = container.getBoundingClientRect().width >= 720 ? "360px" : "0px";
      if (container.style.getPropertyValue(property) !== reserve) container.style.setProperty(property, reserve);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(container);
    return () => {
      active = false;
      observer?.disconnect();
      if (previous) container.style.setProperty(property, previous);
      else container.style.removeProperty(property);
    };
  }, [container, opened]);
}
