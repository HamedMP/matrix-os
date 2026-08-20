import * as Popover from "@radix-ui/react-popover";
import {
  File,
  FolderOpen,
  House,
  LayoutGrid,
  MessageCircle,
  Plus,
  Terminal,
} from "lucide-react";
import { useEffect, useState } from "react";
import phosphorPlugsUrl from "../../assets/phosphor/plugs.svg?no-inline";
import { DESKTOP_Z_INDEX } from "../../design/layering";
import { useBoard } from "../../stores/board";
import { useCodingAgentWorkspace } from "../../stores/coding-agent-workspace";
import { useHermesChat } from "../../stores/hermes-chat";
import { FILES_WORKSPACE_TAB_SPEC, useTabs } from "../../stores/tabs";
import { useThreads } from "../../stores/threads";
import { kernelThreadAttentionCount } from "../../stores/unified-threads";
import { useUi } from "../../stores/ui";
import RuntimeComputerMenu from "../runtime/RuntimeComputerMenu";
import DesktopUpdateButton from "../updates/DesktopUpdateButton";
import AccountMenu from "./AccountMenu";
import ProjectSidebarRow from "./ProjectSidebarRow";
import RecentViews from "./RecentViews";
import {
  SidebarDivider,
  SidebarIcon,
  SidebarNavRow,
  sidebarNavRowStyle,
} from "./SidebarPrimitives";

function FigmaPlugsIcon() {
  return (
    <span
      data-figma-icon="phosphor-plugs"
      className="block size-3.5"
      style={{
        backgroundColor: "currentColor",
        maskImage: `url(${phosphorPlugsUrl})`,
        maskPosition: "center",
        maskRepeat: "no-repeat",
        maskSize: "contain",
        WebkitMaskImage: `url(${phosphorPlugsUrl})`,
        WebkitMaskPosition: "center",
        WebkitMaskRepeat: "no-repeat",
        WebkitMaskSize: "contain",
      }}
    />
  );
}

export default function Sidebar() {
  const tabs = useTabs((s) => s.tabs);
  const activeTabId = useTabs((s) => s.activeTabId);
  const openTab = useTabs((s) => s.openTab);
  const projects = useBoard((s) => s.projects);
  const chatAttention = useThreads((s) => kernelThreadAttentionCount(s.threads));
  const summaryProjects = useCodingAgentWorkspace((s) => s.summary?.projects.items);
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const setCreateProjectOpen = useUi((s) => s.setCreateProjectOpen);
  const acquireRendererOverlay = useUi((s) => s.acquireRendererOverlay);
  const releaseRendererOverlay = useUi((s) => s.releaseRendererOverlay);
  const [projectsMenuOpen, setProjectsMenuOpen] = useState(false);

  useEffect(() => {
    if (!projectsMenuOpen) return;
    acquireRendererOverlay();
    return releaseRendererOverlay;
  }, [acquireRendererOverlay, projectsMenuOpen, releaseRendererOverlay]);

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const projectAttention = summaryProjects?.reduce(
    (total, project) => total + project.attentionCount,
    0,
  ) ?? 0;
  const openProject = (target: (typeof projects)[number]) => {
    setProjectsMenuOpen(false);
    openTab({
      kind: "project",
      projectSlug: target.slug,
      title: target.name || target.slug,
    });
  };

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
                active={activeTab?.kind === "chat"}
                badge={chatAttention}
                onClick={() => {
                  useThreads.getState().setActiveThread(null);
                  useHermesChat.getState().showIndex();
                  openTab({ kind: "chat", title: "Hermes", closable: false });
                }}
              />
              <SidebarNavRow
                icon={<Terminal size={14} />}
                label="Terminal"
                collapsed={false}
                active={activeTab?.kind === "terminals" || activeTab?.kind === "terminal"}
                onClick={() => openTab({ kind: "terminals", title: "Terminal" })}
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
                icon={<FigmaPlugsIcon />}
                label="Plugins"
                collapsed={false}
                active={activeTab?.kind === "plugins"}
                onClick={() => openTab({ kind: "plugins", title: "Plugins" })}
              />
              <Popover.Root open={projectsMenuOpen} onOpenChange={setProjectsMenuOpen}>
                <Popover.Trigger asChild>
                  <button
                    type="button"
                    aria-label={projectAttention > 0 ? `Projects ${projectAttention}` : "Projects"}
                    aria-current={activeTab?.kind === "project" || activeTab?.kind === "task" ? "page" : undefined}
                    data-active={activeTab?.kind === "project" || activeTab?.kind === "task" ? "true" : "false"}
                    className="group/sidebar-row flex w-full items-center gap-2 rounded-md px-2 text-[13px] outline-none transition-colors duration-100 hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)]"
                    style={sidebarNavRowStyle(activeTab?.kind === "project" || activeTab?.kind === "task")}
                  >
                    <SidebarIcon active={activeTab?.kind === "project" || activeTab?.kind === "task"}>
                      <FolderOpen size={14} />
                    </SidebarIcon>
                    <span className="min-w-0 flex-1 truncate text-left">Projects</span>
                    {projectAttention > 0 ? (
                      <span
                        aria-hidden="true"
                        className="min-w-5 rounded-full px-1.5 text-center text-xs"
                        style={{ background: "var(--highlight-muted)", color: "var(--highlight)" }}
                      >
                        {projectAttention}
                      </span>
                    ) : null}
                  </button>
                </Popover.Trigger>
                <Popover.Portal>
                  <Popover.Content
                    side="right"
                    align="start"
                    sideOffset={6}
                    aria-label="Choose project"
                    className="w-56 rounded-lg border p-1 outline-none"
                    style={{
                      zIndex: DESKTOP_Z_INDEX.popover,
                      background: "var(--bg-overlay)",
                      borderColor: "var(--border-default)",
                      boxShadow: "var(--shadow-2)",
                    }}
                  >
                    <div className="px-2 py-1 text-[11px] font-medium" style={{ color: "var(--text-tertiary)" }}>
                      Projects
                    </div>
                    {projects.map((project) => (
                      <ProjectSidebarRow
                        key={project.slug}
                        project={project}
                        active={activeTab?.kind === "project" && activeTab.projectSlug === project.slug}
                        attention={summaryProjects?.find((candidate) => candidate.id === project.slug)?.attentionCount ?? 0}
                        onOpen={() => openProject(project)}
                      />
                    ))}
                    {projects.length === 0 ? (
                      <p className="px-2 py-2 text-xs" style={{ color: "var(--text-tertiary)" }}>No projects yet.</p>
                    ) : null}
                    <div className="mt-1 border-t pt-1" style={{ borderColor: "var(--border-subtle)" }}>
                      <button
                        type="button"
                        className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-[13px] outline-none hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)]"
                        style={{ color: "var(--text-secondary)" }}
                        onClick={() => {
                          setProjectsMenuOpen(false);
                          setCreateProjectOpen(true);
                        }}
                      >
                        <Plus size={14} aria-hidden="true" />
                        Add project
                      </button>
                    </div>
                  </Popover.Content>
                </Popover.Portal>
              </Popover.Root>
            </nav>

            <div className="mt-3">
              <SidebarDivider />
            </div>
            <RecentViews />
          </div>

          <div className="mt-auto flex shrink-0 flex-col">
            <DesktopUpdateButton collapsed={false} />
            <AccountMenu collapsed={false} />
          </div>
        </>
      )}
    </aside>
  );
}
