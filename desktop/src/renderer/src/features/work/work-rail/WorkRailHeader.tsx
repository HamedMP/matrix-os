import { chatSearchShortcutLabel } from "@matrix-os/ui";
import { PanelLeftOpenIcon, Plus, Search } from "@renderer/lib/hugeicons";

export function WorkRailHeader({
  onNewChat,
  onCollapse,
  showCollapseControl,
  shortcutAvailable = false,
}: {
  onNewChat: () => void;
  onCollapse: () => void;
  showCollapseControl: boolean;
  shortcutAvailable?: boolean;
}) {
  return (
    <>
      <div data-slot="chat-sidebar-new-chat" className="ml-2.5 mr-[9px] flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          aria-label="New chat"
          className="flex h-8 min-w-0 flex-1 items-center gap-2.5 rounded-[8px] px-2.5 text-left text-[14px] leading-[18px] font-normal transition-colors duration-100 outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
          style={{ color: "var(--matrix-chat-rail-text, var(--text-primary))" }}
          onClick={onNewChat}
        >
          <Plus size={15} aria-hidden />
          <span className="flex-1">New chat</span>
          {shortcutAvailable ? <kbd aria-hidden="true" className="text-[12px] font-normal" style={{ color: "var(--matrix-chat-rail-muted, var(--text-secondary))", fontFamily: "inherit" }}>{/^(Mac|iPhone|iPad|iPod)/i.test(navigator.platform) ? "⌘N" : "Ctrl+N"}</kbd> : null}
        </button>
        {showCollapseControl ? (
          <button
            type="button"
            aria-label="Hide Chat navigation"
            aria-expanded={true}
            aria-controls="work-navigation-pane"
            title="Hide Chat navigation"
            className="flex size-7 shrink-0 items-center justify-center rounded-md outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
            style={{ color: "var(--matrix-chat-rail-muted, var(--text-secondary))" }}
            onClick={onCollapse}
          >
            <PanelLeftOpenIcon size={15} aria-hidden />
          </button>
        ) : null}
      </div>
    </>
  );
}

export function WorkRailSearchControls({ onSearch }: { onSearch: () => void }) {
  return <button type="button" aria-label="Search chats" aria-keyshortcuts="Meta+K Control+K" title="Search chats" className="flex h-8 shrink-0 items-center gap-2.5 rounded-[8px] px-2.5 text-left text-[14px] leading-[18px] font-normal outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]" style={{ color: "var(--matrix-chat-rail-text, var(--text-primary))" }} onClick={onSearch}>
    <Search size={15} aria-hidden /><span className="flex-1">Search</span>
    <kbd aria-hidden="true" className="text-[12px] font-normal" style={{ color: "var(--matrix-chat-rail-muted, var(--text-secondary))", fontFamily: "inherit" }}>{chatSearchShortcutLabel()}</kbd>
  </button>;
}
