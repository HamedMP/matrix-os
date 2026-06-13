import { Sparkles } from "lucide-react";
import { EmptyState } from "../../design/primitives";
import { useTabs, type Tab } from "../../stores/tabs";
import { useUi } from "../../stores/ui";
import Board from "../board/Board";
import TaskWorkspace from "../workspace/TaskWorkspace";
import TerminalView from "../terminal/TerminalView";
import ThreadView from "../threads/ThreadView";
import SettingsView from "../settings/SettingsView";
import HomeTab from "./HomeTab";
import ChatTab from "../chat/ChatTab";
import TerminalsTab from "../terminal/TerminalsTab";
import { AppLauncher, EmbedHost } from "../embeds";

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
      return <Board projectSlug={tab.projectSlug} />;
    case "task":
      return tab.taskId ? <TaskWorkspace taskId={tab.taskId} active={active} /> : null;
    case "terminal":
      return tab.sessionName ? <TerminalView sessionName={tab.sessionName} active={active} /> : null;
    case "agents":
      // Agent threads now live inside the unified chat (rail on the left).
      return <ChatTab />;
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
  // A native embed paints above the renderer, so while a modal overlay is open
  // we treat embeds as inactive (detached) — otherwise the palette/composer/
  // dialogs would render behind the embed.
  const overlayOpen = useUi(
    (s) => s.paletteOpen || s.composerOpen || s.quickOpenOpen || s.createTaskOpen,
  );

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
        // Embeds also detach while a modal overlay is open so it isn't obscured.
        const isEmbed = tab.kind === "home" || tab.kind === "app";
        const paneActive = active && !(isEmbed && overlayOpen);
        return (
          <div
            key={tab.id}
            className="absolute inset-0 flex min-h-0 flex-col"
            style={{ visibility: active ? "visible" : "hidden", zIndex: active ? 1 : 0 }}
            // `inert` (not aria-hidden) on cached-but-hidden tabs: it drops the
            // subtree from focus + the a11y tree, so a focused element inside a
            // hidden tab can't trigger the aria-hidden-on-focused-ancestor warning.
            inert={!active}
          >
            <TabPane tab={tab} active={paneActive} />
          </div>
        );
      })}
    </div>
  );
}
