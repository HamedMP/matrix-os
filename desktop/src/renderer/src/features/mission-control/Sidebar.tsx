import {
  Blocks,
  ChevronRight,
  Home,
  FolderTree,
  LayoutGrid,
  Plus,
  Sparkles,
  SquareTerminal,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { BrandLogo } from "../../design/BrandPanel";
import { useBoard } from "../../stores/board";
import { useCodingAgentWorkspace } from "../../stores/coding-agent-workspace";
import { FILES_WORKSPACE_TAB_SPEC, useTabs } from "../../stores/tabs";
import { useThreads } from "../../stores/threads";
import { kernelThreadAttentionCount } from "../../stores/unified-threads";
import { useUi } from "../../stores/ui";
import RuntimeComputerMenu from "../runtime/RuntimeComputerMenu";
import DesktopUpdateButton from "../updates/DesktopUpdateButton";
import AccountMenu from "./AccountMenu";
import ProjectSidebarRow from "./ProjectSidebarRow";
import RecentViews from "./RecentViews";

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
  const recordRecentConversation = useTabs((s) => s.recordRecentConversation);
  const projects = useBoard((s) => s.projects);
  const openApps = useMemo(() => tabs.filter((t) => t.kind === "app"), [tabs]);
  const chatAttention = useThreads((s) => kernelThreadAttentionCount(s.threads));
  const summaryProjects = useCodingAgentWorkspace((s) => s.summary?.projects.items);
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const setCreateProjectOpen = useUi((s) => s.setCreateProjectOpen);
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [appsOpen, setAppsOpen] = useState(true);

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const width = collapsed ? 56 : 240;

  return (
    <aside
      className="flex shrink-0 flex-col"
      style={{ width, background: "var(--bg-sunken)", borderRight: "1px solid var(--border-subtle)", transition: "width 140ms var(--ease-out)" }}
    >
      {/* The collapsed rail stays empty beneath the macOS traffic lights; the
          shared navigation header owns the collapse/expand control. */}
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
          <NavRow icon={<Sparkles size={15} />} label="Chat" collapsed={collapsed} active={activeTab?.kind === "chat"} badge={chatAttention} onClick={() => { useThreads.getState().setActiveThread(null); recordRecentConversation("hermes", "Hermes"); openTab({ kind: "chat", title: "Hermes", closable: false }); }} />
          <NavRow icon={<SquareTerminal size={15} />} label="Terminal" collapsed={collapsed} active={activeTab?.kind === "terminals"} onClick={() => openTab({ kind: "terminals", title: "Terminal" })} />
          <NavRow icon={<FolderTree size={15} />} label="Files" collapsed={collapsed} active={activeTab?.kind === "files"} onClick={() => openTab(FILES_WORKSPACE_TAB_SPEC)} />
          <NavRow icon={<LayoutGrid size={15} />} label="Apps" collapsed={collapsed} active={activeTab?.kind === "apps" || activeTab?.kind === "app"} onClick={() => openTab({ kind: "apps", title: "Apps" })} />
          <NavRow icon={<Blocks size={15} />} label="Plugins" collapsed={collapsed} active={activeTab?.kind === "plugins"} onClick={() => openTab({ kind: "plugins", title: "Plugins" })} />
        </nav>

        {!collapsed ? (
          <>
            <RecentViews />
            <div className="group/projects mt-4 mb-1 flex items-center px-2.5">
              <button type="button" className="flex flex-1 items-center gap-1" onClick={() => setProjectsOpen((v) => !v)}>
                <ChevronRight size={12} style={{ color: "var(--text-tertiary)", transform: projectsOpen ? "rotate(90deg)" : "none", transition: "transform 120ms" }} />
                <span className="text-xs font-semibold tracking-wide uppercase" style={{ color: "var(--text-tertiary)" }}>Projects</span>
              </button>
              <button
                type="button"
                aria-label="Add project"
                title="Add project"
                className="flex h-5 w-5 items-center justify-center rounded opacity-0 transition-opacity hover:bg-[var(--bg-hover)] group-hover/projects:opacity-100"
                style={{ color: "var(--text-tertiary)" }}
                onClick={() => setCreateProjectOpen(true)}
              >
                <Plus size={13} />
              </button>
            </div>
            {projectsOpen
              ? projects.map((project) => {
                  const isActive = activeTab?.kind === "project" && activeTab.projectSlug === project.slug;
                  const attention = summaryProjects?.find((candidate) => candidate.id === project.slug)?.attentionCount ?? 0;
                  return (
                    <ProjectSidebarRow
                      key={project.slug}
                      project={project}
                      active={isActive}
                      attention={attention}
                      onOpen={() => openTab({ kind: "project", projectSlug: project.slug, title: project.name || project.slug })}
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
        <DesktopUpdateButton collapsed={collapsed} />
        <AccountMenu collapsed={collapsed} />
      </div>
    </aside>
  );
}
