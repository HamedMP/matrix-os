"use client";

/**
 * MobileShell — iOS/Android-style single-app-fullscreen shell rendered when
 * the viewport is phone-sized. Replaces Desktop on mobile.
 *
 * Why a separate component (instead of a "mobile" mode inside Desktop.tsx):
 * Desktop.tsx is ~2k lines of desktop-window-manager logic (drag, resize,
 * z-order, dock cascading). On a phone there is no concept of overlapping
 * windows — the right primitive is the OS itself: one foreground app, a
 * launcher, a dock, an app switcher.
 *
 * State scope:
 * - This shell owns its own foreground-app state. It does *not* drive
 *   useWindowManager.windows, because saving a layout from mobile would
 *   immediately rearrange the user's desktop on the next desktop session.
 * - It does fetch the same /api/apps registry as Desktop so users see the
 *   apps they've installed.
 */

import type { CSSProperties } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useChatContext } from "@/stores/chat-context";
import { iconUrlForSlug } from "@/lib/app-launch";
import { getGatewayUrl } from "@/lib/gateway";
import { nameToSlug } from "@/lib/utils";
import { TerminalApp } from "@/components/terminal/TerminalApp";
import { FileBrowser } from "@/components/file-browser/FileBrowser";
import { ChatApp } from "@/components/ChatApp";
import { AppViewer } from "@/components/AppViewer";
import { Settings } from "@/components/Settings";
import { WorkspaceApp } from "@/components/workspace/WorkspaceApp";
import { PreviewWindow } from "@/components/preview-window/PreviewWindow";

interface MobileApp {
  id: string;
  name: string;
  path: string;
  iconSlug: string;
}

interface OpenApp {
  id: string;
  app: MobileApp;
  openedAt: number;
}

const FETCH_TIMEOUT_MS = 10_000;
const MAX_TERMINAL_INSTANCES = 5;

const BUILT_IN_APPS: MobileApp[] = [
  { id: "terminal", name: "Terminal", path: "__terminal__", iconSlug: "terminal" },
  { id: "files", name: "Files", path: "__file-browser__", iconSlug: "folder" },
  { id: "chat", name: "Hermes", path: "__chat__", iconSlug: "chat" },
];

const LAUNCHER_APP_BUTTON_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 6,
  background: "transparent",
  border: "none",
  color: "inherit",
  cursor: "pointer",
  padding: 0,
};

const LAUNCHER_APP_LABEL_STYLE: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.2,
  textAlign: "center",
  maxWidth: 70,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const SWITCHER_CLOSE_BUTTON_STYLE: CSSProperties = {
  background: "transparent",
  border: "1px solid rgba(244,237,224,0.18)",
  color: "inherit",
  borderRadius: 999,
  width: 28,
  height: 28,
  cursor: "pointer",
  opacity: 0.75,
  fontSize: 12,
};

const SWITCHER_RESUME_BUTTON_STYLE: CSSProperties = {
  alignSelf: "center",
  marginTop: 4,
  background: "var(--primary, #c2703a)",
  color: "var(--primary-foreground, #fff)",
  border: "none",
  borderRadius: 999,
  padding: "10px 18px",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

const DOCK_BUTTON_BASE_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 2,
  background: "transparent",
  border: "none",
  color: "inherit",
  padding: "4px 10px",
  position: "relative",
  cursor: "pointer",
};

const DOCK_BADGE_STYLE: CSSProperties = {
  position: "absolute",
  top: 2,
  right: 6,
  background: "var(--primary, #c2703a)",
  color: "white",
  fontSize: 12,
  fontWeight: 700,
  borderRadius: 999,
  padding: "1px 5px",
  lineHeight: 1.2,
};

interface MobileShellProps {
  launchAppPath?: string | null;
  onOpenCommandPalette?: () => void;
}

