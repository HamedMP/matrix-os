import { MessageSquare, MessageSquarePlus, RefreshCw, Sparkles } from "lucide-react";
import type { ApiClient } from "../../lib/api";
import {
  useHermesChat,
  type HermesConversationSummary,
} from "../../stores/hermes-chat";

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
}: {
  conversation: HermesConversationSummary;
  api: ApiClient | null;
}) {
  const sessionId = useHermesChat((state) => state.sessionId);
  const status = useHermesChat((state) => state.status);
  const loadingConversationId = useHermesChat((state) => state.loadingConversationId);
  const openConversation = useHermesChat((state) => state.openConversation);
  const running = conversation.id === sessionId && status !== "idle";
  const loading = loadingConversationId === conversation.id;

  return (
    <button
      type="button"
      aria-label={`${conversation.title} conversation`}
      className="group flex w-full items-start gap-3 rounded-xl border px-4 py-3.5 text-left transition-colors hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
      style={{ background: "var(--bg-surface)", borderColor: "var(--border-subtle)" }}
      disabled={loading || !api}
      onClick={() => {
        if (api) void openConversation(api, conversation.id);
      }}
    >
      <span
        className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
        style={{ background: "var(--bg-sunken)", color: "var(--accent)" }}
      >
        <Sparkles size={15} aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
            {conversation.title}
          </span>
          {running ? (
            <span className="flex shrink-0 items-center gap-1 text-xs" style={{ color: "var(--accent)" }}>
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
              Running
            </span>
          ) : null}
        </span>
        <span className="mt-1 block truncate text-sm" style={{ color: "var(--text-secondary)" }}>
          {conversation.preview || "No messages yet"}
        </span>
        <span className="mt-2 flex items-center gap-1.5 text-xs" style={{ color: "var(--text-tertiary)" }}>
          <span>Hermes</span>
          <span aria-hidden>·</span>
          <span>{conversation.messageCount} {conversation.messageCount === 1 ? "message" : "messages"}</span>
          <span aria-hidden>·</span>
          <span>{relativeActivity(conversation.updatedAt)}</span>
          {loading ? <span>Opening…</span> : null}
        </span>
      </span>
    </button>
  );
}

export function HermesConversationIndex({ api }: { api: ApiClient | null }) {
  const conversations = useHermesChat((state) => state.conversations);
  const indexStatus = useHermesChat((state) => state.indexStatus);
  const indexError = useHermesChat((state) => state.indexError);
  const refreshConversations = useHermesChat((state) => state.refreshConversations);
  const createConversation = useHermesChat((state) => state.createConversation);

  const newConversation = () => {
    if (api) void createConversation(api);
  };
  const retry = () => {
    if (api) void refreshConversations(api);
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-6" aria-labelledby="conversation-index-title">
      <div className="mx-auto flex w-full max-w-[760px] flex-col">
        <div className="mb-5 flex items-center justify-between gap-4">
          <div>
            <h1 id="conversation-index-title" className="text-xl font-semibold tracking-tight" style={{ color: "var(--text-primary)" }}>
              Conversations
            </h1>
            <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
              Continue a persistent conversation with Hermes on this computer.
            </p>
          </div>
          <button
            type="button"
            className="flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-50"
            style={{ background: "var(--bg-selected)", color: "var(--text-primary)" }}
            disabled={!api}
            onClick={newConversation}
          >
            <MessageSquarePlus size={14} aria-hidden />
            New conversation
          </button>
        </div>

        {indexStatus === "loading" && conversations.length === 0 ? (
          <div role="status" aria-label="Loading conversations" className="flex flex-col gap-3">
            {[0, 1, 2].map((item) => (
              <div
                key={item}
                className="h-[92px] animate-pulse rounded-xl border"
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
            <h2 className="mt-4 text-base font-semibold" style={{ color: "var(--text-primary)" }}>Conversations unavailable</h2>
            <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>{indexError}</p>
            <button
              type="button"
              className="mt-4 rounded-lg px-3 py-2 text-sm hover:bg-[var(--bg-hover)]"
              style={{ background: "var(--bg-selected)", color: "var(--text-primary)" }}
              onClick={retry}
            >
              Retry conversations
            </button>
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
            <h2 className="mt-4 text-base font-semibold" style={{ color: "var(--text-primary)" }}>No conversations yet</h2>
            <p className="mt-1 max-w-sm text-sm" style={{ color: "var(--text-secondary)" }}>
              Start a conversation to plan work, ask questions, or continue later from any shell.
            </p>
          </div>
        ) : null}

        {indexError && conversations.length > 0 ? (
          <div role="alert" className="mb-3 rounded-lg border px-3 py-2 text-sm" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
            {indexError}
          </div>
        ) : null}

        {conversations.length > 0 ? (
          <div className="flex flex-col gap-2">
            {conversations.map((conversation) => (
              <ConversationRow key={conversation.id} conversation={conversation} api={api} />
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
