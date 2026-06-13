import { GitBranch, Laptop, MessageSquarePlus, Sparkles, SquareTerminal } from "lucide-react";
import { useState } from "react";
import { StatusDot } from "../../design/primitives";
import { groupMessages } from "../../lib/chat";
import { useBoard } from "../../stores/board";
import { useHermesChat } from "../../stores/hermes-chat";
import { useThreads, type ThreadStatus } from "../../stores/threads";
import { useUi } from "../../stores/ui";
import ThreadView from "../threads/ThreadView";
import { Conversation, ConversationContent, ConversationEmptyState } from "./elements/conversation";
import { Message, MessageContent, MessageResponse } from "./elements/message";
import { PromptInput } from "./elements/prompt-input";
import { Reasoning } from "./elements/reasoning";
import { Tool } from "./elements/tool";

const STATUS_COLOR: Record<ThreadStatus, string> = {
  running: "var(--status-running)",
  "needs-attention": "var(--status-attention)",
  done: "var(--status-complete)",
  failed: "var(--status-failed)",
  aborted: "var(--status-todo)",
};

function Pill({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm transition-colors hover:bg-[var(--bg-hover)]"
      style={{ color: "var(--text-secondary)" }}
    >
      {icon}
      {label}
    </button>
  );
}

function ConnectCard({ title, body, done }: { title: string; body: string; done?: boolean }) {
  return (
    <div
      className="flex flex-col gap-1.5 rounded-xl border p-4 text-left"
      style={{ background: "var(--bg-surface)", borderColor: "var(--border-subtle)", opacity: done ? 0.55 : 1 }}
    >
      <div className="flex items-center justify-between">
        <div className="h-6 w-6 rounded" style={{ background: "var(--bg-sunken)" }} />
        {done ? <span className="text-xs" style={{ color: "var(--success)" }}>✓</span> : null}
      </div>
      <span className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{title}</span>
      <span className="text-xs leading-relaxed" style={{ color: "var(--text-secondary)" }}>{body}</span>
    </div>
  );
}

// The Hermes (OS agent) conversation — the default pane when no agent thread is
// selected in the rail.
function HermesPane() {
  const messages = useHermesChat((s) => s.messages);
  const status = useHermesChat((s) => s.status);
  const send = useHermesChat((s) => s.send);
  const abort = useHermesChat((s) => s.abort);
  const projects = useBoard((s) => s.projects);
  const [draft, setDraft] = useState("");

  const projectName = projects[0]?.name ?? projects[0]?.slug ?? "Matrix OS";
  const groups = groupMessages(messages);
  const empty = messages.length === 0;

  const submit = () => {
    if (draft.trim().length === 0) return;
    send(draft);
    setDraft("");
  };

  const composerFooter = (
    <>
      <Pill icon={<SquareTerminal size={13} />} label={projectName} />
      <Pill icon={<Laptop size={13} />} label="On VPS" />
      <Pill icon={<GitBranch size={13} />} label="main" />
    </>
  );

  if (empty) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="mx-auto flex w-full max-w-[760px] flex-1 flex-col justify-center px-5">
          <h1 className="mb-8 text-center text-2xl font-semibold tracking-tight" style={{ color: "var(--text-primary)", fontSize: "var(--text-2xl)" }}>
            What should we build in {projectName}?
          </h1>
          <PromptInput value={draft} onChange={setDraft} onSubmit={submit} onAbort={abort} busy={status !== "idle"} autoFocus footer={composerFooter} />
          <div className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-3">
            <ConnectCard title="Connect messaging" body="Get context from recent team discussions" />
            <ConnectCard title="Connect email" body="Summarize stakeholder asks from email" />
            <ConnectCard title="Connect files" body="Review results, research, and plans" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Conversation>
        <ConversationContent>
          {groups.map((group) =>
            group.type === "tool_group" ? (
              <div key={group.messages[0]?.id ?? "tools"} className="flex flex-col gap-1.5">
                {group.messages.map((m) => (
                  <Tool key={m.id} name={m.content} detail={m.toolInput ? JSON.stringify(m.toolInput, null, 2) : undefined} />
                ))}
              </div>
            ) : group.message.role === "user" ? (
              <Message key={group.message.id} from="user">
                <MessageContent from="user">{group.message.content}</MessageContent>
              </Message>
            ) : (
              <Message key={group.message.id} from="assistant">
                <MessageContent from="assistant">
                  <MessageResponse>{group.message.content}</MessageResponse>
                </MessageContent>
              </Message>
            ),
          )}
          {status === "thinking" ? (
            <Reasoning streaming>
              <span className="status-pulse">Working on it…</span>
            </Reasoning>
          ) : null}
        </ConversationContent>
        <ConversationEmptyState>{null}</ConversationEmptyState>
      </Conversation>
      <div className="mx-auto w-full max-w-[760px] px-5 pb-5">
        <PromptInput value={draft} onChange={setDraft} onSubmit={submit} onAbort={abort} busy={status !== "idle"} placeholder="Reply to Hermes…" footer={composerFooter} />
      </div>
    </div>
  );
}