// react-doctor-disable-next-line react-doctor/prefer-useReducer -- the five states (apps, openStack, view, settingsOpen, time) are independent concerns with separate update sites and lifecycles (registry load, foreground stack, view mode, settings dialog, clock tick), not one related state machine; collapsing them into a reducer would couple unrelated transitions and is not a mechanical, behavior-identical change.
export function MobileShell({ launchAppPath, onOpenCommandPalette }: MobileShellProps) {
  const chat = useChatContext();

  const [apps, setApps] = useState<MobileApp[]>(BUILT_IN_APPS);
  const [openStack, setOpenStack] = useState<OpenApp[]>([]);
  const [view, setView] = useState<"launcher" | "app" | "switcher">("launcher");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [time, setTime] = useState("--:--");
  const stackRef = useRef(openStack);
  const launchPathConsumedRef = useRef<string | null>(null);
  useEffect(() => {
    stackRef.current = openStack;
  }, [openStack]);

  const top = openStack[openStack.length - 1];

  useEffect(() => {
    const tick = () => setTime(formatClock(new Date()));
    tick();
    const id = window.setInterval(tick, 30_000);
    return () => window.clearInterval(id);
  }, []);

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- guarded mount load of the installed-apps registry: it runs once on mount, aborts via AbortSignal.timeout, and is cancellation-guarded by the `cancelled` flag in cleanup. A data-fetching library would be overkill for this single shell-bootstrap read.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${getGatewayUrl()}/api/apps`, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) return;
        const list = (await res.json()) as { name: string; path: string; icon?: string }[];
        if (cancelled) return;
        const installed: MobileApp[] = list.map((a) => {
          const relative = a.path.replace(/^\/files\//, "");
          return {
            id: `app:${relative}`,
            name: a.name,
            path: relative,
            iconSlug: a.icon ?? nameToSlug(a.name),
          };
        });
        setApps((prev) => {
          const seen = new Set(prev.map((p) => p.path));
          const merged = [...prev];
          for (const a of installed) {
            if (!seen.has(a.path)) merged.push(a);
          }
          return merged;
        });
      } catch (err: unknown) {
        console.warn("[mobile-shell] failed to load /api/apps:", err instanceof Error ? err.message : err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- stable identity is consumed by the launch-path useEffect dependency array below; removing useCallback would re-run that effect on every render and could re-open the launch app.
  const openApp = useCallback((app: MobileApp) => {
    setOpenStack((prev) => {
      // Bring existing instance to the front rather than open a duplicate
      // (terminals are the only deliberately-multi-instance case and we
      // special-case them).
      if (app.path === "__terminal__") {
        const terminalInstances = prev.filter((entry) => entry.app.path === "__terminal__");
        if (terminalInstances.length >= MAX_TERMINAL_INSTANCES) {
          const latestTerminal = terminalInstances[terminalInstances.length - 1];
          return [...prev.filter((entry) => entry.id !== latestTerminal.id), latestTerminal];
        }
        const id = `term:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        return [...prev, { id, app, openedAt: Date.now() }];
      }
      const existing = prev.findIndex((o) => o.app.path === app.path);
      if (existing >= 0) {
        const next = prev.slice();
        const [taken] = next.splice(existing, 1);
        next.push(taken);
        return next;
      }
      const id = `${app.id}:${Date.now().toString(36)}`;
      return [...prev, { id, app, openedAt: Date.now() }];
    });
    setView("app");
  }, []);

  useEffect(() => {
    if (!launchAppPath || launchPathConsumedRef.current === launchAppPath) return;
    const app = apps.find((candidate) => candidate.path === launchAppPath);
    if (!app) return;
    launchPathConsumedRef.current = launchAppPath;
    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect, react-doctor/no-derived-state -- imperative side effect, not derived state: opening an app in response to a one-shot `launchAppPath` request. The launchPathConsumedRef dedupe ensures it fires once per distinct path; `openStack` is genuine foreground-app state that the user mutates afterward, so it cannot be recomputed from `launchAppPath` in render.
    openApp(app);
  }, [apps, launchAppPath, openApp]);

  const closeApp = (openId: string) => {
    setOpenStack((prev) => {
      const next = prev.filter((o) => o.id !== openId);
      if (next.length === 0) {
        setView("launcher");
      }
      return next;
    });
  };

  const closeAll = () => {
    setOpenStack([]);
    setView("launcher");
  };

  const showSwitcher = () => {
    if (openStack.length === 0) return;
    setView("switcher");
  };

  const pinnedDock = apps.filter((a) => ["terminal", "files", "chat"].includes(a.id)).slice(0, 4);

  // Touch: swipe from the bottom edge up by >40px when an app is foregrounded
  // opens the app switcher (matches iOS swipe-up). Done with pointer events
  // on the bottom 24px-tall edge sensor.
  const edgeSensorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = edgeSensorRef.current;
    if (!el) return;
    let startY = 0;
    const onDown = (e: PointerEvent) => {
      startY = e.clientY;
      el.setPointerCapture(e.pointerId);
    };
    const onUp = (e: PointerEvent) => {
      const dy = startY - e.clientY;
      el.releasePointerCapture(e.pointerId);
      if (dy > 60) {
        if (stackRef.current.length > 0) setView("switcher");
        else setView("launcher");
      } else if (dy > 20) {
        setView("launcher");
      }
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
    };
  }, []);

  return (
    <div
      data-testid="mobile-shell"
      className="flex h-full w-full flex-col"
      style={{
        background: "var(--background, #1f2620)",
        color: "var(--foreground, #f4ede0)",
        paddingTop: "env(safe-area-inset-top, 0px)",
        paddingBottom: "env(safe-area-inset-bottom, 0px)",
      }}
    >
      <header
        className="flex items-center justify-between px-4 text-xs"
        style={{ height: 28, color: "var(--muted-foreground)" }}
      >
        <span data-testid="mobile-shell-clock" style={{ fontWeight: 600 }}>{time}</span>
        <span style={{ opacity: 0.7 }}>{view === "app" && top ? top.app.name : "Matrix OS"}</span>
        <button
          type="button"
          aria-label="Command palette"
          onClick={() => onOpenCommandPalette?.()}
          style={{
            background: "transparent",
            border: "none",
            color: "inherit",
            fontSize: 16,
            opacity: 0.7,
            padding: 0,
          }}
        >
          ⌘
        </button>
      </header>

      <main className="relative flex-1 overflow-hidden">
        {/* App stack: keep mounted to preserve state (terminal sessions etc).
            Visibility flips based on view + top of stack. */}
        {openStack.map((o, i) => {
          const isTop = i === openStack.length - 1;
          const visible = view === "app" && isTop;
          return (
            <div
              key={o.id}
              aria-hidden={!visible}
              style={{
                position: "absolute",
                inset: 0,
                display: "block",
                visibility: visible ? "visible" : "hidden",
                pointerEvents: visible ? "auto" : "none",
                background: "var(--background)",
              }}
            >
              <MobileAppFrame app={o.app} openId={o.id} chat={chat} />
            </div>
          );
        })}

        {view === "launcher" && (
          <Launcher
            apps={apps}
            onOpen={openApp}
            onOpenSettings={() => setSettingsOpen(true)}
            openStackCount={openStack.length}
            onShowSwitcher={showSwitcher}
          />
        )}

        {view === "switcher" && (
          <AppSwitcher
            open={openStack}
            onResume={() => setView("app")}
            onSelect={(id) => {
              setOpenStack((prev) => {
                const idx = prev.findIndex((o) => o.id === id);
                if (idx < 0) return prev;
                const next = prev.slice();
                const [taken] = next.splice(idx, 1);
                next.push(taken);
                return next;
              });
              setView("app");
            }}
            onClose={closeApp}
            onCloseAll={closeAll}
            onBack={() => setView(top ? "app" : "launcher")}
          />
        )}
      </main>

      <nav
        className="flex items-center justify-around px-2"
        style={{
          height: 64,
          background: "rgba(0,0,0,0.35)",
          borderTop: "1px solid rgba(244,237,224,0.08)",
          // react-doctor-disable-next-line react-doctor/no-large-animated-blur -- intentional frosted-glass bottom nav: this is a static (non-animated) backdrop-filter on a small fixed 64px-tall bar, so the GPU cost is bounded; the 20px radius is the designed frosted look and clamping it under 10px would visibly thin the frost. Paired with the -webkit- prefix below.
          backdropFilter: "blur(20px)",
          // react-doctor-disable-next-line react-doctor/no-large-animated-blur -- -webkit- prefixed twin of the static frosted-glass backdrop-filter above; same bounded 64px nav bar, kept in sync with the unprefixed property for Safari/iOS.
          WebkitBackdropFilter: "blur(20px)",
        }}
      >
        {pinnedDock.map((app) => (
          <DockButton
            key={app.id}
            label={app.name}
            iconSlug={app.iconSlug}
            highlighted={top?.app.path === app.path && view === "app"}
            onClick={() => openApp(app)}
          />
        ))}
        <DockButton label="Apps" iconSlug="grid" onClick={() => setView("launcher")} highlighted={view === "launcher"} />
        <DockButton
          label="Open"
          iconSlug="layers"
          onClick={showSwitcher}
          highlighted={view === "switcher"}
          badge={openStack.length || undefined}
        />
      </nav>

      <div
        ref={edgeSensorRef}
        aria-hidden
        style={{
          position: "fixed",
          left: 0,
          right: 0,
          bottom: 0,
          height: 24,
          zIndex: 50,
          touchAction: "none",
        }}
      />

      <Settings open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}

