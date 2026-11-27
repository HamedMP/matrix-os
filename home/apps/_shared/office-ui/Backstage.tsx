import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { cx, moveFocus, useFocusTrap, useIsomorphicLayoutEffect, useLatest } from "./internal";
import { tooltipFor } from "./ribbon-parts";
import type { BackstageApi, RibbonBackstage } from "./ribbon-types";

export interface BackstageViewProps {
  /** Accessible name, usually the tab label ("File"). */
  label: string;
  backstage: RibbonBackstage;
  /** Item whose content is shown. */
  item: string | null;
  onItemChange: (id: string) => void;
  onClose: () => void;
  /**
   * The panel covers the page from this element's top edge down (the ribbon),
   * leaving the title bar visible. Presses inside it, where the tab that opened
   * the panel sits, do not close the panel.
   */
  topRef: RefObject<HTMLElement | null>;
}

/**
 * Layers that float above the backstage: dialogs and their backdrops, popovers,
 * menus, listboxes and toasts, including ones the backstage's own content opens.
 * A press inside them is not a press outside the backstage.
 */
const ABOVE_BACKSTAGE = ".oui-backdrop, .oui-popover, [data-oui-float], .oui-toasts, [role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox']";

function isAboveBackstage(target: Node): boolean {
  const el = target instanceof Element ? target : target.parentElement;
  return Boolean(el?.closest(ABOVE_BACKSTAGE));
}

/** Closes the backstage when a press lands outside it (light dismiss), such as on the title bar. */
function useBackstageLightDismiss(panelRef: RefObject<HTMLElement | null>, topRef: RefObject<HTMLElement | null>, onClose: () => void) {
  const close = useLatest(onClose);
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (!target || panelRef.current?.contains(target) || topRef.current?.contains(target) || isAboveBackstage(target)) return;
      close.current();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [close, panelRef, topRef]);
}

/** First item that has content, used when nothing is chosen yet. */
export function defaultBackstageItem(backstage: RibbonBackstage): string | null {
  const preferred = backstage.items.find((entry) => entry.id === backstage.defaultItem && entry.render && !entry.disabled);
  return (preferred ?? backstage.items.find((entry) => entry.render && !entry.disabled))?.id ?? null;
}

/**
 * Full-height file panel over the document: a command list on the left and the
 * chosen item's content on the right. Escape, the back arrow and a press
 * outside it (light dismiss) close it, and focus returns to the control that opened it.
 */
export function BackstageView({ label, backstage, item, onItemChange, onClose, topRef }: BackstageViewProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  useFocusTrap(panelRef, true, { onEscape: onClose });
  useBackstageLightDismiss(panelRef, topRef, onClose);

  useIsomorphicLayoutEffect(() => {
    const update = () => setTop(Math.max(0, topRef.current?.getBoundingClientRect().top ?? 0));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [topRef]);

  const api: BackstageApi = { close: onClose, select: onItemChange };
  const current = backstage.items.find((entry) => entry.id === item && entry.render);
  const backLabel = backstage.backLabel ?? "Back to document";

  const onNavKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled])"));
    if (moveFocus(buttons, document.activeElement, event.key, "vertical") >= 0) event.preventDefault();
  };

  if (typeof document === "undefined") return null;
  return createPortal(
    <div ref={panelRef} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} data-oui-layer="" className="oui-backstage" style={{ top }}>
      <div className="oui-backstage__nav" onKeyDown={onNavKeyDown}>
        <button type="button" className="oui-backstage__back" aria-label={backLabel} title={tooltipFor(backLabel, "Esc")} onClick={onClose}>
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path d="M13 8H3m0 0l4-4M3 8l4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <ul className="oui-backstage__list" role="list">
          {backstage.items.map((entry) => (
            <li key={entry.id}>
              {entry.separatorBefore && <hr className="oui-backstage__separator" />}
              <button
                type="button"
                className={cx("oui-backstage__item", entry.id === current?.id && "is-current")}
                aria-current={entry.id === current?.id ? "page" : undefined}
                aria-keyshortcuts={entry.shortcut}
                title={tooltipFor(entry.label, entry.shortcut)}
                disabled={entry.disabled}
                onClick={() => {
                  if (entry.render) onItemChange(entry.id);
                  if (entry.onSelect) {
                    if (!entry.keepOpen) onClose();
                    entry.onSelect(api);
                  }
                }}
              >
                {entry.icon && <span className="oui-backstage__icon" aria-hidden="true">{entry.icon}</span>}
                <span>{entry.label}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <section className="oui-backstage__content" aria-label={current?.label ?? label}>
        {current?.render?.(api)}
      </section>
    </div>,
    document.body,
  );
}
