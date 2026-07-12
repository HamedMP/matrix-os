import {
  Bot,
  ChevronRight,
  Home,
  FolderTree,
  LayoutGrid,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings,
  Sparkles,
  SquareTerminal,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { BrandLogo } from "../../design/BrandPanel";
import { IconButton } from "../../design/primitives";
import { CODING_AGENTS_DESKTOP_WORKSPACE } from "../../lib/feature-flags";
import { invoke } from "../../lib/operator";
import { useBoard } from "../../stores/board";
import { useConnection } from "../../stores/connection";
import { AGENTS_WORKSPACE_TAB_SPEC, FILES_WORKSPACE_TAB_SPEC, useTabs } from "../../stores/tabs";
import { useThreads } from "../../stores/threads";
import { useUi } from "../../stores/ui";
import RuntimeComputerMenu from "../runtime/RuntimeComputerMenu";

function NavRow({
  icon,
  label,
  active,
  badge,
  collapsed,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  badge?: number;
  collapsed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={collapsed ? label : undefined}
      className={`flex w-full items-center rounded-md py-1.5 text-sm font-medium transition-colors duration-100 ${collapsed ? "justify-center px-0" : "gap-2.5 px-2.5"}`}
      style={{
        color: active ? "var(--text-primary)" : "var(--text-secondary)",
        background: active ? "var(--bg-selected)" : "transparent",
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = "var(--bg-hover)";
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = "transparent";
      }}
      onClick={onClick}
    >
      <span style={{ color: active ? "var(--accent)" : "var(--text-tertiary)" }}>{icon}</span>
      {!collapsed ? <span className="min-w-0 flex-1 truncate text-left">{label}</span> : null}
      {!collapsed && badge ? (
        <span className="rounded-full px-1.5 text-xs" style={{ background: "var(--highlight-muted)", color: "var(--highlight)" }}>
          {badge}
        </span>
      ) : null}
    </button>
  );
}

function SidebarAppIcon({ iconUrl, name }: { iconUrl?: string; name: string }) {
  const url =
    iconUrl && (/^https?:\/\//.test(iconUrl) || iconUrl.startsWith("/")) ? iconUrl : null;
  const [failed, setFailed] = useState(false);
  const prev = useRef<string | null>(null);
  if (prev.current !== url) {
    prev.current = url;
    if (failed) setFailed(false);
  }
  if (url && !failed) {
    return <img src={url} alt="" className="h-4 w-4 rounded-sm object-cover" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
  }
  return (
    <span className="flex h-4 w-4 items-center justify-center rounded text-[10px] font-semibold" style={{ background: "var(--accent-muted)", color: "var(--accent)" }}>
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

export default function Sidebar() {
  const tabs = useTabs((s) => s.tabs);
  const activeTabId = useTabs((s) => s.activeTabId);
  const openTab = useTabs((s) => s.openTab);
  const focusTab = useTabs((s) => s.focusTab);
  const projects = useBoard((s) => s.projects);
  const openApps = useMemo(() => tabs.filter((t) => t.kind === "app"), [tabs]);
  const signOut = useConnection((s) => s.signOut);
  const handle = useConnection((s) => s.handle);
  const profileName = useConnection((s) => s.displayName);
  const imageUrl = useConnection((s) => s.imageUrl);
  const platformHost = useConnection((s) => s.platformHost);
  const unread = useThreads((s) => s.threads.filter((t) => t.unread || t.status === "needs-attention").length);
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const toggleSidebar = useUi((s) => s.toggleSidebar);
  const setCreateProjectOpen = useUi((s) => s.setCreateProjectOpen);
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [appsOpen, setAppsOpen] = useState(true);

  // Reset the avatar fallback whenever the URL changes so a new image gets a
  // fresh load attempt (lesson: track prev URL, reset imgFailed on differ).
  const [imgFailed, setImgFailed] = useState(false);
  const prevImg = useRef<string | null>(null);
  useEffect(() => {
    if (prevImg.current !== imageUrl) {
      prevImg.current = imageUrl;
      setImgFailed(false);
    }
  }, [imageUrl]);

  const primaryLabel = profileName ?? (handle ? `@${handle}` : "Signed in");
  const secondaryLabel = profileName && handle ? `@${handle}` : null;
  const avatarInitial = (profileName ?? handle ?? "?").charAt(0).toUpperCase();
  const showAvatar = Boolean(imageUrl) && !imgFailed;

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const width = collapsed ? 56 : 240;

  return (
    <aside
      className="flex shrink-0 flex-col"
      style={{ width, background: "var(--bg-sunken)", borderRight: "1px solid var(--border-subtle)", transition: "width 140ms var(--ease-out)" }}
    >
      {/* When collapsed the 56px rail sits under the macOS traffic lights, so the
          titlebar stays empty (draggable) and the expand toggle lives in the nav
          below the lights — otherwise it's unclickable behind them. */}
      <div
        className="titlebar-drag flex items-center"
        style={{ height: "var(--titlebar-height)", paddingLeft: collapsed ? 0 : 76, justifyContent: collapsed ? "center" : "flex-start" }}
      >
        {collapsed ? null : (
          <div className="flex items-center gap-2.5">
            <BrandLogo size={22} />
            <span className="text-[15px] font-semibold tracking-tight" style={{ color: "var(--text-primary)" }}>Matrix OS</span>
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2">
        <nav className="flex flex-col gap-0.5">
          <NavRow icon={<Home size={15} />} label="Home" collapsed={collapsed} active={activeTab?.kind === "home"} onClick={() => openTab({ kind: "home", title: "Home", closable: false })} />
          <NavRow icon={<Sparkles size={15} />} label="Chat" collapsed={collapsed} active={activeTab?.kind === "chat"} onClick={() => { useThreads.getState().setActiveThread(null); openTab({ kind: "chat", title: "Hermes", closable: false }); }} />
          {CODING_AGENTS_DESKTOP_WORKSPACE ? (
            <NavRow icon={<Bot size={15} />} label="Agents" collapsed={collapsed} active={activeTab?.kind === "agents"} onClick={() => openTab(AGENTS_WORKSPACE_TAB_SPEC)} />
          ) : null}
          <NavRow icon={<SquareTerminal size={15} />} label="Terminal" collapsed={collapsed} active={activeTab?.kind === "terminals"} onClick={() => openTab({ kind: "terminals", title: "Terminal" })} />
          <NavRow icon={<FolderTree size={15} />} label="Files" collapsed={collapsed} active={activeTab?.kind === "files"} onClick={() => openTab(FILES_WORKSPACE_TAB_SPEC)} />
          <NavRow icon={<LayoutGrid size={15} />} label="Apps" collapsed={collapsed} active={activeTab?.kind === "apps" || activeTab?.kind === "app"} onClick={() => openTab({ kind: "apps", title: "Apps" })} />
        </nav>

        {!collapsed ? (
          <>
            <div className="group/projects mt-4 mb-1 flex items-center px-2.5">
              <button type="button" className="flex flex-1 items-center gap-1" onClick={() => setProjectsOpen((v) => !v)}>
                <ChevronRight size={12} style={{ color: "var(--text-tertiary)", transform: projectsOpen ? "rotate(90deg)" : "none", transition: "transform 120ms" }} />
                <span className="text-xs font-semibold tracking-wide uppercase" style={{ color: "var(--text-tertiary)" }}>Projects</span>
              </button>
              <button
                type="button"
                aria-label="New project"
                title="New project"
                className="flex h-5 w-5 items-center justify-center rounded opacity-0 transition-opacity hover:bg-[var(--bg-hover)] group-hover/projects:opacity-100"
                style={{ color: "var(--text-tertiary)" }}
                onClick={() => setCreateProjectOpen(true)}
              >
                <Plus size={13} />
              </button>
            </div>
            {projectsOpen
              ? projects.map((project) => {
                  const isActive = activeTab?.kind === "board" && activeTab.projectSlug === project.slug;
                  return (
                    <NavRow
                      key={project.slug}
                      icon={<span className="text-xs">▣</span>}
                      label={project.name || project.slug}
                      collapsed={false}
                      active={isActive}
                      onClick={() => openTab({ kind: "board", projectSlug: project.slug, title: project.name || project.slug })}
                    />
                  );
                })
              : null}
            {projectsOpen && projects.length === 0 ? (
              <p className="px-2.5 py-1 text-xs" style={{ color: "var(--text-tertiary)" }}>No projects yet.</p>
            ) : null}

            {openApps.length > 0 ? (
              <>
                <button type="button" className="mt-4 mb-1 flex w-full items-center gap-1 px-2.5" onClick={() => setAppsOpen((v) => !v)}>
                  <ChevronRight size={12} style={{ color: "var(--text-tertiary)", transform: appsOpen ? "rotate(90deg)" : "none", transition: "transform 120ms" }} />
                  <span className="text-xs font-semibold tracking-wide uppercase" style={{ color: "var(--text-tertiary)" }}>Open apps</span>
                </button>
                {appsOpen
                  ? openApps.map((tab) => (
                      <NavRow
                        key={tab.id}
                        icon={<SidebarAppIcon iconUrl={tab.icon} name={tab.title} />}
                        label={tab.title}
                        collapsed={false}
                        active={tab.id === activeTabId}
                        onClick={() => focusTab(tab.id)}
                      />
                    ))
                  : null}
              </>
            ) : null}
          </>
        ) : null}
      </div>

      <div className="flex flex-col border-t" style={{ borderColor: "var(--border-subtle)" }}>
        <RuntimeComputerMenu collapsed={collapsed} />
        <div className={`flex items-center ${collapsed ? "justify-center" : "justify-between"} px-2 pt-1`}>
          <NavRow icon={<Settings size={15} />} label="Settings" collapsed={collapsed} active={activeTab?.kind === "settings"} onClick={() => openTab({ kind: "settings", title: "Settings" })} />
        </div>
        <div className={`flex gap-2 p-2 ${collapsed ? "flex-col items-center" : "items-center"}`}>
          <button
            type="button"
            title="Manage account"
            className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full text-xs font-semibold"
            style={{ background: "var(--accent-muted)", color: "var(--accent)" }}
            onClick={() => void invoke("shell:open-external", { url: platformHost.startsWith("https://") ? platformHost : "https://app.matrix-os.com" })}
          >
            {showAvatar && imageUrl ? (
              <img
                src={imageUrl}
                alt=""
                className="h-full w-full object-cover"
                referrerPolicy="no-referrer"
                onError={() => setImgFailed(true)}
              />
            ) : (
              avatarInitial
            )}
          </button>
          {collapsed ? (
            // Collapsed: the expand toggle lives here too (same place as the
            // collapse toggle when open), so open/close is one consistent spot.
            <IconButton label="Expand sidebar (⌘B)" onClick={toggleSidebar}>
              <PanelLeftOpen size={15} />
            </IconButton>
          ) : (
            <>
              <div className="flex min-w-0 flex-1 flex-col leading-tight">
                <span className="truncate text-sm" style={{ color: "var(--text-primary)" }}>{primaryLabel}</span>
                {secondaryLabel ? (
                  <span className="truncate text-xs" style={{ color: "var(--text-tertiary)" }}>{secondaryLabel}</span>
                ) : null}
              </div>
              <IconButton label="Collapse sidebar (⌘B)" onClick={toggleSidebar}>
                <PanelLeftClose size={15} />
              </IconButton>
              <IconButton
                label="Sign out"
                onClick={() => {
                  void signOut().catch((err: unknown) => {
                    console.warn(
                      "[sidebar] sign-out failed:",
                      err instanceof Error ? err.message : String(err),
                    );
                  });
                }}
              >
                <LogOut size={14} />
              </IconButton>
            </>
          )}
        </div>
      </div>
    </aside>
  );
}