function MobileAppFrame({
  app,
  openId,
  chat,
}: {
  app: MobileApp;
  openId: string;
  chat: ReturnType<typeof useChatContext>;
}) {
  if (app.path.startsWith("__terminal__")) {
    return <TerminalApp key={openId} mobile launchTargetId={openId} />;
  }
  if (app.path === "__file-browser__") {
    return <FileBrowser windowId={openId} mobile />;
  }
  if (app.path === "__workspace__") {
    return <WorkspaceApp />;
  }
  if (app.path === "__preview-window__") {
    return <PreviewWindow />;
  }
  if (app.path === "__chat__") {
    if (!chat) {
      return (
        <div className="flex h-full items-center justify-center text-sm opacity-70">
          Chat unavailable
        </div>
      );
    }
    return (
      <ChatApp
        mobile
        messages={chat.messages}
        sessionId={chat.sessionId}
        busy={chat.busy}
        connected={chat.connected}
        conversations={chat.conversations}
        onNewChat={() => void chat.newChat()}
        onSwitchConversation={chat.switchConversation}
        onSubmit={chat.submitMessage}
      />
    );
  }
  if (app.path.startsWith("__")) {
    // Unknown built-in path: render a clear message instead of falling through
    // to AppViewer, which would resolve "__foo__" to /files/__foo__ → 404.
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <div style={{ fontSize: 14, fontWeight: 600 }}>This app isn&apos;t available on mobile yet</div>
        <div style={{ fontSize: 12, opacity: 0.7 }}>Path: {app.path}</div>
      </div>
    );
  }
  return <AppViewer path={app.path} onOpenApp={() => {}} />;
}