// Unified chat: a Codex-style rail listing Hermes + every agent thread on the
// left, the selected conversation on the right. (The old standalone "Agents"
// tab folds in here.)
export default function ChatTab() {
  const threads = useThreads((s) => s.threads);
  const activeThreadId = useThreads((s) => s.activeThreadId);
  const setActiveThread = useThreads((s) => s.setActiveThread);
  const setComposerOpen = useUi((s) => s.setComposerOpen);

  // activeThreadId is the single source of truth: null → Hermes, otherwise the
  // selected agent run (the composer and sidebar Chat both drive it).
  const activeThread = activeThreadId ? threads.find((t) => t.id === activeThreadId) ?? null : null;
  const showHermes = !activeThread;

  const railButton = (key: string, active: boolean, onClick: () => void, dot: React.ReactNode, label: string, bold = false) => (
    <button
      key={key}
      type="button"
      className="flex items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors duration-100"
      style={{ background: active ? "var(--bg-selected)" : "transparent" }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}
      onClick={onClick}
    >
      <span className="flex w-4 shrink-0 items-center justify-center">{dot}</span>
      <span className="min-w-0 flex-1 truncate text-sm" style={{ color: "var(--text-primary)", fontWeight: bold ? 600 : 400 }}>{label}</span>
    </button>
  );

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-[260px] shrink-0 flex-col border-r" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}>
        <div className="flex items-center justify-between border-b px-3 py-2.5" style={{ borderColor: "var(--border-subtle)" }}>
          <span className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Chat</span>
          <button
            type="button"
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm hover:bg-[var(--bg-hover)]"
            style={{ color: "var(--text-secondary)" }}
            onClick={() => setComposerOpen(true)}
            title="New agent run (⌘J)"
          >
            <MessageSquarePlus size={13} />
            New
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-1.5">
          {railButton(
            "hermes",
            showHermes,
            () => setActiveThread(null),
            <Sparkles size={14} style={{ color: showHermes ? "var(--accent)" : "var(--text-tertiary)" }} />,
            "Hermes",
          )}
          {threads.length > 0 ? (
            <span className="px-2.5 pt-2 pb-0.5 text-xs font-semibold tracking-wide uppercase" style={{ color: "var(--text-tertiary)" }}>
              Agent runs
            </span>
          ) : null}
          {threads.map((thread) =>
            railButton(
              thread.id,
              thread.id === activeThreadId,
              () => setActiveThread(thread.id),
              <StatusDot color={STATUS_COLOR[thread.status]} pulse={thread.status === "running"} />,
              thread.title,
              thread.unread,
            ),
          )}
        </div>
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {showHermes ? <HermesPane /> : <ThreadView threadId={activeThread.id} embedded />}
      </div>
    </div>
  );
}
