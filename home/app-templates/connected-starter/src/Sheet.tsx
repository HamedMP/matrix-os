import { useEffect, useRef } from "react";
const focusable = "button:not(:disabled),input:not(:disabled):not([type=hidden]),textarea:not(:disabled),select:not(:disabled),a[href]";
export default function Sheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const opener = useRef(document.activeElement), dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    dialog.current?.querySelector<HTMLElement>("button")?.focus();
    return () => {
      const candidates = [opener.current, ...document.querySelectorAll<HTMLElement>(focusable)];
      for (const target of candidates) {
        if (!(target instanceof HTMLElement) || !target.isConnected || target.matches(":disabled") || dialog.current?.contains(target) || target.closest("[hidden],[inert],[aria-hidden=true]")) continue;
        target.focus(); if (document.activeElement === target) return;
      }
      const previous = document.body.getAttribute("tabindex"); document.body.tabIndex = -1; document.body.focus(); if (previous === null) document.body.removeAttribute("tabindex"); else document.body.setAttribute("tabindex", previous);
    };
  }, []);
  return (
    <div className="backdrop" onClick={onClose}>
      <section
        ref={dialog}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Tab") {
            const items = Array.from(
              e.currentTarget.querySelectorAll<HTMLElement>(
                focusable,
              ),
            );
            const first = items[0],
              last = items[items.length - 1];
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last?.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <header>
          <h2>{title}</h2>
          <button aria-label="Close dialog" onClick={onClose}>
            ×
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
