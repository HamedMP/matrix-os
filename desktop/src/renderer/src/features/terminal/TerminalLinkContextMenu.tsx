import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Copy, ExternalLink, TextSelect } from "lucide-react";
import type { TerminalLinkEntry } from "./terminal-link-actions";

export interface DesktopTerminalMenuState {
  x: number;
  y: number;
  link: TerminalLinkEntry | null;
  selection: string;
}

interface TerminalLinkContextMenuProps {
  menu: DesktopTerminalMenuState | null;
  onClose: () => void;
  onOpen: (link: TerminalLinkEntry) => void;
  onCopy: (link: TerminalLinkEntry) => void;
  onCopySelection: (selection: string) => void;
  onSelectAll: () => void;
}

function openLabel(link: TerminalLinkEntry): string {
  return link.kind === "web" ? "Open Link" : `Sign in with ${link.providerLabel}`;
}

export default function TerminalLinkContextMenu({
  menu,
  onClose,
  onOpen,
  onCopy,
  onCopySelection,
  onSelectAll,
}: TerminalLinkContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const firstActionRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menu) return;
    firstActionRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [menu, onClose]);

  if (!menu) return null;

  const x = Math.max(8, Math.min(menu.x, window.innerWidth - 228));
  const y = Math.max(8, Math.min(menu.y, window.innerHeight - (menu.link ? 248 : 104)));
  const perform = (action: (link: TerminalLinkEntry) => void) => {
    if (menu.link) action(menu.link);
    onClose();
  };
  const performSelectionCopy = () => {
    if (menu.selection) onCopySelection(menu.selection);
    onClose();
  };
  const performSelectAll = () => {
    onSelectAll();
    onClose();
  };
  const itemClass =
    "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm outline-none transition-colors hover:bg-[var(--bg-hover)] focus:bg-[var(--bg-hover)]";

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label="Terminal actions"
      className="fade-in fixed z-[100] w-[220px] overflow-hidden rounded-lg border p-1"
      style={{
        left: x,
        top: y,
        color: "var(--text-primary)",
        background: "var(--bg-overlay)",
        borderColor: "var(--border-default)",
        boxShadow: "var(--shadow-2)",
      }}
    >
      {menu.link ? (
        <div className="border-b px-2 py-1.5" style={{ borderColor: "var(--border-subtle)" }}>
          <div className="truncate text-xs font-semibold">
            {menu.link.kind === "web" ? menu.link.hostname : menu.link.providerLabel}
          </div>
          <div className="truncate text-[11px]" style={{ color: "var(--text-tertiary)" }}>
            {menu.link.displayPath}
          </div>
        </div>
      ) : null}
      <button
        ref={menu.selection ? firstActionRef : undefined}
        type="button"
        role="menuitem"
        aria-label="Copy"
        disabled={!menu.selection}
        onClick={performSelectionCopy}
        className={`${itemClass} disabled:opacity-40`}
      >
        <Copy aria-hidden="true" className="size-4" style={{ color: "var(--text-tertiary)" }} />
        Copy
      </button>
      <button
        ref={menu.selection ? undefined : firstActionRef}
        type="button"
        role="menuitem"
        aria-label="Select All"
        onClick={performSelectAll}
        className={itemClass}
      >
        <TextSelect aria-hidden="true" className="size-4" style={{ color: "var(--text-tertiary)" }} />
        Select All
      </button>
      {menu.link ? (
        <>
          <div className="my-1 border-t" style={{ borderColor: "var(--border-subtle)" }} />
          <button
            type="button"
            role="menuitem"
            aria-label={openLabel(menu.link)}
            onClick={() => perform(onOpen)}
            className={itemClass}
          >
            <ExternalLink aria-hidden="true" className="size-4" style={{ color: "var(--text-tertiary)" }} />
            {openLabel(menu.link)}
          </button>
          <button
            type="button"
            role="menuitem"
            aria-label="Copy Link"
            onClick={() => perform(onCopy)}
            className={itemClass}
          >
            <Copy aria-hidden="true" className="size-4" style={{ color: "var(--text-tertiary)" }} />
            Copy Link
          </button>
        </>
      ) : null}
    </div>,
    document.body,
  );
}
