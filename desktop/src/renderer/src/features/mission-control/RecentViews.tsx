import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Check,
  Filter,
  FolderKanban,
  MessageCircle,
  SquareTerminal,
} from "@renderer/lib/hugeicons";
import { useMemo } from "react";
import { DESKTOP_Z_INDEX } from "../../design/layering";
import { openCodingAgentThread } from "../../lib/project-chat";
import { openProjectOverview } from "../../lib/project-navigation";
import {
  useTabs,
  type RecentView,
  type RecentViewFilter,
} from "../../stores/tabs";
import { useConnection } from "../../stores/connection";
import { useCodingAgentWorkspace } from "../../stores/coding-agent-workspace";
import { useHermesChat } from "../../stores/hermes-chat";
import { useThreads } from "../../stores/threads";
import { useBoard } from "../../stores/board";
import { useProjectView } from "../../stores/project-view";
import { SidebarIcon, sidebarNavRowStyle } from "./SidebarPrimitives";

const FILTER_OPTIONS: Array<{ filter: RecentViewFilter; label: string }> = [
  { filter: "all", label: "All recents" },
  { filter: "conversation", label: "Conversations" },
  { filter: "terminal", label: "Terminals" },
  { filter: "project", label: "Projects" },
];

function RecentIcon({ kind }: { kind: RecentView["kind"] }) {
  if (kind === "conversation") return <MessageCircle size={13} />;
  if (kind === "terminal") return <SquareTerminal size={13} />;
  return <FolderKanban size={13} />;
}

