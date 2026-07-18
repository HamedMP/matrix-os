"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useFileBrowser } from "@/hooks/useFileBrowser";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import {
  XpComputerGlyph,
  XpFolderGlyph,
  XpRecycleBinGlyph,
} from "../file-browser/xp-icons";
import { useThemeStyle } from "../window/useThemeStyle";
import "./xp-desktop-icons.css";

/**
 * Windows XP desktop icons (My Computer / My Documents / Recycle Bin).
 * Rendered by Desktop.tsx inside the desktop surface; sits above the Bliss
 * wallpaper but below app windows. Only visible while the winxp design is
 * active — every other design renders nothing, like WindowsTaskbar.
 *
 * Single click selects, double-click opens. Every open goes through the same
 * `onOpenApp` handler the taskbar uses, and the target view inside the Files
 * app is requested through the shared file-browser store (`requestView`), so
 * the Recycle Bin lands in the trash view exactly like the explorer's Trash
 * link and My Computer / My Documents land on the home folder.
 */

type XpDesktopIconId = "my-computer" | "my-documents" | "recycle-bin";

/** Keyboard/roving order; layout positions are set per-icon in CSS. */
const ICON_ORDER: readonly XpDesktopIconId[] = ["my-computer", "my-documents", "recycle-bin"];

interface XpDesktopIconsProps {
  /** Same open/focus handler Desktop.tsx passes to the Windows taskbar. */
  onOpenApp: (path: string, name?: string) => void;
}

export function XpDesktopIcons({ onOpenApp }: XpDesktopIconsProps) {
  const themeStyle = useThemeStyle();
  const navigate = useFileBrowser((s) => s.navigate);
  const requestView = useFileBrowser((s) => s.requestView);
  const [selectedId, setSelectedId] = useState<XpDesktopIconId | null>(null);
  const layerRef = useRef<HTMLDivElement>(null);

  // Real XP clears the icon selection when the empty desktop is clicked. The
  // layer itself is pointer-events-none so those clicks still reach the
  // desktop/canvas below; watch document-level pointer downs instead and
  // clear whenever the press lands outside the icons.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (layerRef.current?.contains(target)) return;
      setSelectedId(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  const openIcon = (id: XpDesktopIconId) => {
    if (id === "recycle-bin") {
      requestView("trash");
    } else {
      navigate("");
      requestView("files");
    }
    onOpenApp("__file-browser__", "Files");
  };

  const selectAndFocus = (id: XpDesktopIconId) => {
    setSelectedId(id);
    layerRef.current
      ?.querySelector<HTMLElement>(`[data-xp-desktop-icon="${id}"]`)
      ?.focus();
  };

  const onIconKeyDown = (e: React.KeyboardEvent, id: XpDesktopIconId) => {
    if (e.key === "Escape") {
      setSelectedId(null);
      return;
    }
    if (e.key === "Enter") {
      // Suppress the native button click activation: Enter opens, it does not
      // select. Falls back to the focused icon when nothing is selected yet.
      e.preventDefault();
      openIcon(selectedId ?? id);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowLeft") {
      e.preventDefault();
      const delta = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1;
      const current = selectedId ?? id;
      const idx = ICON_ORDER.indexOf(current);
      const next = Math.min(ICON_ORDER.length - 1, Math.max(0, idx + delta));
      selectAndFocus(ICON_ORDER[next]);
    }
  };

  if (themeStyle !== "winxp") return null;

  return (
    <div
      ref={layerRef}
      className="xp-desktop-icons"
      data-xp-desktop-icons
      style={{ zIndex: SHELL_Z_INDEX.desktopIcons }}
    >
      <div className="xp-desktop-icons-column">
        <XpDesktopIcon
          id="my-computer"
          label="My Computer"
          glyph={<XpComputerGlyph size={32} />}
          selected={selectedId === "my-computer"}
          onSelect={() => setSelectedId("my-computer")}
          onOpen={() => openIcon("my-computer")}
          onKeyDown={onIconKeyDown}
        />
        <XpDesktopIcon
          id="my-documents"
          label="My Documents"
          glyph={<XpFolderGlyph size={32} />}
          selected={selectedId === "my-documents"}
          onSelect={() => setSelectedId("my-documents")}
          onOpen={() => openIcon("my-documents")}
          onKeyDown={onIconKeyDown}
        />
      </div>
      <XpDesktopIcon
        id="recycle-bin"
        label="Recycle Bin"
        className="xp-desktop-icon--recycle-bin"
        glyph={<XpRecycleBinGlyph size={32} />}
        selected={selectedId === "recycle-bin"}
        onSelect={() => setSelectedId("recycle-bin")}
        onOpen={() => openIcon("recycle-bin")}
        onKeyDown={onIconKeyDown}
      />
    </div>
  );
}

interface XpDesktopIconProps {
  id: XpDesktopIconId;
  label: string;
  glyph: ReactNode;
  selected: boolean;
  className?: string;
  onSelect: () => void;
  onOpen: () => void;
  onKeyDown: (e: React.KeyboardEvent, id: XpDesktopIconId) => void;
}

function XpDesktopIcon({
  id,
  label,
  glyph,
  selected,
  className,
  onSelect,
  onOpen,
  onKeyDown,
}: XpDesktopIconProps) {
  return (
    <button
      type="button"
      className={className ? `xp-desktop-icon ${className}` : "xp-desktop-icon"}
      data-xp-desktop-icon={id}
      data-selected={selected || undefined}
      aria-label={label}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onKeyDown={(e) => onKeyDown(e, id)}
    >
      <span className="xp-desktop-icon-glyph">{glyph}</span>
      <span className="xp-desktop-icon-label">{label}</span>
    </button>
  );
}