interface LauncherProps {
  apps: MobileApp[];
  onOpen: (app: MobileApp) => void;
  onOpenSettings: () => void;
  openStackCount: number;
  onShowSwitcher: () => void;
}

function Launcher({ apps, onOpen, onOpenSettings, openStackCount, onShowSwitcher }: LauncherProps) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-5 pt-4 pb-3">
        <div>
          <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: -0.3 }}>Apps</div>
          <div style={{ fontSize: 12, opacity: 0.6 }}>
            {apps.length} installed{openStackCount > 0 ? ` · ${openStackCount} open` : ""}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {openStackCount > 0 && (
            <button
              onClick={onShowSwitcher}
              type="button"
              style={{
                background: "rgba(244,237,224,0.08)",
                color: "inherit",
                border: "1px solid rgba(244,237,224,0.12)",
                borderRadius: 999,
                padding: "6px 12px",
                fontSize: 12,
              }}
            >
              Switcher
            </button>
          )}
          <button
            onClick={onOpenSettings}
            type="button"
            aria-label="Settings"
            style={{
              background: "rgba(244,237,224,0.08)",
              color: "inherit",
              border: "1px solid rgba(244,237,224,0.12)",
              borderRadius: 999,
              padding: "6px 10px",
              fontSize: 12,
            }}
          >
            ⚙
          </button>
        </div>
      </div>
      <div
        className="flex-1 overflow-y-auto"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, minmax(0,1fr))",
          gap: 18,
          padding: "8px 18px 32px",
          alignContent: "start",
        }}
      >
        {apps.map((app) => (
          <button
            key={app.id}
            type="button"
            onClick={() => onOpen(app)}
            style={LAUNCHER_APP_BUTTON_STYLE}
          >
            <AppIcon slug={app.iconSlug} size={56} />
            <span style={LAUNCHER_APP_LABEL_STYLE}>{app.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function AppSwitcher({
  open,
  onResume,
  onSelect,
  onClose,
  onCloseAll,
  onBack,
}: {
  open: OpenApp[];
  onResume: () => void;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onCloseAll: () => void;
  onBack: () => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-5 pt-4 pb-2">
        <button
          onClick={onBack}
          type="button"
          style={{
            background: "transparent",
            border: "none",
            color: "inherit",
            fontSize: 14,
            opacity: 0.7,
          }}
        >
          ← Back
        </button>
        <div style={{ fontSize: 14, fontWeight: 600 }}>Open apps</div>
        <button
          onClick={onCloseAll}
          type="button"
          style={{
            background: "transparent",
            border: "none",
            color: "inherit",
            fontSize: 12,
            opacity: 0.6,
          }}
        >
          Close all
        </button>
      </div>
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 12,
          padding: 16,
        }}
      >
        {open
          .slice()
          .reverse()
          .map((o) => (
            <div
              key={o.id}
              style={{
                background: "var(--card, rgba(244,237,224,0.06))",
                border: "1px solid rgba(244,237,224,0.12)",
                borderRadius: 18,
                padding: 14,
                display: "flex",
                gap: 12,
                alignItems: "center",
              }}
            >
              <AppIcon slug={o.app.iconSlug} size={44} />
              <button
                onClick={() => onSelect(o.id)}
                type="button"
                style={{
                  flex: 1,
                  textAlign: "left",
                  background: "transparent",
                  border: "none",
                  color: "inherit",
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                <div style={{ fontSize: 14, fontWeight: 600 }}>{o.app.name}</div>
                <div style={{ fontSize: 12, opacity: 0.6 }}>
                  Opened {new Date(o.openedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </div>
              </button>
              <button
                onClick={() => onClose(o.id)}
                type="button"
                aria-label={`Close ${o.app.name}`}
                style={SWITCHER_CLOSE_BUTTON_STYLE}
              >
                ×
              </button>
            </div>
          ))}
        {open.length > 0 && (
          <button onClick={onResume} type="button" style={SWITCHER_RESUME_BUTTON_STYLE}>
            Resume foreground app
          </button>
        )}
      </div>
    </div>
  );
}

function DockButton({
  label,
  iconSlug,
  onClick,
  highlighted,
  badge,
}: {
  label: string;
  iconSlug: string;
  onClick: () => void;
  highlighted?: boolean;
  badge?: number;
}) {
  return (
    <button
      onClick={onClick}
      type="button"
      style={{ ...DOCK_BUTTON_BASE_STYLE, opacity: highlighted ? 1 : 0.65 }}
      aria-label={label}
    >
      <AppIcon slug={iconSlug} size={32} />
      <span style={{ fontSize: 12, opacity: 0.8 }}>{label}</span>
      {badge !== undefined && (
        <span aria-hidden style={DOCK_BADGE_STYLE}>
          {badge}
        </span>
      )}
    </button>
  );
}

function AppIcon({ slug, size }: { slug: string; size: number }) {
  const [src, setSrc] = useState(() => iconUrlForSlug(slug) ?? "/icon-192.png");
  const triedSvg = useRef(false);
  const prevSlug = useRef(slug);

  useEffect(() => {
    if (prevSlug.current === slug) return;
    prevSlug.current = slug;
    triedSvg.current = false;
    // react-doctor-disable-next-line react-doctor/no-derived-state -- `src` is not pure derived state: it is seeded from `slug` but then mutated at runtime by the onError fallback chain (.png -> .svg -> /icon-192.png). Computing it in render would discard the resolved fallback and re-trigger the broken-image flicker on every render. This effect resets the chain only when the slug actually changes.
    setSrc(iconUrlForSlug(slug) ?? "/icon-192.png");
  }, [slug]);

  return (
    // react-doctor-disable-next-line react-doctor/nextjs-no-img-element -- icon src is swapped at runtime via onError fallback chain (.png -> .svg -> /icon-192.png), which next/image does not support; <img> preserves the graceful-degradation behavior.
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.22),
        background: "rgba(244,237,224,0.08)",
        objectFit: "contain",
      }}
      onError={() => {
        const svgUrl = src.replace(/\.[^.]+$/, ".svg");
        if (!triedSvg.current && src !== svgUrl) {
          triedSvg.current = true;
          setSrc(svgUrl);
        } else {
          setSrc("/icon-192.png");
        }
      }}
    />
  );
}

function formatClock(d: Date): string {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
