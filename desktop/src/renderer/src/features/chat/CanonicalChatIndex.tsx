import type { CanonicalChatRecord } from "@matrix-os/contracts";
import { ChatHistory, isChatUnread } from "@matrix-os/ui";
import { Plus, Search } from "@renderer/lib/hugeicons";
import { OSWindowSafeView } from "../desktop-shell/OSWindow";

/** Native chrome adapter; all navigation/presentation belongs to shared Chat. */
export function CanonicalChatIndex({ items, activeChatId, status, error, onSearch,
  onSelect, onToggleRead, onDelete, onNewChat, onRename, layout = "wide",
}: {
  items: CanonicalChatRecord[];
  activeChatId: string | null;
  query: string;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  onQueryChange(query: string): void;
  onSearch(query: string): void;
  onSelect(chatId: string): void;
  onToggleRead?(record: CanonicalChatRecord): void;
  onDelete(record: CanonicalChatRecord): void;
  onNewChat(): void;
  onRename?(id: string, title: string): Promise<boolean>;
  layout?: "wide" | "narrow";
}) {
  return <OSWindowSafeView area="sidebar" data-layout={layout} className={layout === "narrow"
    ? "h-[220px] min-h-[120px] w-full max-w-none shrink-0"
    : "h-full min-h-0 w-[240px] min-w-[200px] max-w-[240px] shrink-0"}>
    <aside aria-label="Global chats" className={`flex h-full min-h-0 flex-col ${layout === "narrow" ? "border-b" : "border-r"}`}
      style={{ borderColor: "var(--chat-border)" }}>
      <ChatHistory items={items.map(record => ({ id: record.chat.id, title: record.chat.title,
        preview: record.chat.lastMessagePreview, updatedAt: Date.parse(record.chat.activityAt ?? record.chat.updatedAt),
        unread: isChatUnread(record), conversationKind: record.chat.conversationKind }))}
        activeChatId={activeChatId} loading={status === "loading"} error={error}
        onSelect={onSelect} onNewChat={onNewChat} onRename={onRename} onQueryChange={onSearch}
        onToggleRead={onToggleRead ? id => { const record = items.find(item => item.chat.id === id); if (record) onToggleRead(record); } : undefined}
        onDelete={id => { const record = items.find(item => item.chat.id === id); if (record) onDelete(record); }}
        searchIcon={<Search size={16} aria-hidden />} newChatIcon={<Plus size={16} aria-hidden />} />
    </aside>
  </OSWindowSafeView>;
}
