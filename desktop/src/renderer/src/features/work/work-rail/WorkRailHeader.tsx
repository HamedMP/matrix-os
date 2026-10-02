import { Filter, PanelLeftOpenIcon, Plus, Search } from "@renderer/lib/hugeicons";

export function WorkRailHeader({
  onNewChat,
  onCollapse,
  showCollapseControl,
}: {
  onNewChat: () => void;
  onCollapse: () => void;
  showCollapseControl: boolean;
}) {
  return (
    <>
      <div data-slot="chat-sidebar-new-chat" className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm font-medium transition-colors duration-100 outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
          style={{ color: "var(--text-secondary)" }}
          onClick={onNewChat}
        >
          <Plus size={15} aria-hidden />
          New chat
        </button>
        {showCollapseControl ? (
          <button
            type="button"
            aria-label="Hide Chat navigation"
            aria-expanded={true}
            aria-controls="work-navigation-pane"
            title="Hide Chat navigation"
            className="flex size-7 shrink-0 items-center justify-center rounded-md outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
            style={{ color: "var(--text-tertiary)" }}
            onClick={onCollapse}
          >
            <PanelLeftOpenIcon size={15} aria-hidden />
          </button>
        ) : null}
      </div>
    </>
  );
}

export function WorkRailSearchControls({ onSearch, unreadOnly, onUnreadOnlyChange }: {
  onSearch: () => void;
  unreadOnly: boolean;
  onUnreadOnlyChange: (value: boolean) => void;
}) {
  return <div className="flex shrink-0 items-center gap-0.5">
    <button type="button" aria-label="Search chats" title="Search chats" className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm font-medium outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]" style={{ color: "var(--text-secondary)" }} onClick={onSearch}>
      <Search size={15} aria-hidden />Search
    </button>
    <button type="button" aria-label={unreadOnly ? "Show all chats" : "Show unread chats only"} aria-pressed={unreadOnly} title={unreadOnly ? "Show all chats" : "Show unread chats only"} className="grid size-7 shrink-0 place-items-center rounded-md outline-none hover:bg-[var(--bg-hover)] aria-pressed:bg-[var(--bg-selected)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]" style={{ color: "var(--text-tertiary)" }} onClick={() => onUnreadOnlyChange(!unreadOnly)}><Filter size={14} aria-hidden /></button>
  </div>;
}
