"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { UserButton as ClerkUserButton, useAuth } from "@clerk/nextjs";
import { useWindowManager } from "@/hooks/useWindowManager";
import { SearchIcon, UserIcon } from "lucide-react";
import { GroupSwitcher } from "./GroupSwitcher";

function formatMenuBarClock(date: Date): string {
  const day = date.toLocaleDateString("en-US", { weekday: "short" });
  const month = date.toLocaleDateString("en-US", { month: "short" });
  const dayNum = date.getDate();
  const time = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return `${day} ${month} ${dayNum}  ${time}`;
}

function MenuBarClock() {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
  }, []);

  useEffect(() => {
    if (!now) return;
    const ms = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
    const timeout = setTimeout(() => {
      setNow(new Date());
    }, ms);
    const interval = setInterval(() => setNow(new Date()), 60_000);
    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
    };
  }, [now]);

  return (
    <span className="tabular-nums whitespace-pre">{now ? formatMenuBarClock(now) : "\u00A0"}</span>
  );
}

function MenuBarUser() {
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded || !isSignedIn) {
    return (
      <div className="px-1 py-0.5 rounded hover:bg-foreground/10">
        <UserIcon className="size-[14px] text-foreground/70" />
      </div>
    );
  }

  return (
    <div className="flex items-center [&_.cl-avatarBox]:!size-[18px] [&_.cl-userButtonTrigger]:!p-0 [&_.cl-userButtonTrigger]:!rounded-full [&_.cl-userButtonTrigger]:!shadow-none [&_.cl-userButtonTrigger]:!border-0">
      <ClerkUserButton
        appearance={{
          elements: {
            avatarBox: "!w-[18px] !h-[18px] !min-w-[18px] !min-h-[18px]",
            userButtonTrigger: "!p-0 !rounded-full !shadow-none !border-0",
          },
        }}
        afterSignOutUrl="https://app.matrix-os.com/sign-in"
      />
    </div>
  );
}

/* ── Dropdown Menu ───────────────────────────── */

interface MenuItem {
  label: string;
  shortcut?: string;
  action: () => void;
  separator?: false;
}

interface MenuSeparator {
  separator: true;
}

type MenuEntry = MenuItem | MenuSeparator;

