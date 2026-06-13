import { MessageSquarePlus, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, EmptyState, StatusDot } from "../../design/primitives";
import { useThreads, type ThreadStatus } from "../../stores/threads";
import { useUi } from "../../stores/ui";
import ThreadView from "./ThreadView";

const STATUS_COLOR: Record<ThreadStatus, string> = {
  running: "var(--status-running)",
  "needs-attention": "var(--status-attention)",
  done: "var(--status-complete)",
  failed: "var(--status-failed)",
  aborted: "var(--status-todo)",
};

// Codex-shaped cockpit: a list of parallel agent threads on the left, the
// selected transcript on the right.
export default function AgentsTab() {
  const threads = useThreads((s) => s.threads);
  const activeThreadId = useThreads((s) => s.activeThreadId);
  const setActiveThread = useThreads((s) => s.setActiveThread);
  const setComposerOpen = useUi((s) => s.setComposerOpen);
  const [localId, setLocalId] = useState<string | null>(null);

  // Prefer the store's active thread (e.g. just started from the composer),
  // then the local pick, then the newest thread.
  const selectedId = activeThreadId ?? localId ?? threads[0]?.id ?? null;

  useEffect(() => {
    if (!localId && threads[0]) setLocalId(threads[0].id);
  }, [threads, localId]);

  const selected = threads.find((t) => t.id === selectedId) ?? null;

  return (
    <div className="flex min-h-0 flex-1">
      <div
        className="flex w-[280px] shrink-0 flex-col border-r"
        style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
      >
        <div className="flex items-center justify-between border-b px-3 py-2.5" style={{ borderColor: "var(--border-subtle)" }}>
          <span className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Agent threads</span>
          <Button variant="subtle" onClick={() => setComposerOpen(true)}>
            <MessageSquarePlus size={13} />
            New
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-1.5">
          {threads.length === 0 ? (
            <p className="px-2.5 py-2 text-xs" style={{ color: "var(--text-tertiary)" }}>
              No runs yet. Press ⌘J to start one.
            </p>
          ) : (
            threads.map((thread) => {
              const active = thread.id === selectedId;
              return (
                <button
                  key={thread.id}
                  type="button"
                  className="flex items-start gap-2 rounded-md px-2.5 py-2 text-left transition-colors duration-100"
                  style={{ background: active ? "var(--bg-selected)" : "transparent" }}
                  onMouseEnter={(e) => {
                    if (!active) e.currentTarget.style.background = "var(--bg-hover)";
                  }}
                  onMouseLeave={(e) => {
                    if (!active) e.currentTarget.style.background = "transparent";
                  }}
                  onClick={() => {
                    setLocalId(thread.id);
                    setActiveThread(thread.id);
                  }}
                >
                  <span className="mt-1">
                    <StatusDot color={STATUS_COLOR[thread.status]} pulse={thread.status === "running"} />
                  </span>
                  <span
                    className="min-w-0 flex-1 truncate text-sm"
                    style={{ color: "var(--text-primary)", fontWeight: thread.unread ? 600 : 400 }}
                  >
                    {thread.title}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {selected ? (
          <ThreadView threadId={selected.id} embedded />
        ) : (
          <EmptyState
            icon={<Sparkles size={26} />}
            headline="No agent selected"
            description="Start an agent run with ⌘J and watch it work here. Run several in parallel."
            action={
              <Button variant="primary" onClick={() => setComposerOpen(true)}>
                Start an agent
              </Button>
            }
          />
        )}
      </div>
    </div>
  );
}