export default function RecentViews() {
  const recentViews = useTabs((state) => state.recentViews);
  const recentFilter = useTabs((state) => state.recentFilter);
  const setRecentFilter = useTabs((state) => state.setRecentFilter);
  const tabs = useTabs((state) => state.tabs);
  const activeTabId = useTabs((state) => state.activeTabId);
  const openTab = useTabs((state) => state.openTab);
  const requestTerminalSession = useTabs((state) => state.requestTerminalSession);
  const api = useConnection((state) => state.api);
  const threads = useThreads((state) => state.threads);
  const activeThreadId = useThreads((state) => state.activeThreadId);
  const activeCodingAgentThreadId = useCodingAgentWorkspace((state) => state.activeThreadId);
  const setActiveThread = useThreads((state) => state.setActiveThread);
  const openHermesConversation = useHermesChat((state) => state.openConversation);
  const showHermesIndex = useHermesChat((state) => state.showIndex);
  const hermesSessionId = useHermesChat((state) => state.sessionId);
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const visible = useMemo(
    () => recentViews.filter((recent) => recentFilter === "all" || recent.kind === recentFilter).slice(0, 8),
    [recentFilter, recentViews],
  );

  const openRecent = (recent: RecentView) => {
    if (recent.kind === "project") {
      openProjectOverview(recent.id, recent.label);
      return;
    }
    if (recent.kind === "terminal") {
      const terminalsWorkspace = tabs.find((tab) => tab.kind === "terminals");
      if (terminalsWorkspace) {
        requestTerminalSession(recent.id);
        openTab({ kind: "terminals", title: terminalsWorkspace.title });
        return;
      }
      const nativeTab = tabs.find((tab) => tab.kind === "terminal" && tab.sessionName === recent.id);
      if (nativeTab) {
        openTab({ kind: "terminal", sessionName: recent.id, title: recent.label });
        return;
      }
      openTab({ kind: "terminal", sessionName: recent.id, title: recent.label });
      return;
    }
    if (recent.conversationType === "canonical") {
      if (recent.projectId === null || recent.projectId === undefined) {
        openTab({
          kind: "chat",
          title: recent.label,
          chatId: recent.id,
          chatView: "conversation",
          closable: false,
        });
        return;
      }
      const project = useBoard.getState().projects.find((candidate) => (
        candidate.id === recent.projectId || candidate.slug === recent.projectId
      ));
      const projectSlug = project?.slug ?? recent.projectId;
      useProjectView.getState().setView(projectSlug, "chats");
      openTab({
        kind: "project",
        projectSlug,
        title: project?.name ?? projectSlug,
        chatId: recent.id,
      });
      return;
    }
    const legacyThread = threads.find((candidate) => candidate.id === recent.id);
    if (recent.conversationType === "coding-agent") {
      void openCodingAgentThread(recent.id);
      return;
    }
    if (legacyThread) {
      setActiveThread(legacyThread.id);
      openTab({ kind: "chat", title: "Hermes", closable: false });
      return;
    }
    setActiveThread(null);
    openTab({ kind: "chat", title: "Hermes", closable: false });
    if (api) {
      void openHermesConversation(api, recent.id);
    } else {
      showHermesIndex();
    }
  };

  const isActive = (recent: RecentView) => {
    if (recent.kind === "project") {
      return activeTab?.kind === "project" && activeTab.projectSlug === recent.id;
    }
    if (recent.kind === "terminal") {
      return activeTab?.kind === "terminal" && activeTab.sessionName === recent.id;
    }
    if (recent.conversationType === "coding-agent") {
      return activeTab?.kind === "project" && recent.id === activeCodingAgentThreadId;
    }
    if (recent.conversationType === "canonical") {
      if (recent.projectId === null || recent.projectId === undefined) {
        return activeTab?.kind === "chat" && activeTab.chatId === recent.id;
      }
      const project = useBoard.getState().projects.find((candidate) => (
        candidate.id === recent.projectId || candidate.slug === recent.projectId
      ));
      return activeTab?.kind === "project"
        && activeTab.projectSlug === (project?.slug ?? recent.projectId)
        && activeTab.chatId === recent.id;
    }
    if (recent.conversationType === "hermes") {
      return activeTab?.kind === "chat" && activeThreadId === null && recent.id === hermesSessionId;
    }
    return activeTab?.kind === "chat" && recent.id === activeThreadId;
  };

  return (
    <div className="relative mt-3">
      <div className="flex items-center justify-between px-4 pb-1">
        <span className="text-[11px] font-medium" style={{ color: "var(--text-tertiary)" }}>
          Recents
        </span>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              aria-label="Filter recents"
              className="flex h-5 w-5 items-center justify-center rounded outline-none hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)]"
              style={{ color: recentFilter === "all" ? "var(--text-tertiary)" : "var(--accent)" }}
            >
              <Filter size={12} aria-hidden="true" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              aria-label="Recent type"
              aria-labelledby={undefined}
              align="end"
              sideOffset={4}
              className="w-40 rounded-lg border p-1 shadow-lg outline-none"
              style={{
                zIndex: DESKTOP_Z_INDEX.popover,
                borderColor: "var(--border-default)",
                background: "var(--bg-overlay)",
                boxShadow: "var(--shadow-2)",
              }}
            >
              <DropdownMenu.RadioGroup
                value={recentFilter}
                onValueChange={(value) => setRecentFilter(value as RecentViewFilter)}
              >
                {FILTER_OPTIONS.map((option) => (
                  <DropdownMenu.RadioItem
                    key={option.filter}
                    value={option.filter}
                    className="flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-xs outline-none data-[highlighted]:bg-[var(--bg-hover)]"
                    style={{ color: "var(--text-primary)" }}
                  >
                    <span className="flex w-3 items-center justify-center">
                      <DropdownMenu.ItemIndicator>
                        <Check size={12} aria-hidden="true" />
                      </DropdownMenu.ItemIndicator>
                    </span>
                    {option.label}
                  </DropdownMenu.RadioItem>
                ))}
              </DropdownMenu.RadioGroup>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>

      <div className="flex flex-col gap-0.5 px-2">
        {visible.map((recent) => {
          const active = isActive(recent);
          return (
            <button
              key={`${recent.kind}:${recent.id}`}
              type="button"
              aria-label={`Open recent ${recent.label}`}
              aria-current={active ? "page" : undefined}
              data-active={active ? "true" : "false"}
              className="flex w-full items-center gap-2 rounded-md px-2 text-left text-[13px] outline-none transition-colors hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)]"
              style={sidebarNavRowStyle(active)}
              onClick={() => openRecent(recent)}
            >
              <SidebarIcon active={active}>
                <RecentIcon kind={recent.kind} />
              </SidebarIcon>
              <span className="min-w-0 flex-1 truncate">{recent.label}</span>
            </button>
          );
        })}
        {visible.length === 0 ? (
          <span className="px-2 py-1 text-[13px]" style={{ color: "var(--text-tertiary)" }}>
            No recent {recentFilter === "all" ? "views" : FILTER_OPTIONS.find((option) => option.filter === recentFilter)?.label.toLowerCase()}.
          </span>
        ) : null}
      </div>
    </div>
  );
}