function MenuDropdown({
  label,
  items,
  open,
  onToggle,
  onClose,
}: {
  label: string;
  items: MenuEntry[];
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={onToggle}
        className={`px-2 py-0.5 rounded text-foreground/60 ${open ? "bg-foreground/10 text-foreground/90" : "hover:bg-foreground/10"}`}
      >
        {label}
      </button>
      {open && (
        <div data-menu-dropdown className="absolute top-full left-0 mt-0.5 min-w-[180px] py-1 rounded-lg bg-card/90 backdrop-blur-xl border border-border/40 shadow-xl z-[65]">
          {items.map((item, i) =>
            item.separator ? (
              <div key={i} className="my-1 border-t border-border/40" />
            ) : (
              <button
                key={i}
                onClick={() => { item.action(); onClose(); }}
                className="flex w-full items-center justify-between px-3 py-1 text-[13px] text-foreground/80 hover:bg-primary/10 hover:text-foreground"
              >
                <span>{item.label}</span>
                {item.shortcut && (
                  <span className="ml-4 text-[11px] text-foreground/40">{item.shortcut}</span>
                )}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/* ── Menu Bar ────────────────────────────────── */

export function MenuBar({ onOpenCommandPalette, onNewWindow, onMinimizeWindow, children }: { onOpenCommandPalette: () => void; onNewWindow: () => void; onMinimizeWindow?: (id: string) => void; children?: React.ReactNode }) {
  const windows = useWindowManager((s) => s.windows);
  const closeWindow = useWindowManager((s) => s.closeWindow);
  const wmMinimize = useWindowManager((s) => s.minimizeWindow);
  const minimizeWindow = onMinimizeWindow ?? wmMinimize;
  const focusedWindow = windows
    .filter((w) => !w.minimized)
    .sort((a, b) => b.zIndex - a.zIndex)[0];

  const activeAppName = focusedWindow?.title ?? "Matrix OS";

  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const closeMenu = useCallback(() => setOpenMenu(null), []);
  const toggleMenu = useCallback((name: string) => {
    setOpenMenu((prev) => (prev === name ? null : name));
  }, []);

  const fileItems: MenuEntry[] = [
    { label: "New Window", shortcut: "⌘N", action: onNewWindow },
    { separator: true },
    { label: "Close Window", shortcut: "⌘W", action: () => { if (focusedWindow) closeWindow(focusedWindow.id); } },
    { label: "Minimize", shortcut: "⌘M", action: () => { if (focusedWindow) minimizeWindow(focusedWindow.id); } },
  ];

  const editItems: MenuEntry[] = [
    { label: "Undo", shortcut: "⌘Z", action: () => document.execCommand("undo") },
    { label: "Redo", shortcut: "⇧⌘Z", action: () => document.execCommand("redo") },
    { separator: true },
    { label: "Cut", shortcut: "⌘X", action: async () => {
      const sel = window.getSelection();
      if (sel?.toString()) { await navigator.clipboard.writeText(sel.toString()); document.execCommand("delete"); }
    }},
    { label: "Copy", shortcut: "⌘C", action: async () => {
      const sel = window.getSelection();
      if (sel?.toString()) await navigator.clipboard.writeText(sel.toString());
    }},
    { label: "Paste", shortcut: "⌘V", action: async () => {
      try { const text = await navigator.clipboard.readText(); document.execCommand("insertText", false, text); } catch { /* denied */ }
    }},
    { separator: true },
    { label: "Select All", shortcut: "⌘A", action: () => document.execCommand("selectAll") },
  ];

  const viewItems: MenuEntry[] = [
    { label: "Reload App", shortcut: "⌘R", action: () => {
      if (!focusedWindow) return;
      const iframe = document.querySelector(`[data-window-id="${focusedWindow.id}"] iframe`) as HTMLIFrameElement | null;
      if (iframe) iframe.src = iframe.src;
    }},
    { separator: true },
    { label: "Enter Full Screen", shortcut: "⌃⌘F", action: () => {
      if (!focusedWindow) return;
      const el = document.querySelector(`[data-window-id="${focusedWindow.id}"]`) as HTMLElement | null;
      if (el) el.requestFullscreen?.();
    }},
    { separator: true },
    { label: "Command Palette", shortcut: "⌘K", action: onOpenCommandPalette },
  ];

  return (
    <header data-menu-bar className="fixed top-0 inset-x-0 z-[60] hidden md:grid grid-cols-[1fr_auto_1fr] h-7 items-center px-3 text-[13px] leading-7 select-none bg-card/60 backdrop-blur-xl border-b border-border/30 shadow-sm">
      {/* Left: Logo + active app name + menus */}
      <div className="flex items-center gap-0.5">
        <button className="flex items-center px-2 py-0.5 rounded hover:bg-foreground/10">
          <img src="/logo.png" alt="" className="size-4 rounded-[3px]" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
        </button>
        <span className="px-1.5 py-0.5 font-semibold text-foreground/90 truncate max-w-[200px]">
          {activeAppName}
        </span>
        <div className="w-px h-3 bg-foreground/10 mx-0.5" />
        <GroupSwitcher />
        <div className="w-px h-3 bg-foreground/10 mx-0.5" />
        <MenuDropdown label="File" items={fileItems} open={openMenu === "file"} onToggle={() => toggleMenu("file")} onClose={closeMenu} />
        <MenuDropdown label="Edit" items={editItems} open={openMenu === "edit"} onToggle={() => toggleMenu("edit")} onClose={closeMenu} />
        <MenuDropdown label="View" items={viewItems} open={openMenu === "view"} onToggle={() => toggleMenu("view")} onClose={closeMenu} />
      </div>

      {/* Center: contextual toolbar controls — always centered via grid */}
      <div className="flex items-center gap-0.5 text-foreground/70 [&_button]:text-foreground/60 [&_button:hover]:text-foreground/90 [&_button]:transition-colors [&_.w-px]:bg-foreground/10 [&_.w-px]:h-3">
        {children}
      </div>

      {/* Right: Search + clock + user */}
      <div className="flex items-center gap-1 justify-end">
        <button
          className="px-1.5 py-0.5 rounded hover:bg-foreground/10"
          onClick={onOpenCommandPalette}
          title="Search (Cmd+K)"
        >
          <SearchIcon className="size-3.5 text-foreground/70" />
        </button>
        <button className="px-2 py-0.5 rounded hover:bg-foreground/10 text-foreground/80">
          <MenuBarClock />
        </button>
        <div className="pl-0.5">
          <MenuBarUser />
        </div>
      </div>
    </header>
  );
}
