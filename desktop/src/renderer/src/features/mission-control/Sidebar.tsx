import {
  Blocks,
  FolderKanban,
  Home,
  FolderTree,
  LayoutGrid,
  Sparkles,
  SquareTerminal,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { BrandLogo } from "../../design/BrandPanel";
import { useCodingAgentWorkspace } from "../../stores/coding-agent-workspace";
import { useHermesChat } from "../../stores/hermes-chat";
import { FILES_WORKSPACE_TAB_SPEC, useTabs } from "../../stores/tabs";
import { useThreads } from "../../stores/threads";
import { kernelThreadAttentionCount } from "../../stores/unified-threads";
import { useUi } from "../../stores/ui";
import RuntimeComputerMenu from "../runtime/RuntimeComputerMenu";
import DesktopUpdateButton from "../updates/DesktopUpdateButton";
import AccountMenu from "./AccountMenu";
import RecentViews from "./RecentViews";
import { SidebarNavRow, SidebarSectionHeader } from "./SidebarPrimitives";

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
  const openApps = useMemo(() => tabs.filter((t) => t.kind === "app"), [tabs]);
  const chatAttention = useThreads((s) => kernelThreadAttentionCount(s.threads));
  const projectAttention = useCodingAgentWorkspace((s) =>
    s.summary?.projects.items.reduce((total, project) => total + project.attentionCount, 0) ?? 0,
  );
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const [appsOpen, setAppsOpen] = useState(true);

  const activeTab = tabs.find((t) => t.id === activeTabId);
  return (
    <aside
      aria-label="Matrix OS navigation"
      data-sidebar-state={collapsed ? "collapsed" : "expanded"}
      className="flex shrink-0 flex-col"
      style={{
        width: collapsed ? "var(--sidebar-collapsed-width)" : "var(--sidebar-expanded-width)",
        background: "var(--bg-sunken)",
        borderRight: "1px solid var(--border-subtle)",
        transition: "width 140ms var(--ease-out)",
      }}
    >
      {/* The collapsed rail stays empty beneath the macOS traffic lights; the
          shared navigation header owns the collapse/expand control. */}
      <div
        className="titlebar-drag flex items-center"
        style={{ height: "var(--titlebar-height)", paddingLeft: collapsed ? 0 : 76, justifyContent: collapsed ? "center" : "flex-start" }}
      >
        {collapsed ? null : (
          <div className="flex items-center gap-2.5" data-testid="matrix-sidebar-logo">
            <BrandLogo size={22} />
            <span className="text-[15px] font-semibold tracking-tight" style={{ color: "var(--text-primary)" }}>Matrix OS</span>
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2">
        <nav aria-label="Primary" className="flex flex-col gap-0.5">
          <SidebarNavRow
            icon={<Home size={15} />}
            label="Home"
            collapsed={collapsed}
            active={activeTab?.kind === "home"}
            onClick={() => openTab({ kind: "home", title: "Home", closable: false })}
          />
          <SidebarNavRow
            icon={<Sparkles size={15} />}
            label="Chat"
            collapsed={collapsed}
            active={activeTab?.kind === "chat"}
            badge={chatAttention}
            onClick={() => {
              useThreads.getState().setActiveThread(null);
              useHermesChat.getState().showIndex();
              openTab({ kind: "chat", title: "Hermes", closable: false });
            }}
          />
          <SidebarNavRow
            icon={<SquareTerminal size={15} />}
            label="Terminal"
            collapsed={collapsed}
            active={activeTab?.kind === "terminals" || activeTab?.kind === "terminal"}
            onClick={() => openTab({ kind: "terminals", title: "Terminal" })}
          />
          <SidebarNavRow
            icon={<FolderTree size={15} />}
            label="Files"
            collapsed={collapsed}
            active={activeTab?.kind === "files"}
            onClick={() => openTab(FILES_WORKSPACE_TAB_SPEC)}
          />
          <SidebarNavRow
            icon={<LayoutGrid size={15} />}
            label="Apps"
            collapsed={collapsed}
            active={activeTab?.kind === "apps" || activeTab?.kind === "app"}
            onClick={() => openTab({ kind: "apps", title: "Apps" })}
          />
          <SidebarNavRow
            icon={<Blocks size={15} />}
            label="Plugins"
            collapsed={collapsed}
            active={activeTab?.kind === "plugins"}
            onClick={() => openTab({ kind: "plugins", title: "Plugins" })}
          />
          <SidebarNavRow
            icon={<FolderKanban size={15} />}
            label="Projects"
            collapsed={collapsed}
            active={activeTab?.kind === "projects" || activeTab?.kind === "project"}
            badge={projectAttention}
            onClick={() => openTab({ kind: "projects", title: "Projects", closable: false })}
          />
        </nav>

        {!collapsed ? (
          <>
            <RecentViews />
            {openApps.length > 0 ? (
              <>
                <SidebarSectionHeader
                  label="Open apps"
                  open={appsOpen}
                  controls="sidebar-open-apps"
                  onToggle={() => setAppsOpen((value) => !value)}
                />
                <div id="sidebar-open-apps">
                  {appsOpen
                    ? openApps.map((tab) => (
                        <SidebarNavRow
                          key={tab.id}
                          icon={<SidebarAppIcon iconUrl={tab.icon} name={tab.title} />}
                          label={tab.title}
                          collapsed={false}
                          active={tab.id === activeTabId}
                          onClick={() => focusTab(tab.id)}
                        />
                      ))
                    : null}
                </div>
              </>
            ) : null}
          </>
        ) : null}
      </div>

      <div className="flex flex-col border-t" style={{ borderColor: "var(--border-subtle)" }}>
        <RuntimeComputerMenu collapsed={collapsed} />
        {collapsed ? <DesktopUpdateButton collapsed /> : null}
        <AccountMenu
          collapsed={collapsed}
          trailingAction={collapsed ? null : <DesktopUpdateButton collapsed={false} />}
        />
      </div>
    </aside>
  );
}
