import type { ReactNode } from "react";
import { Activity, FileDiff, FolderOpen, Globe, SquareTerminal, type LucideIcon } from "lucide-react";
import {
  InspectorTabShell,
  type InspectorTabDefinition,
} from "../chat/InspectorTabShell";

export type AgentConversationInspectorTab = "changes" | "files" | "terminal" | "preview" | "activity";

interface InspectorCounts {
  changes: number;
  terminal: number;
  preview: number;
  activity: number;
  files?: number;
}

interface AgentConversationInspectorProps {
  defaultTab: AgentConversationInspectorTab;
  tabs?: readonly AgentConversationInspectorTab[];
  selectedTab?: AgentConversationInspectorTab;
  onTabChange?: (tab: AgentConversationInspectorTab) => void;
  changesFocusRequestId?: number;
  changesFocusConsumedId?: number;
  onChangesFocusConsumed?: (requestId: number) => void;
  counts: InspectorCounts;
  toolbar: ReactNode;
  composer?: ReactNode;
  changes: ReactNode;
  files?: ReactNode;
  terminal: ReactNode;
  preview: ReactNode;
  activity: ReactNode;
}

const TAB_LABELS: Record<AgentConversationInspectorTab, string> = {
  changes: "Changes",
  files: "Files",
  terminal: "Terminal",
  preview: "Preview",
  activity: "Activity",
};

const TAB_ICONS: Record<AgentConversationInspectorTab, LucideIcon> = {
  changes: FileDiff,
  files: FolderOpen,
  terminal: SquareTerminal,
  preview: Globe,
  activity: Activity,
};

export function AgentConversationInspector({
  defaultTab,
  tabs: requestedTabs,
  selectedTab,
  onTabChange,
  changesFocusRequestId = 0,
  changesFocusConsumedId = 0,
  onChangesFocusConsumed,
  counts,
  toolbar,
  composer,
  changes,
  files,
  terminal,
  preview,
  activity,
}: AgentConversationInspectorProps) {
  const defaultTabs: AgentConversationInspectorTab[] = files === undefined
    ? ["changes", "terminal", "preview", "activity"]
    : ["changes", "files", "terminal", "preview", "activity"];
  const tabIds = requestedTabs && requestedTabs.length > 0 ? [...requestedTabs] : defaultTabs;
  const content: Record<AgentConversationInspectorTab, ReactNode> = {
    changes,
    files,
    terminal,
    preview,
    activity,
  };
  const tabs: Array<InspectorTabDefinition<AgentConversationInspectorTab>> = tabIds.map((tab) => ({
    id: tab,
    label: TAB_LABELS[tab],
    icon: TAB_ICONS[tab],
    count: counts[tab],
    content: content[tab],
  }));

  return (
    <InspectorTabShell
      ariaLabel="Conversation tools"
      tabs={tabs}
      defaultTab={defaultTab}
      selectedTab={selectedTab}
      onTabChange={onTabChange}
      selectionRequest={{
        id: changesFocusRequestId,
        consumedId: changesFocusConsumedId,
        tab: "changes",
        onConsumed: onChangesFocusConsumed,
      }}
      header={(
        <div className="space-y-3">
          {toolbar}
          {composer}
        </div>
      )}
    />
  );
}
