import { useEffect, useRef } from "react";

export type ActiveAppShortcut = "new-tab" | "close-tab";

const ACTIVE_APP_SHORTCUT_EVENT = "matrix:active-app-shortcut";

export function dispatchActiveAppShortcut(action: ActiveAppShortcut): boolean {
  const event = new CustomEvent<ActiveAppShortcut>(ACTIVE_APP_SHORTCUT_EVENT, {
    cancelable: true,
    detail: action,
  });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

export function useActiveAppShortcuts(
  active: boolean,
  handler: (action: ActiveAppShortcut) => boolean,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!active) return;
    const onShortcut = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const shortcutEvent = event as CustomEvent<unknown>;
      if (shortcutEvent.detail !== "new-tab" && shortcutEvent.detail !== "close-tab") return;
      if (handlerRef.current(shortcutEvent.detail)) shortcutEvent.preventDefault();
    };
    window.addEventListener(ACTIVE_APP_SHORTCUT_EVENT, onShortcut);
    return () => window.removeEventListener(ACTIVE_APP_SHORTCUT_EVENT, onShortcut);
  }, [active]);
}
