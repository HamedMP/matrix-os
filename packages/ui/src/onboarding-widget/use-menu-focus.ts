import { useEffect, type RefObject } from "react";

/**
 * Moves focus into a widget menu when it opens and back to the button that opened it when it closes.
 * Focus the user already moved elsewhere (an outside click, a panel the menu opened) is left alone.
 */
export function useMenuFocus(rootRef: RefObject<HTMLElement | null>, menu: "more" | "ai", open: boolean): void {
  useEffect(() => {
    const root = rootRef.current;
    if (!open || !root) return;
    const toggle = `[data-mxo-menu-toggle="${menu}"]`;
    const active = document.activeElement;
    const trigger = (active instanceof HTMLElement ? active.closest<HTMLElement>(toggle) : null) ?? root.querySelector<HTMLElement>(toggle);
    const panel = root.querySelector<HTMLElement>(`[data-mxo-menu="${menu}"]`);
    const first = panel?.querySelector<HTMLElement>('[aria-checked="true"][role="menuitemradio"]')
      ?? panel?.querySelector<HTMLElement>('[role^="menuitem"]');
    first?.focus();
    return () => {
      const now = document.activeElement;
      const focusLost = !now || now === document.body || (panel?.contains(now) ?? false);
      if (focusLost && trigger?.isConnected) trigger.focus();
    };
  }, [menu, open, rootRef]);
}
