import { Kanban, LogOut, Plus, Settings, SquareTerminal } from "lucide-react";
import { IconButton, StatusDot } from "../../design/primitives";
import { useConnection } from "../../stores/connection";
import { useThreads, type ThreadStatus } from "../../stores/threads";
import { useUi, type MainView } from "../../stores/ui";

const THREAD_STATUS_COLOR: Record<ThreadStatus, string> = {
  running: "var(--status-running)",
  "needs-attention": "var(--status-attention)",
  done: "var(--status-complete)",
  failed: "var(--status-failed)",
  aborted: "var(--status-todo)",
};

function NavRow({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors duration-100"
      style={{
        color: active ? "var(--text-primary)" : "var(--text-secondary)",
        background: active ? "var(--bg-selected)" : "transparent",
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = "var(--bg-hover)";
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = "transparent";
      }}
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  );
}

export default function Sidebar() {
  const view = useUi((s) => s.view);
  const navigate = useUi((s) => s.navigate);
  const setComposerOpen = useUi((s) => s.setComposerOpen);
  const threads = useThreads((s) => s.threads);
  const setActiveThread = useThreads((s) => s.setActiveThread);
  const signOut = useConnection((s) => s.signOut);

  const isView = (kind: MainView["kind"]) => view.kind === kind;

  return (
    <aside
      className="flex w-[228px] shrink-0 flex-col gap-1 p-2"
      style={{ background: "var(--bg-surface)" }}
    >
      <nav className="flex flex-col gap-0.5">
        <NavRow
          icon={<Kanban size={15} />}
          label="Board"
          active={isView("board")}
          onClick={() => navigate({ kind: "board" })}
        />
        <NavRow
          icon={<SquareTerminal size={15} />}
          label="Sessions"
          active={isView("sessions")}
          onClick={() => navigate({ kind: "sessions" })}
        />
      </nav>

      <div className="mt-3 flex items-center justify-between px-2.5">
        <span
          className="text-xs font-semibold tracking-wide uppercase"
          style={{ color: "var(--text-tertiary)" }}
        >
          Threads
        </span>
        <IconButton label="New thread (Cmd+J)" onClick={() => setComposerOpen(true)}>
          <Plus size={13} />
        </IconButton>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
        {threads.length === 0 ? (
          <p className="px-2.5 py-1 text-xs" style={{ color: "var(--text-tertiary)" }}>
            Agent runs appear here. Press ⌘J to start one.
          </p>
        ) : (
          threads.map((thread) => {
            const active = view.kind === "thread" && view.threadId === thread.id;
            return (
              <button
                key={thread.id}
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors duration-100"
                style={{
                  background: active ? "var(--bg-selected)" : "transparent",
                }}
                onMouseEnter={(e) => {
                  if (!active) e.currentTarget.style.background = "var(--bg-hover)";
                }}
                onMouseLeave={(e) => {
                  if (!active) e.currentTarget.style.background = "transparent";
                }}
                onClick={() => {
                  setActiveThread(thread.id);
                  navigate({ kind: "thread", threadId: thread.id });
                }}
              >
                <StatusDot
                  color={THREAD_STATUS_COLOR[thread.status]}
                  pulse={thread.status === "running"}
                />
                <span
                  className="min-w-0 flex-1 truncate text-sm"
                  style={{
                    color: "var(--text-primary)",
                    fontWeight: thread.unread ? 600 : 400,
                  }}
                >
                  {thread.title}
                </span>
              </button>
            );
          })
        )}
      </div>

      <div
        className="flex items-center justify-between border-t pt-2"
        style={{ borderColor: "var(--border-subtle)" }}
      >
        <NavRow
          icon={<Settings size={15} />}
          label="Settings"
          active={isView("settings")}
          onClick={() => navigate({ kind: "settings" })}
        />
        <IconButton
          label="Sign out"
          onClick={() => {
            void signOut().catch((err: unknown) => {
              console.warn(
                "[sidebar] sign-out failed:",
                err instanceof Error ? err.message : String(err),
              );
            });
          }}
        >
          <LogOut size={14} />
        </IconButton>
      </div>
    </aside>
  );
}
