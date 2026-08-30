import { Sparkles } from "@renderer/lib/hugeicons";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button, EmptyState } from "../../design/primitives";
import RetainedPane from "../../design/RetainedPane";
import { useTabs, type Tab } from "../../stores/tabs";
import { useUi } from "../../stores/ui";
import TaskWorkspace from "../workspace/TaskWorkspace";
import TerminalView from "../terminal/TerminalView";
import SettingsView, { type SettingsSectionId } from "../settings/SettingsView";
import HomeTab from "./HomeTab";
import AppLauncher from "../embeds/AppLauncher";
import TerminalsTab from "../terminal/TerminalsTab";
import EmbedHost from "../embeds/EmbedHost";
import FilesWorkspace from "../files/FilesWorkspace";
import { SURFACE_BASE_BACKGROUND } from "../../design/surface";
import WorkTab from "../work/WorkTab";
import BrowserTab from "../browser/BrowserTab";
import DesktopEditorWorkspace from "../editor/DesktopEditorWorkspace";
import NotesWorkspace from "../notes/NotesWorkspace";

export class TabErrorBoundary extends Component<{
  children: ReactNode;
  tabTitle: string;
  onClose: () => void;
}, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.warn(
      `[tabs] ${this.props.tabTitle} workspace failed (${error.name}; component stack: ${info.componentStack ? "present" : "missing"})`,
    );
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <EmptyState
        icon={<Sparkles size={28} />}
        headline={`${this.props.tabTitle} couldn't open`}
        description="Close this tab and try again. Your project and task data are safe."
        action={<Button variant="primary" onClick={this.props.onClose}>Close tab</Button>}
      />
    );
  }
}

export function TabPane({
  tab,
  active,
  visible = active,
  layoutRevision,
  visualScale = 1,
  settingsSection,
  onSettingsSectionChange,
}: {
  tab: Tab;
  active: boolean;
  visible?: boolean;
  layoutRevision?: string;
  visualScale?: number;
  settingsSection?: SettingsSectionId;
  onSettingsSectionChange?: (section: SettingsSectionId) => void;
}) {
  switch (tab.kind) {
    case "home":
      return <HomeTab active={active} layoutRevision={layoutRevision} visualScale={visualScale} />;
    case "browser":
      return <BrowserTab active={active} layoutRevision={layoutRevision} visualScale={visualScale} />;
    case "work":
      return <WorkTab
        route={tab.workRoute ?? "chat"}
        projectSlug={tab.projectSlug}
        active={active}
        initialChatId={tab.chatId}
        initialChatView={tab.chatView}
        initialChatTitle={tab.chatTitle}
      />;
    case "chat":
      return <WorkTab tabId={tab.id} route="chat" active={active} initialChatId={tab.chatId} initialChatView={tab.chatView} initialChatTitle={tab.chatTitle} />;
    case "terminals":
      return <TerminalsTab active={active} visible={visible} />;
    case "files":
      return <FilesWorkspace />;
    case "editor":
      return <DesktopEditorWorkspace />;
    case "vscode":
      return <EmbedHost kind="code-editor" active={active} layoutRevision={layoutRevision} visualScale={visualScale} />;
    case "notes":
      return <NotesWorkspace active={active} />;
    case "apps":
      return <AppLauncher />;
    case "projects":
      return <WorkTab route="projects" active={active} />;
    case "app":
      return tab.slug
        ? <EmbedHost kind="app" slug={tab.slug} appIdentity={tab.appIdentity} active={active} layoutRevision={layoutRevision} visualScale={visualScale} />
        : null;
    case "project":
      return <WorkTab route="project" projectSlug={tab.projectSlug} active={active} initialChatId={tab.chatId} initialChatTitle={tab.chatTitle} />;
    case "task":
      return tab.taskId ? <TaskWorkspace taskId={tab.taskId} projectSlug={tab.projectSlug} active={active} /> : null;
    case "terminal":
      return tab.sessionName ? <TerminalView sessionName={tab.sessionName} active={active} /> : null;
    case "settings":
      return <SettingsView section={settingsSection} onSectionChange={onSettingsSectionChange} />;
    default:
      return null;
  }
}

export default function TabContent() {
  const tabs = useTabs((s) => s.tabs);
  const activeTabId = useTabs((s) => s.activeTabId);
  const closeTab = useTabs((s) => s.closeTab);
  // A native embed paints above the renderer, so while a modal overlay is open
  // we treat embeds as inactive (detached) — otherwise the palette/composer/
  // dialogs would render behind the embed.
  const overlayOpen = useUi(
    (s) =>
      s.paletteOpen ||
      s.composerOpen ||
      s.quickOpenOpen ||
      s.createTaskOpen ||
      s.createProjectOpen ||
      s.rendererOverlayCount > 0,
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
        const isEmbed = tab.kind === "home" || tab.kind === "app" || tab.kind === "browser" || tab.kind === "vscode";
        const paneActive = active && !(isEmbed && overlayOpen);
        return (
          <RetainedPane
            key={tab.id}
            active={active}
            className="absolute inset-0 flex min-h-0 flex-col"
            background={SURFACE_BASE_BACKGROUND}
            data-tab-id={tab.id}
            data-tab-kind={tab.kind}
          >
            <TabErrorBoundary tabTitle={tab.title} onClose={() => closeTab(tab.id)}>
              <TabPane tab={tab} active={paneActive} />
            </TabErrorBoundary>
          </RetainedPane>
        );
      })}
    </div>
  );
}
