import {
  File,
  FolderOpen,
  House,
  LayoutGrid,
  MessageCircle,
  Terminal,
} from "@renderer/lib/hugeicons";
import { useCodingAgentWorkspace } from "../../stores/coding-agent-workspace";
import { FILES_WORKSPACE_TAB_SPEC, isWorkRoute, useTabs } from "../../stores/tabs";
import { useThreads } from "../../stores/threads";
import { kernelThreadAttentionCount } from "../../stores/unified-threads";
import { useUi } from "../../stores/ui";
import RuntimeComputerMenu from "../runtime/RuntimeComputerMenu";
import DesktopUpdateButton from "../updates/DesktopUpdateButton";
import AccountMenu from "./AccountMenu";
import { openChatIndex, openProjectsIndex, openTerminalIndex } from "./navigation-roots";
import RecentViews from "./RecentViews";
import {
  SidebarDivider,
  SidebarNavRow,
} from "./SidebarPrimitives";

export default function Sidebar() {
  const tabs = useTabs((s) => s.tabs);
  const activeTabId = useTabs((s) => s.activeTabId);
  const openTab = useTabs((s) => s.openTab);
  const chatAttention = useThreads((s) => kernelThreadAttentionCount(s.threads));
  const summaryProjects = useCodingAgentWorkspace((s) => s.summary?.projects.items);
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const projectAttention = summaryProjects?.reduce(
    (total, project) => total + project.attentionCount,
    0,
  ) ?? 0;
  return (
    <aside
      aria-label="Matrix OS navigation"
      aria-hidden={collapsed ? "true" : undefined}
      data-sidebar-state={collapsed ? "collapsed" : "expanded"}
      className="flex h-full shrink-0 flex-col overflow-hidden"
      style={{
        width: collapsed ? "var(--sidebar-collapsed-width)" : "var(--sidebar-expanded-width)",
        background: "var(--bg-sunken)",
        transition: "width 140ms var(--ease-out)",
      }}
    >
      {collapsed ? null : (
        <>
          <div className="px-2 pt-4">
            <RuntimeComputerMenu collapsed={false} />
          </div>
          <div className="mt-3">
            <SidebarDivider />
          </div>

          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pt-3">
            <nav aria-label="Primary" className="flex flex-col gap-0.5 px-2">
              <SidebarNavRow
                icon={<House size={14} />}
                label="Home"
                collapsed={false}
                active={activeTab?.kind === "home"}
                onClick={() => openTab({ kind: "home", title: "Home", closable: false })}
              />
              <SidebarNavRow
                icon={<MessageCircle size={14} />}
                label="Chat"
                collapsed={false}
                active={isWorkRoute(activeTab, "chat")}
                badge={chatAttention}
                onClick={openChatIndex}
              />
              <SidebarNavRow
                icon={<Terminal size={14} />}
                label="Terminal"
                collapsed={false}
                active={activeTab?.kind === "terminals" || activeTab?.kind === "terminal"}
                onClick={openTerminalIndex}
              />
              <SidebarNavRow
                icon={<File size={14} />}
                label="Files"
                collapsed={false}
                active={activeTab?.kind === "files"}
                onClick={() => openTab(FILES_WORKSPACE_TAB_SPEC)}
              />
              <SidebarNavRow
                icon={<LayoutGrid size={14} />}
                label="Apps"
                collapsed={false}
                active={activeTab?.kind === "apps" || activeTab?.kind === "app"}
                onClick={() => openTab({ kind: "apps", title: "Apps" })}
              />
              <SidebarNavRow
                icon={<FolderOpen size={14} />}
                label="Projects"
                collapsed={false}
                active={isWorkRoute(activeTab, "projects") || isWorkRoute(activeTab, "project")}
                badge={projectAttention}
                onClick={openProjectsIndex}
              />
            </nav>

            <div className="mt-3">
              <SidebarDivider />
            </div>
            <RecentViews />
          </div>

          <div className="mt-auto flex shrink-0 flex-col">
            <AccountMenu
              collapsed={false}
              trailingAction={<DesktopUpdateButton collapsed={false} />}
            />
          </div>
        </>
      )}
    </aside>
  );
}
