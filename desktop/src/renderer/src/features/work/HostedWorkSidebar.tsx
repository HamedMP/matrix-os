import type { CanonicalChatRecord } from "@matrix-os/contracts";
import type { Tab } from "../../stores/tabs";
import { useBoard, type Project } from "../../stores/board";
import { useTabs } from "../../stores/tabs";
import { useUi } from "../../stores/ui";
import { WorkRail } from "./WorkRail";
import { openWorkProject } from "./work-navigation";
import { useWorkSurfaceRuntime } from "./WorkSurfaceRuntime";

export const HOSTED_WORK_SIDEBAR_WIDTH = 240;

export function HostedWorkSidebar({ tab, active }: { tab: Tab; active: boolean }) {
  const runtime = useWorkSurfaceRuntime();
  const projects = useBoard((state) => state.projects);
  const route = tab.workRoute ?? (tab.kind === "projects" ? "projects" : tab.kind === "project" ? "project" : "chat");
  const openGlobalDraft = () => useTabs.getState().openTab({
    kind: "work",
    title: "Chat",
    workRoute: "chat",
    chatView: "draft",
    closable: false,
  });
  const selectChat = (record: CanonicalChatRecord, project?: Project) => {
    if (project) {
      openWorkProject(project, record.chat.id, record.chat.title);
      return;
    }
    useTabs.getState().openTab({
      kind: "work",
      title: "Chat",
      workRoute: "chat",
      chatId: record.chat.id,
      chatTitle: record.chat.title,
      chatView: "conversation",
      closable: false,
    });
  };
  return (
    <WorkRail
      client={runtime?.client ?? null}
      eventSource={runtime?.eventSource ?? undefined}
      projects={projects}
      active={active}
      activeChatId={tab.chatId}
      activeProjectSlug={route === "project" ? tab.projectSlug : undefined}
      className="h-full w-full border-r-0"
      onCollapse={() => undefined}
      showCollapseControl={false}
      onNewGlobalChat={openGlobalDraft}
      onCreateProject={() => useUi.getState().openCreateProject()}
      onNewProjectChat={openWorkProject}
      onSelectChat={selectChat}
      onChatDeleted={(record, project) => {
        if (record.chat.id !== tab.chatId) return;
        if (project) openWorkProject(project);
        else openGlobalDraft();
      }}
    />
  );
}
