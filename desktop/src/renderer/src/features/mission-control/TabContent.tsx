import { Sparkles } from "@renderer/lib/hugeicons";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button, EmptyState } from "../../design/primitives";
import type { Tab } from "../../stores/tabs";
import TaskWorkspace from "../workspace/TaskWorkspace";
import TerminalView from "../terminal/TerminalView";
import SettingsView, { type SettingsSectionId } from "../settings/SettingsView";
import HomeTab from "./HomeTab";
import AppLauncher from "../embeds/AppLauncher";
import TerminalsTab from "../terminal/TerminalsTab";
import EmbedHost from "../embeds/EmbedHost";
import FilesWorkspace from "../files/FilesWorkspace";
import WorkTab from "../work/WorkTab";

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
