"use client";

import { useState, useEffect, useEffectEvent, useRef } from "react";
import { useAuth } from "@clerk/nextjs";
import { useWindowManager } from "@/hooks/useWindowManager";
import { useIsClient } from "@/hooks/useIsClient";
import { BatteryFullIcon, SearchIcon, UserIcon, WifiIcon } from "lucide-react";
import { AppSettingsDialog } from "./AppSettingsDialog";
import { useMatrixBillingAccess } from "@/hooks/useMatrixBillingAccess";
import { UserButton } from "./UserButton";
import { ModeSwitcherBar } from "./ModeSwitcherBar";
import { isSelfHostedDocument } from "@/lib/self-host-mode";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import { useOsSessionStore } from "./os-session/os-session-store";
import { useThemeStyle } from "./window/useThemeStyle";

const FALLBACK_APP_ICON = "/icon-192.png";

/** Apple glyph rendered in currentColor for the macOS-glass menu bar. */
function AppleLogoIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.03 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.702" />
    </svg>
  );
}

/** macOS Control Center glyph: two stacked toggle pills. */
function ControlCenterIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true" className={className}>
      <rect x="2.5" y="4.5" width="19" height="6.5" rx="3.25" />
      <circle cx="7.5" cy="7.75" r="2" fill="currentColor" stroke="none" />
      <rect x="2.5" y="13" width="19" height="6.5" rx="3.25" />
      <circle cx="16.5" cy="16.25" r="2" fill="currentColor" stroke="none" />
    </svg>
  );
}

function getBaseAppPath(path: string | null | undefined): string | null {
  if (!path) {
    return null;
  }
  if (path.startsWith("__") && path.includes(":")) {
    return path.split(":")[0] ?? path;
  }
  return path;
}

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

