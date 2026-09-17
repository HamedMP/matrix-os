import { Filter, MessageSquare, PanelLeftOpenIcon, Plus, Search } from "@renderer/lib/hugeicons";

export function WorkRailHeader({
  onNewChat,
  onSearch,
  unreadOnly,
  onUnreadOnlyChange,
  onCollapse,
  showCollapseControl,
}: {
  onNewChat: () => void;
  onSearch: () => void;
  unreadOnly: boolean;
  onUnreadOnlyChange: (unreadOnly: boolean) => void;
  onCollapse: () => void;
  showCollapseControl: boolean;
}) {
  return (
    <>
      <div data-chat-sidebar-title className="flex items-center gap-0.5">
        <h2 className="flex min-w-0 items-center gap-2 px-2.5 py-2 pr-0 text-lg font-semibold" style={{ color: "var(--text-primary)" }}>
          <MessageSquare size={18} aria-hidden="true" />
          Chats
        </h2>
        <button
          type="button"
          aria-label="Show unread chats only"
          aria-pressed={unreadOnly}
          title={unreadOnly ? "Show all chats" : "Show unread chats only"}
          className="flex size-9 shrink-0 items-center justify-center rounded-md outline-none transition-colors duration-100 hover:bg-[var(--bg-hover)] aria-pressed:bg-[var(--bg-selected)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
          style={{ color: unreadOnly ? "var(--text-primary)" : "var(--text-tertiary)" }}
          onClick={() => onUnreadOnlyChange(!unreadOnly)}
        >
          <Filter size={14} aria-hidden />
        </button>
        <button
          type="button"
          aria-label="Search chats"
          title="Search chats"
          className="ml-auto flex size-9 shrink-0 items-center justify-center rounded-md outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
          style={{ color: "var(--text-tertiary)" }}
          onClick={onSearch}
        >
          <Search size={15} aria-hidden />
        </button>
      </div>
      <div data-slot="chat-sidebar-new-chat" className="flex items-center gap-0.5">
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
