import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { chatAgentButtonClass, chatAgentMutedStyle, chatAgentSurfaceStyle } from "../theme.js";

/** One layout/focus owner for Web Canvas, Web Desktop, Electron, and Web Mobile. */
export function BotSettingsLayout({ children, settings, open, onClose, triggerRef, panelId }: {
  children: ReactNode;
  settings: ReactNode;
  open: boolean;
  onClose: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
  panelId: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (!root.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setNarrow(entry.contentRect.width < 880);
    });
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!open) return;
    const opener = triggerRef.current;
    closeButton.current?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, [open, triggerRef]);
  useEffect(() => {
    if (open && narrow && !panel.current?.contains(document.activeElement)) closeButton.current?.focus();
  }, [open, narrow]);
  return <div ref={root} className="matrix-bot-workspace" data-settings-open={open}>
    <div className="matrix-bot-conversation" inert={open && narrow || undefined} aria-hidden={open && narrow || undefined}>
      {children}
    </div>
    {open ? <>
      {narrow ? <button type="button" className="matrix-bot-settings-backdrop" aria-label="Dismiss bot settings" tabIndex={-1} onClick={onClose} /> : null}
      <aside ref={panel} id={panelId} role={narrow ? "dialog" : "complementary"} aria-modal={narrow || undefined}
        aria-label="Bot settings" className="matrix-bot-settings" style={chatAgentSurfaceStyle}
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
          if (!narrow || event.key !== "Tab") return;
          const controls = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled):not([tabindex="-1"]), a[href], input:not(:disabled), textarea:not(:disabled), [tabindex="0"]');
          if (!controls?.length) return;
          const first = controls[0]; const last = controls[controls.length - 1];
          if (!first || !last) return;
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }}>
        <header className="flex shrink-0 items-center justify-between gap-3 px-5 pb-4 pt-5">
          <div><h2 className="text-sm font-semibold">Bot settings</h2><p className="mt-1 text-xs" style={chatAgentMutedStyle}>You're in control of access and memory.</p></div>
          <button ref={closeButton} type="button" aria-label="Close bot settings" className={`${chatAgentButtonClass} !p-2`} onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" /></svg>
          </button>
        </header>
        {settings}
      </aside>
    </> : null}
  </div>;
}
