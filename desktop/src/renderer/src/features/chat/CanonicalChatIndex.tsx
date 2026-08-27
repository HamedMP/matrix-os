import type { CanonicalChatRecord } from "@matrix-os/contracts";
import { MessageSquare, Plus, Search, Trash2, X } from "lucide-react";
import { useState } from "react";

import { OSWindowSafeView } from "../desktop-shell/OSWindow";

function activityLabel(timestamp: string): string {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 1_000));
  if (elapsedSeconds < 60) return "Just now";
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}d ago` : new Date(timestamp).toLocaleDateString();
}

export function CanonicalChatIndex({
  items,
  query,
  status,
  error,
  onQueryChange,
  onSearch,
  onSelect,
  onDelete,
  onNewChat,
}: {
  items: CanonicalChatRecord[];
  query: string;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  onQueryChange: (query: string) => void;
  onSearch: (query: string) => void;
  onSelect: (chatId: string) => void;
  onDelete: (record: CanonicalChatRecord) => void;
  onNewChat: () => void;
}) {
  const [searchOpen, setSearchOpen] = useState(query.length > 0);

  return (
    <OSWindowSafeView area="sidebar" className="h-full min-h-0 w-[280px] min-w-[200px] max-w-[280px] shrink-0">
      <aside
        aria-label="Global chats"
        className="flex h-full min-h-0 w-full flex-col border-r"
        style={{ borderColor: "var(--border-default, #F3F2F2)" }}
      >
        <header className="flex shrink-0 items-center justify-between border-b px-4 py-2" style={{ borderColor: "var(--border-default, #F3F2F2)" }}>
          <div className="flex min-w-0 items-center gap-1">
            <MessageSquare size={16} aria-hidden="true" />
            <h1 aria-label="Chats" className="truncate text-base font-medium tracking-[-0.4px]" style={{ color: "var(--text-primary)" }}>Chat</h1>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Search chats"
              className="flex size-6 items-center justify-center rounded-md hover:bg-[var(--bg-hover)]"
              style={{ color: "var(--text-secondary)" }}
              onClick={() => setSearchOpen((open) => !open)}
            >
              <Search size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="New chat"
              className="flex size-6 items-center justify-center rounded-md text-white"
              style={{ background: "var(--surface-overlay, #242323)" }}
              onClick={onNewChat}
            >
              <Plus size={16} aria-hidden="true" />
            </button>
          </div>
        </header>

        {searchOpen ? (
          <form
            className="mx-3 my-2 flex h-8 shrink-0 items-center gap-2 rounded-lg border px-2"
            style={{ borderColor: "var(--border-default)", background: "var(--bg-surface)" }}
            onSubmit={(event) => { event.preventDefault(); onSearch(query); }}
          >
            <Search size={14} aria-hidden="true" style={{ color: "var(--text-tertiary)" }} />
            <input
              type="text"
              role="searchbox"
              aria-label="Search chats"
              autoFocus
              value={query}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none"
              style={{ color: "var(--text-primary)" }}
              placeholder="Search chats"
              onChange={(event) => onQueryChange(event.currentTarget.value)}
            />
            <button
              type="button"
              aria-label="Close search"
              className="flex size-5 items-center justify-center rounded hover:bg-[var(--bg-hover)]"
              onClick={() => { setSearchOpen(false); onQueryChange(""); onSearch(""); }}
            >
              <X size={13} aria-hidden="true" />
            </button>
          </form>
        ) : null}

        {error ? <div role="alert" className="mx-3 mt-2 rounded-lg px-2 py-2 text-xs" style={{ color: "var(--text-secondary)", background: "var(--bg-sunken)" }}>{error}</div> : null}
        {status === "loading" && items.length === 0 ? (
          <div role="status" aria-label="Loading chats" className="px-4 py-3 text-xs" style={{ color: "var(--text-tertiary)" }}>
            Loading chats…
          </div>
        ) : null}
        {status !== "loading" && items.length === 0 ? (
          <p className="px-4 py-3 text-xs" style={{ color: "var(--text-tertiary)" }}>No chats yet.</p>
        ) : null}
        {items.length > 0 ? (
          <ul aria-label="Chat history" className="min-h-0 flex-1 overflow-y-auto pb-4">
            {items.map((record) => (
              <li key={record.chat.id} className="group/chat relative shrink-0 border-b" style={{ borderColor: "var(--border-default, #F3F2F2)" }}>
                <button
                  type="button"
                  aria-label={record.chat.title}
                  className="flex min-h-14 w-full min-w-0 items-center px-4 py-3 pr-24 text-left hover:bg-[var(--bg-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
                  onClick={() => onSelect(record.chat.id)}
                >
                  <span className="min-w-0 flex-1 truncate text-sm" style={{ color: "var(--text-primary)" }}>{record.chat.title}</span>
                </button>
                <time className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-xs transition-opacity group-hover/chat:opacity-0" style={{ color: "var(--text-tertiary)" }} dateTime={record.chat.updatedAt}>
                  {activityLabel(record.chat.updatedAt)}
                </time>
                <button
                  type="button"
                  aria-label={`Delete ${record.chat.title}`}
                  className="absolute right-3 top-1/2 z-10 flex size-6 -translate-y-1/2 items-center justify-center rounded-md bg-[var(--surface-base-background,#FFFFFD)] text-[var(--text-tertiary)] opacity-0 transition-opacity hover:bg-[var(--bg-hover)] hover:text-[var(--danger)] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] group-hover/chat:opacity-100"
                  onClick={() => onDelete(record)}
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </aside>
    </OSWindowSafeView>
  );
}
