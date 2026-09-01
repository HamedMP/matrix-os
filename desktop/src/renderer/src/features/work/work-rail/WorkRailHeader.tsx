import { MessageSquare, PanelLeftOpenIcon, Plus, Search } from "@renderer/lib/hugeicons";

export function WorkRailHeader({
  onNewChat,
  onSearch,
  onCollapse,
  showCollapseControl,
}: {
  onNewChat: () => void;
  onSearch: () => void;
  onCollapse: () => void;
  showCollapseControl: boolean;
}) {
  return (
    <>
      <div data-chat-sidebar-title className="relative">
        <h2 className="flex items-center gap-2 px-2.5 py-2 pr-10 text-lg font-semibold" style={{ color: "var(--text-primary)" }}>
          <MessageSquare size={18} aria-hidden="true" />
          Chats
        </h2>
        <button
          type="button"
          aria-label="Search chats"
          title="Search chats"
          className="absolute right-1.5 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
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
