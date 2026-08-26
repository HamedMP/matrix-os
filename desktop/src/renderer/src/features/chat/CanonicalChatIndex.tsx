import type { CanonicalChatRecord } from "@matrix-os/contracts";
import { MessageSquare, Search, X } from "lucide-react";
import { useState } from "react";

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
  onNewChat,
}: {
  items: CanonicalChatRecord[];
  query: string;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  onQueryChange: (query: string) => void;
  onSearch: (query: string) => void;
  onSelect: (chatId: string) => void;
  onNewChat: () => void;
}) {
  const [searchOpen, setSearchOpen] = useState(query.length > 0);
  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-4 sm:px-8" aria-labelledby="canonical-chat-index-title">
      <div data-chat-index-content className="mx-auto flex w-full max-w-[1020px] flex-col">
        <div className="mb-6 flex min-h-[47px] min-w-0 items-center justify-between gap-4">
          <h1 id="canonical-chat-index-title" className="text-[36px] font-medium leading-none tracking-[-0.02em]" style={{ color: "var(--text-primary)", fontFamily: '"Instrument Serif", Georgia, serif' }}>
            Chats
          </h1>
          <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
            {searchOpen ? (
              <form
                className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg border px-2.5 sm:max-w-64"
                style={{ background: "var(--bg-surface)", borderColor: "var(--border-default)" }}
                onSubmit={(event) => { event.preventDefault(); onSearch(query); }}
              >
                <Search size={14} aria-hidden style={{ color: "var(--text-tertiary)" }} />
                <input
                  type="text"
                  role="searchbox"
                  aria-label="Search chats"
                  autoFocus
                  value={query}
                  onChange={(event) => onQueryChange(event.currentTarget.value)}
                  className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                  style={{ color: "var(--text-primary)" }}
                  placeholder="Search chats"
                />
                <button type="button" aria-label="Close search" className="inline-flex h-6 w-6 items-center justify-center rounded-md hover:bg-[var(--bg-hover)]" onClick={() => { setSearchOpen(false); onQueryChange(""); onSearch(""); }}>
                  <X size={13} aria-hidden />
                </button>
              </form>
            ) : (
              <button type="button" aria-label="Search chats" className="inline-flex h-8 w-8 items-center justify-center rounded-lg border hover:bg-[var(--bg-hover)]" style={{ background: "var(--bg-raised)", borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }} onClick={() => setSearchOpen(true)}>
                <Search size={15} aria-hidden />
              </button>
            )}
            <button type="button" className="inline-flex h-8 items-center rounded-lg px-3 text-sm font-medium" style={{ background: "var(--accent)", color: "var(--text-on-accent)" }} onClick={onNewChat}>New chat</button>
          </div>
        </div>

        {error ? <div role="alert" className="mb-3 rounded-lg border px-3 py-2 text-sm" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>{error}</div> : null}
        {status === "loading" && items.length === 0 ? (
          <div role="status" aria-label="Loading chats" className="py-8 text-center text-sm" style={{ color: "var(--text-tertiary)" }}>
            Loading chats…
          </div>
        ) : null}
        {status !== "loading" && items.length === 0 ? (
          <div className="flex min-h-[280px] flex-col items-center justify-center rounded-xl border px-6 text-center" style={{ background: "var(--bg-surface)", borderColor: "var(--border-subtle)" }}>
            <span className="flex h-10 w-10 items-center justify-center rounded-xl" style={{ background: "var(--bg-sunken)", color: "var(--text-tertiary)" }}><MessageSquare size={18} aria-hidden /></span>
            <h2 className="mt-4 text-base font-semibold" style={{ color: "var(--text-primary)" }}>No chats yet</h2>
            <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>Start a chat, then return to it from here.</p>
          </div>
        ) : null}
        {items.length > 0 ? (
          <div data-chat-index-list className="pb-4">
            {items.map((record) => (
              <button key={record.chat.id} type="button" aria-label={record.chat.title} className="flex h-16 w-full items-center gap-6 border-b px-4 text-left last:border-b-0 hover:bg-[var(--bg-hover)]" style={{ borderColor: "var(--border-subtle)" }} onClick={() => onSelect(record.chat.id)}>
                <span className="min-w-0 flex-1 truncate text-base font-medium" style={{ color: "var(--text-primary)" }}>{record.chat.title}</span>
                <span className="flex shrink-0 items-center gap-4">
                  <span className="rounded-full border px-2 py-1 text-xs font-medium capitalize" style={{ borderColor: "var(--border-default)", color: "var(--text-tertiary)" }}>{record.providerBinding?.driverKind?.replace("_", " ") ?? "Chat"}</span>
                  <time className="w-[110px] shrink-0 text-right text-[13px]" style={{ color: "var(--text-tertiary)" }} dateTime={record.chat.updatedAt}>{activityLabel(record.chat.updatedAt)}</time>
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
