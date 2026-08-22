import { useEffect, useMemo, useState } from "react";
import {
  MessageSquare,
  MessageSquarePlus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "../../design/primitives";
import type { ApiClient } from "../../lib/api";
import {
  useHermesChat,
  type HermesConversationSummary,
} from "../../stores/hermes-chat";
import { useTabs } from "../../stores/tabs";
import { DeleteConversationDialog } from "./DeleteConversationDialog";
import { filterConversations } from "./conversation-search";

function relativeActivity(timestamp: number): string {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
  if (elapsedSeconds < 60) return "Just now";
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

function ConversationRow({
  conversation,
  api,
  onRequestDelete,
}: {
  conversation: HermesConversationSummary;
  api: ApiClient | null;
  onRequestDelete: (conversation: HermesConversationSummary) => void;
}) {
  const sessionId = useHermesChat((state) => state.sessionId);
  const status = useHermesChat((state) => state.status);
  const loadingConversationId = useHermesChat((state) => state.loadingConversationId);
  const deletingConversationId = useHermesChat((state) => state.deletingConversationId);
  const openConversation = useHermesChat((state) => state.openConversation);
  const running = conversation.id === sessionId && status !== "idle";
  const loading = loadingConversationId === conversation.id;
  const deleting = deletingConversationId === conversation.id;
  const runningDescriptionId = `delete-running-${conversation.id}`;
  const openSelectedConversation = async () => {
    if (!api) return;
    await openConversation(api, conversation.id);
  };

  return (
    <div
      data-conversation-row
      className="group relative flex h-16 items-stretch border-b last:border-b-0"
      style={{ borderColor: "var(--border-subtle)" }}
    >
      <button
        type="button"
        aria-label={`${conversation.title} conversation`}
        className="min-w-0 flex-1 px-4 pr-14 text-left transition-colors hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-[-2px]"
        disabled={loading || !api}
        onClick={() => void openSelectedConversation()}
      >
        <span className="flex h-full min-w-0 items-center gap-4">
          <span className="min-w-0 flex-1 truncate text-base font-medium" style={{ color: "var(--text-primary)" }}>
            {conversation.title}
          </span>
          <span
            data-conversation-metadata
            className="flex shrink-0 items-center gap-5 text-xs"
            style={{ color: "var(--text-tertiary)" }}
          >
            <span className="rounded-full border px-2 py-1 font-medium" style={{ borderColor: "var(--border-default)" }}>
              {{ claude: "Claude", codex: "Codex", pi: "Pi" }[conversation.providerId] ?? "Claude"}
            </span>
            {running ? (
              <span className="flex items-center gap-1.5" style={{ color: "var(--accent)" }}>
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" aria-hidden />
                Running
              </span>
            ) : loading ? <span>Opening…</span> : (
              <time dateTime={new Date(conversation.updatedAt).toISOString()}>{relativeActivity(conversation.updatedAt)}</time>
            )}
          </span>
        </span>
      </button>
      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center justify-center">
        <button
          type="button"
          aria-label={`Delete ${conversation.title}`}
          aria-describedby={running ? runningDescriptionId : undefined}
          className="pointer-events-none inline-flex h-8 w-8 items-center justify-center rounded-md opacity-0 transition-colors hover:bg-[var(--danger-muted)] focus:bg-[var(--danger-muted)] focus:opacity-100 focus:pointer-events-auto focus-visible:outline-2 focus-visible:outline-[var(--danger)] group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto disabled:cursor-not-allowed disabled:opacity-40"
          style={{ color: "var(--danger)" }}
          disabled={!api || running || deleting || deletingConversationId !== null}
          onClick={() => onRequestDelete(conversation)}
        >
          <Trash2 size={14} aria-hidden />
        </button>
        {running ? (
          <span id={runningDescriptionId} className="sr-only">
            Stop the active response before deleting this chat.
          </span>
        ) : null}
      </span>
    </div>
  );
}

function HermesConversationIndexContent({ api }: { api: ApiClient | null }) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<HermesConversationSummary | null>(null);
  const conversations = useHermesChat((state) => state.conversations);
  const isConversationIndexComplete = useHermesChat((state) => state.isConversationIndexComplete);
  const indexStatus = useHermesChat((state) => state.indexStatus);
  const indexError = useHermesChat((state) => state.indexError);
  const deletingConversationId = useHermesChat((state) => state.deletingConversationId);
  const deleteError = useHermesChat((state) => state.deleteError);
  const refreshConversations = useHermesChat((state) => state.refreshConversations);
  const createConversation = useHermesChat((state) => state.createConversation);
  const deleteConversation = useHermesChat((state) => state.deleteConversation);
  const clearDeleteError = useHermesChat((state) => state.clearDeleteError);
  const removeRecentView = useTabs((state) => state.removeRecentView);
  const reconcileRecentHermesConversations = useTabs((state) => state.reconcileRecentHermesConversations);
  const filteredConversations = useMemo(
    () => filterConversations(conversations, query),
    [conversations, query],
  );

  useEffect(() => {
    if (indexStatus !== "ready" || !isConversationIndexComplete) return;
    reconcileRecentHermesConversations(conversations.map((conversation) => conversation.id));
  }, [conversations, indexStatus, isConversationIndexComplete, reconcileRecentHermesConversations]);

  const closeSearch = () => {
    setQuery("");
    setSearchOpen(false);
  };
  const closeDelete = () => {
    if (deletingConversationId) return;
    clearDeleteError();
    setDeleteTarget(null);
  };
  const confirmDelete = async () => {
    if (!api || !deleteTarget) return;
    if (await deleteConversation(api, deleteTarget.id)) {
      removeRecentView("conversation", deleteTarget.id);
      setDeleteTarget(null);
    }
  };
  const startConversation = async () => {
    if (!api) return;
    await createConversation(api);
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-4 sm:px-8" aria-labelledby="conversation-index-title">
      <div data-chat-index-content className="mx-auto flex w-full max-w-[1020px] flex-col">
        <div data-chat-index-header className="mb-2 flex min-h-[47px] min-w-0 items-center justify-between gap-4">
          <h1 id="conversation-index-title" className="text-[36px] font-medium leading-none tracking-[-0.02em]" style={{ color: "var(--text-primary)", fontFamily: '"Instrument Serif", Georgia, serif' }}>
            Chats
          </h1>
          <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
            {searchOpen ? (
              <div
                className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg border px-2.5 sm:max-w-64"
                style={{ background: "var(--bg-surface)", borderColor: "var(--border-default)" }}
              >
                <Search size={14} aria-hidden style={{ color: "var(--text-tertiary)" }} />
                <input
                  type="text"
                  role="searchbox"
                  aria-label="Search chats"
                  autoFocus
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") closeSearch();
                  }}
                  className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                  style={{ color: "var(--text-primary)" }}
                  placeholder="Search chats"
                />
                <button
                  type="button"
                  aria-label="Close search"
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                  style={{ color: "var(--text-tertiary)" }}
                  onClick={closeSearch}
                >
                  <X size={13} aria-hidden />
                </button>
              </div>
            ) : (
              <button
                type="button"
                aria-label="Search chats"
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border transition-colors hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                style={{ background: "var(--bg-raised)", borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}
                onClick={() => setSearchOpen(true)}
              >
                <Search size={15} aria-hidden />
              </button>
            )}
            <Button
              variant="primary"
              className="h-8"
              disabled={!api}
              onClick={() => void startConversation()}
            >
              <MessageSquarePlus size={14} aria-hidden />
              New chat
            </Button>
          </div>
        </div>

        {indexStatus === "loading" && conversations.length === 0 ? (
          <div role="status" aria-label="Loading chats" className="overflow-hidden rounded-xl border">
            {[0, 1, 2].map((item) => (
              <div
                key={item}
                className="h-16 animate-pulse border-b last:border-b-0"
                style={{ background: "var(--bg-surface)", borderColor: "var(--border-subtle)" }}
              />
            ))}
          </div>
        ) : null}

        {indexStatus === "error" && conversations.length === 0 ? (
          <div
            role="alert"
            className="flex min-h-[280px] flex-col items-center justify-center rounded-xl border px-6 text-center"
            style={{ background: "var(--bg-surface)", borderColor: "var(--border-subtle)" }}
          >
            <RefreshCw size={22} style={{ color: "var(--text-tertiary)" }} aria-hidden />
            <h2 className="mt-4 text-base font-semibold" style={{ color: "var(--text-primary)" }}>Chats unavailable</h2>
            <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>{indexError}</p>
            <Button variant="subtle" className="mt-4" onClick={() => { if (api) void refreshConversations(api); }}>
              Retry chats
            </Button>
          </div>
        ) : null}

        {indexStatus !== "loading" && indexStatus !== "error" && conversations.length === 0 ? (
          <div
            className="flex min-h-[280px] flex-col items-center justify-center rounded-xl border px-6 text-center"
            style={{ background: "var(--bg-surface)", borderColor: "var(--border-subtle)" }}
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-xl" style={{ background: "var(--bg-sunken)", color: "var(--text-tertiary)" }}>
              <MessageSquare size={18} aria-hidden />
            </span>
            <h2 className="mt-4 text-base font-semibold" style={{ color: "var(--text-primary)" }}>No chats yet</h2>
            <p className="mt-1 max-w-sm text-sm" style={{ color: "var(--text-secondary)" }}>
              Start a chat with Claude or Codex, then return to it from any shell.
            </p>
          </div>
        ) : null}

        {indexError && conversations.length > 0 ? (
          <div role="alert" className="mb-3 rounded-lg border px-3 py-2 text-sm" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
            {indexError}
          </div>
        ) : null}

        {conversations.length > 0 && filteredConversations.length === 0 ? (
          <div className="flex min-h-[220px] flex-col items-center justify-center rounded-xl border px-6 text-center" style={{ borderColor: "var(--border-subtle)" }}>
            <Search size={20} aria-hidden style={{ color: "var(--text-tertiary)" }} />
            <h2 className="mt-3 text-sm font-semibold" style={{ color: "var(--text-primary)" }}>No matching chats</h2>
            <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>Try a different title or message.</p>
          </div>
        ) : null}

        {filteredConversations.length > 0 ? (
          <div data-chat-index-list>
            {filteredConversations.map((conversation) => (
              <ConversationRow
                key={conversation.id}
                conversation={conversation}
                api={api}
                onRequestDelete={(target) => {
                  clearDeleteError();
                  setDeleteTarget(target);
                }}
              />
            ))}
          </div>
        ) : null}
      </div>

      <DeleteConversationDialog
        conversation={deleteTarget}
        deleting={deleteTarget?.id === deletingConversationId}
        error={deleteError}
        onCancel={closeDelete}
        onConfirm={() => void confirmDelete()}
      />
    </section>
  );
}

export function HermesConversationIndex({ api }: { api: ApiClient | null }) {
  const runtimeSequence = useHermesChat((state) => state.indexSequence);
  return <HermesConversationIndexContent key={runtimeSequence} api={api} />;
}
