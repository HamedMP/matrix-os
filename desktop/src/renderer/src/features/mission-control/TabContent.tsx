import { Sparkles } from "lucide-react";
import { EmptyState } from "../../design/primitives";
import { useTabs, type Tab } from "../../stores/tabs";
import Board from "../board/Board";
import TaskWorkspace from "../workspace/TaskWorkspace";
import TerminalView from "../terminal/TerminalView";
import ThreadView from "../threads/ThreadView";
import SettingsView from "../settings/SettingsView";
import HomeTab from "./HomeTab";
import AgentsTab from "../threads/AgentsTab";
import ChatTab from "../chat/ChatTab";
import { AppLauncher } from "../embeds";
import TerminalsTab from "../terminal/TerminalsTab";
import EmbedHost from "../embeds/EmbedHost";

function TabPane({ tab, active }: { tab: Tab; active: boolean }) {
  switch (tab.kind) {
    case "home":
      return <HomeTab active={active} />;
    case "chat":
      return <ChatTab />;
    case "terminals":
      return <TerminalsTab />;
    case "apps":
      return <AppLauncher />;
    case "app":
      return tab.slug ? <EmbedHost kind="app" slug={tab.slug} active={active} /> : null;
    case "board":
      return <Board projectSlug={tab.projectSlug} active={active} />;
    case "task":
      return tab.taskId ? <TaskWorkspace taskId={tab.taskId} projectSlug={tab.projectSlug} active={active} /> : null;
    case "terminal":
      return tab.sessionName ? <TerminalView sessionName={tab.sessionName} active={active} /> : null;
    case "agents":
      return <AgentsTab />;
    case "thread":
      return tab.threadId ? <ThreadView threadId={tab.threadId} /> : null;
    case "settings":
      return <SettingsView />;
    default:
      return null;
  }
}

export default function TabContent() {
  const tabs = useTabs((s) => s.tabs);
  const activeTabId = useTabs((s) => s.activeTabId);

  if (tabs.length === 0) {
    return (
      <EmptyState
        icon={<Sparkles size={28} />}
        headline="Your workspace"
        description="Open a project from the sidebar, attach a terminal, or start an agent. Everything opens as a tab here."
      />
    );
  }

  // All tabs stay mounted; only the active one is visible. Terminals and editors
  // keep their state (and reattach on focus) instead of being torn down.
  return (
    <div className="relative min-h-0 flex-1">
      {tabs.map((tab) => {
        const active = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            className="absolute inset-0 flex min-h-0 flex-col"
            style={{ visibility: active ? "visible" : "hidden", zIndex: active ? 1 : 0 }}
            aria-hidden={!active}
            inert={!active}
          >
            <TabPane tab={tab} active={active} />
          </div>
        );
      })}
    </div>
  );
}