/** macOS menu-bar clock: "Fri 17 Jul  21:45" (weekday, day, month, 24h time). */
function formatMacMenuBarClock(date: Date): string {
  const day = date.toLocaleDateString("en-US", { weekday: "short" });
  const month = date.toLocaleDateString("en-US", { month: "short" });
  const dayNum = date.getDate();
  const time = date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${day} ${dayNum} ${month}  ${time}`;
}

function MenuBarClock({ format = formatMenuBarClock }: { format?: (date: Date) => string }) {
  // SSR-safe wall clock: useIsClient is false during SSR/hydration (so the server and the first
  // client render both emit the non-breaking-space placeholder) and true on the client. The
  // displayed time is derived during render from a `tick` counter that the interval bumps, so the
  // clock advances without seeding state from an effect (no setState-in-effect mount cascade or
  // hydration jump). `tick` is the stable effect dependency, while `now` is re-read each tick.
  const isClient = useIsClient();
  const [tick, setTick] = useState(0);
  const now = isClient ? new Date() : null;

  // react-doctor-disable-next-line react-doctor/no-cascading-set-state -- setTick only fires from setTimeout/setInterval callbacks (never a synchronous cascade); depending on [tick] re-aligns the next timeout to the upcoming minute boundary after each update.
  useEffect(() => {
    if (!isClient) return;
    const stamp = new Date();
    const ms = (60 - stamp.getSeconds()) * 1000 - stamp.getMilliseconds();
    const bump = () => setTick((t) => t + 1);
    const timeout = setTimeout(bump, ms);
    const interval = setInterval(bump, 60_000);
    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
    };
  }, [isClient, tick]);

  return (
    <span className="tabular-nums whitespace-pre">{now ? format(now) : "\u00A0"}</span>
  );
}

function MenuBarUser({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const mounted = useIsClient();

  if (!mounted) {
    return <MenuBarUserPlaceholder />;
  }
  if (isSelfHostedDocument()) {
    return <UserButton variant="menubar" onOpenSettings={onOpenSettings} />;
  }

  return <AuthenticatedMenuBarUser onOpenSettings={onOpenSettings} />;
}

function MenuBarUserPlaceholder() {
  return (
    <div className="px-1 py-0.5 rounded hover:bg-foreground/10">
      <UserIcon className="size-[14px] text-foreground/70" />
    </div>
  );
}

function AuthenticatedMenuBarUser({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const { isLoaded, isSignedIn } = useAuth();
  const { active: billingActive } = useMatrixBillingAccess();

  if (!isLoaded || !isSignedIn) {
    return <MenuBarUserPlaceholder />;
  }

  // Only surface a billing chip when action is required. An active subscription
  // is the expected state — a loud "Active" badge is just noise in the menubar,
  // so we stay quiet and let billing live in Settings. When access is missing we
  // show a single, calm, clickable call-to-action that opens billing settings.
  const needsBilling = billingActive === false;

  return (
    <div className="flex items-center gap-1.5">
      {needsBilling ? (
        <button
          type="button"
          onClick={onOpenSettings}
          title="Set up billing"
          aria-label="Set up billing"
          className="group hidden h-5 items-center gap-1.5 rounded-full border border-amber-500/25 bg-amber-500/10 px-2 text-[11px] font-medium leading-none text-amber-700 transition-colors hover:bg-amber-500/20 dark:text-amber-300 sm:inline-flex"
        >
          <span className="size-1.5 rounded-full bg-amber-500" aria-hidden="true" />
          Set up billing
        </button>
      ) : null}
      <UserButton variant="menubar" onOpenSettings={onOpenSettings} />
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
  bold,
  ariaLabel,
}: {
  label: React.ReactNode;
  items: MenuEntry[];
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  bold?: boolean;
  ariaLabel?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseEvent = useEffectEvent(onClose);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onCloseEvent();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseEvent();
    };
    document.addEventListener("pointerdown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={onToggle}
        aria-label={ariaLabel}
        className={`px-2 py-0.5 rounded ${bold ? "font-semibold text-foreground/80" : "text-foreground/60"} ${open ? "bg-foreground/10 text-foreground/90" : "hover:bg-foreground/10"}`}
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
                key={`item-${item.label}`}
                type="button"
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

export function MenuBar({ onOpenCommandPalette, onNewWindow, onMinimizeWindow, onOpenSettings, children }: { onOpenCommandPalette: () => void; onNewWindow: () => void; onMinimizeWindow?: (id: string) => void; onOpenSettings?: () => void; children?: React.ReactNode }) {
  const windows = useWindowManager((s) => s.windows);
  const apps = useWindowManager((s) => s.apps);
  const focusedWindowId = useWindowManager((s) => s.focusedWindowId);
  const closeWindow = useWindowManager((s) => s.closeWindow);
  const wmMinimize = useWindowManager((s) => s.minimizeWindow);
  const themeStyle = useThemeStyle();
  const isMacGlass = themeStyle === "macos-glass";
  const minimizeWindow = onMinimizeWindow ?? wmMinimize;
  const focusedWindow = focusedWindowId
    ? windows.find((w) => w.id === focusedWindowId && !w.minimized)
    : undefined;
  const focusedAppPath = getBaseAppPath(focusedWindow?.path);
  const focusedApp = apps.find((app) => app.path === focusedAppPath);
  const activeAppName = focusedApp?.name ?? focusedWindow?.title ?? "Matrix OS";
  const activeAppIconUrl = focusedApp?.iconUrl ?? FALLBACK_APP_ICON;
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [appSettingsOpen, setAppSettingsOpen] = useState(false);
  const closeMenu = () => setOpenMenu(null);
  const toggleMenu = (name: string) => {
    setOpenMenu((prev) => (prev === name ? null : name));
  };
  const openAppSettings = () => {
    setAppSettingsOpen(true);
  };
  const appItems: MenuEntry[] = [
    { label: "Settings…", shortcut: "⌘,", action: openAppSettings },
  ];

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
      try {
        const text = await navigator.clipboard.readText();
        document.execCommand("insertText", false, text);
      } catch (err: unknown) {
        console.warn("[menu] Clipboard paste was denied or unavailable:", err);
      }
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
      useWindowManager.getState().toggleFullscreen(focusedWindow.id);
    }},
    { separator: true },
    { label: "Command Palette", shortcut: "⌘K", action: onOpenCommandPalette },
  ];

  /* macOS-glass only: Apple menu (system-level affordances), Window menu
     (window management), Help menu (discoverability). Every item is wired to
     an existing working handler — no decorative menus. Lock Screen / Log Out…
     sit at the bottom like the real macOS Apple menu and open the simulated
     lock screen via the os-session store (never a real Clerk sign-out). */
  const appleItems: MenuEntry[] = [
    ...(onOpenSettings
      ? [
          { label: "System Settings…", action: onOpenSettings },
          { separator: true } as MenuEntry,
        ]
      : []),
    { label: "Command Palette", shortcut: "⌘K", action: onOpenCommandPalette },
    { separator: true },
    { label: "Lock Screen", action: () => useOsSessionStore.getState().openMacosLock() },
    { label: "Log Out…", action: () => useOsSessionStore.getState().openMacosLock() },
  ];

  const windowItems: MenuEntry[] = [
    { label: "Minimize", shortcut: "⌘M", action: () => { if (focusedWindow) minimizeWindow(focusedWindow.id); } },
    { label: "Zoom", action: () => {
      if (!focusedWindow) return;
      useWindowManager.getState().toggleFullscreen(focusedWindow.id);
    }},
  ];

  const helpItems: MenuEntry[] = [
    { label: "Matrix OS Help", shortcut: "⌘K", action: onOpenCommandPalette },
  ];

  const macGlassMenuBar = isMacGlass ? (
    <header data-menu-bar className="fixed top-0 inset-x-0 hidden md:grid grid-cols-[1fr_auto_1fr] h-8 items-center px-3 text-[13px] leading-8 select-none bg-card/60 backdrop-blur-xl border-b border-border/30 shadow-sm" style={{ zIndex: SHELL_Z_INDEX.menuBar }}>
      {/* Left: Apple menu + bold app menu + global menus */}
      <div className="flex items-center gap-0.5 font-medium">
        <MenuDropdown label={<AppleLogoIcon className="size-3.5" />} ariaLabel="Apple menu" items={appleItems} open={openMenu === "apple"} onToggle={() => toggleMenu("apple")} onClose={closeMenu} />
        <MenuDropdown label={activeAppName} items={appItems} open={openMenu === "app"} onToggle={() => toggleMenu("app")} onClose={closeMenu} bold />
        <MenuDropdown label="File" items={fileItems} open={openMenu === "file"} onToggle={() => toggleMenu("file")} onClose={closeMenu} />
        <MenuDropdown label="Edit" items={editItems} open={openMenu === "edit"} onToggle={() => toggleMenu("edit")} onClose={closeMenu} />
        <MenuDropdown label="View" items={viewItems} open={openMenu === "view"} onToggle={() => toggleMenu("view")} onClose={closeMenu} />
        <MenuDropdown label="Window" items={windowItems} open={openMenu === "window"} onToggle={() => toggleMenu("window")} onClose={closeMenu} />
        <MenuDropdown label="Help" items={helpItems} open={openMenu === "help"} onToggle={() => toggleMenu("help")} onClose={closeMenu} />
      </div>

      {/* Center: mode switcher + contextual toolbar controls — always centered via grid */}
      <div className="flex items-center gap-0.5 text-foreground/70 [&_button]:text-foreground/60 [&_button:hover]:text-foreground/90 [&_button]:transition-colors [&_.w-px]:bg-foreground/10 [&_.w-px]:h-3">
        <ModeSwitcherBar />
        {children}
      </div>

      {/* Right: status icons + Control Center + clock + fast-user-switching avatar */}
      <div className="flex items-center gap-0.5 justify-end text-foreground/70">
        <span className="flex items-center px-1" aria-hidden="true">
          <BatteryFullIcon className="size-4" />
        </span>
        <span className="flex items-center px-1" aria-hidden="true">
          <WifiIcon className="size-3.5" />
        </span>
        <button
          type="button"
          className="px-1.5 py-0.5 rounded hover:bg-foreground/10"
          onClick={onOpenCommandPalette}
          title="Spotlight (Cmd+K)"
          aria-label="Spotlight search"
        >
          <SearchIcon className="size-3.5" />
        </button>
        {onOpenSettings ? (
          <button
            type="button"
            className="px-1.5 py-0.5 rounded hover:bg-foreground/10"
            onClick={onOpenSettings}
            title="Control Center"
            aria-label="Control Center"
          >
            <ControlCenterIcon className="size-3.5" />
          </button>
        ) : (
          <span className="flex items-center px-1" aria-hidden="true">
            <ControlCenterIcon className="size-3.5" />
          </span>
        )}
        <button type="button" className="px-2 py-0.5 rounded hover:bg-foreground/10 text-foreground/80">
          <MenuBarClock format={formatMacMenuBarClock} />
        </button>
        <div className="pl-0.5">
          <MenuBarUser onOpenSettings={onOpenSettings} />
        </div>
      </div>
    </header>
  ) : null;

  return (
    <>
      {macGlassMenuBar ?? (
      <header data-menu-bar className="fixed top-0 inset-x-0 z-[60] hidden md:grid grid-cols-[1fr_auto_1fr] h-8 items-center px-3 text-[13px] leading-8 select-none bg-card/60 backdrop-blur-xl border-b border-border/30 shadow-sm">
        {/* Left: app icon + app menu + global menus */}
        <div className="flex items-center gap-0.5">
          <div className="flex items-center px-2 py-0.5 rounded">
            {/* react-doctor-disable-next-line react-doctor/nextjs-no-img-element -- active app icon served from a runtime gateway host (/icons/{slug}.png) that cannot be statically configured for next/image */}
            <img
              key={activeAppIconUrl}
              src={activeAppIconUrl}
              alt=""
              className="size-4 rounded-[4px] object-cover"
              onError={(event) => {
                const img = event.currentTarget;
                img.onerror = null;
                img.src = FALLBACK_APP_ICON;
              }}
            />
          </div>
          <MenuDropdown label={activeAppName} items={appItems} open={openMenu === "app"} onToggle={() => toggleMenu("app")} onClose={closeMenu} />
          <div className="mx-1 h-3 w-px bg-border/40" />
          <MenuDropdown label="File" items={fileItems} open={openMenu === "file"} onToggle={() => toggleMenu("file")} onClose={closeMenu} />
          <MenuDropdown label="Edit" items={editItems} open={openMenu === "edit"} onToggle={() => toggleMenu("edit")} onClose={closeMenu} />
          <MenuDropdown label="View" items={viewItems} open={openMenu === "view"} onToggle={() => toggleMenu("view")} onClose={closeMenu} />
        </div>

        {/* Center: mode switcher + contextual toolbar controls — always centered via grid */}
        <div className="flex items-center gap-0.5 text-foreground/70 [&_button]:text-foreground/60 [&_button:hover]:text-foreground/90 [&_button]:transition-colors [&_.w-px]:bg-foreground/10 [&_.w-px]:h-3">
          <ModeSwitcherBar />
          {children}
        </div>

        {/* Right: Search + clock + user */}
        <div className="flex items-center gap-1 justify-end">
          <button
            type="button"
            className="px-1.5 py-0.5 rounded hover:bg-foreground/10"
            onClick={onOpenCommandPalette}
            title="Search (Cmd+K)"
          >
            <SearchIcon className="size-3.5 text-foreground/70" />
          </button>
          <button type="button" className="px-2 py-0.5 rounded hover:bg-foreground/10 text-foreground/80">
            <MenuBarClock />
          </button>
          <div className="pl-0.5">
            <MenuBarUser onOpenSettings={onOpenSettings} />
          </div>
        </div>
      </header>
      )}
      <AppSettingsDialog
        open={appSettingsOpen}
        onOpenChange={setAppSettingsOpen}
        appName={activeAppName}
        appPath={focusedAppPath}
        iconUrl={activeAppIconUrl}
      />
    </>
  );
}
