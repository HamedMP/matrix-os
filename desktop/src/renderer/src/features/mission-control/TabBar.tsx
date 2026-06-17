import {
  FileCode2,
  Home,
  Kanban,
  MessageSquare,
  Settings,
  SquareTerminal,
  X,
  type LucideIcon,
} from "lucide-react";
import { useTabs, type Tab, type TabKind } from "../../stores/tabs";

const TAB_ICON: Record<TabKind, LucideIcon> = {
  home: Home,
  board: Kanban,
  task: FileCode2,
  terminal: SquareTerminal,
  agents: MessageSquare,
  thread: MessageSquare,
  settings: Settings,
};

function TabChip({ tab, active }: { tab: Tab; active: boolean }) {
  const focusTab = useTabs((s) => s.focusTab);
  const closeTab = useTabs((s) => s.closeTab);
  const Icon = TAB_ICON[tab.kind];

  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={0}
      onClick={() => focusTab(tab.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter") focusTab(tab.id);
      }}
      onAuxClick={(e) => {
        if (e.button === 1 && tab.closable) closeTab(tab.id);
      }}
      className="no-drag group flex h-[30px] max-w-[200px] min-w-0 shrink-0 cursor-default items-center gap-1.5 rounded-md px-2.5 text-sm transition-colors duration-100"
      style={{
        background: active ? "var(--bg-surface)" : "transparent",
        color: active ? "var(--text-primary)" : "var(--text-secondary)",
        boxShadow: active ? "var(--shadow-1)" : "none",
        border: active ? "1px solid var(--border-subtle)" : "1px solid transparent",
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = "var(--bg-hover)";
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = "transparent";
      }}
    >
      <Icon size={13} style={{ color: active ? "var(--accent)" : "var(--text-tertiary)", flexShrink: 0 }} />
      <span className="min-w-0 flex-1 truncate">{tab.title}</span>
      {tab.closable ? (
        <button
          type="button"
          aria-label={`Close ${tab.title}`}
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded opacity-0 transition-opacity duration-100 group-hover:opacity-100 hover:bg-[var(--bg-active)]"
          onClick={(e) => {
            e.stopPropagation();
            closeTab(tab.id);
          }}
        >
          <X size={11} />
        </button>
      ) : null}
    </div>
  );
}

export default function TabBar() {
  const tabs = useTabs((s) => s.tabs);
  const activeTabId = useTabs((s) => s.activeTabId);

  if (tabs.length === 0) return null;

  return (
    <div
      className="titlebar-drag flex shrink-0 items-center gap-1 overflow-x-auto border-b px-2"
      style={{ height: "var(--tabbar-height)", borderColor: "var(--border-subtle)", background: "var(--bg-sunken)" }}
    >
      {tabs.map((tab) => (
        <TabChip key={tab.id} tab={tab} active={tab.id === activeTabId} />
      ))}
    </div>
  );
}
