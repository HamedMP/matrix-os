import { CircleStop, Wrench } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import ReactMarkdown from "react-markdown";
import { Button, StatusDot } from "../../design/primitives";
import { groupMessages, type ChatMessage } from "../../lib/chat";
import { abortKernelRequest } from "../../lib/kernel-wiring";
import { useThreads } from "../../stores/threads";
import { UNIFIED_THREAD_STATUS_META } from "../../stores/unified-threads";

function ToolRow({ message }: { message: ChatMessage }) {
  return (
    <div
      className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm"
      style={{
        borderColor: "var(--border-subtle)",
        background: "var(--bg-raised)",
        color: "var(--text-secondary)",
      }}
    >
      <Wrench size={12} style={{ color: "var(--text-tertiary)" }} />
      <span className="truncate font-mono text-xs">{message.content}</span>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div
          className="max-w-[78%] rounded-xl rounded-br-sm px-3.5 py-2 text-sm whitespace-pre-wrap"
          style={{ background: "var(--accent-muted)", color: "var(--text-primary)" }}
          data-selectable
        >
          {message.content}
        </div>
      </div>
    );
  }
  return (
    <div
      className="prose-invert max-w-none text-sm leading-relaxed [&_code]:font-mono [&_code]:text-[12px] [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:p-3"
      style={{ color: "var(--text-primary)" }}
      data-selectable
    >
      <ReactMarkdown>{message.content}</ReactMarkdown>
    </div>
  );
}

export default function ThreadView({ threadId, embedded = false }: { threadId: string; embedded?: boolean }) {
  const thread = useThreads((s) => s.threads.find((t) => t.id === threadId));
  const scrollRef = useRef<HTMLDivElement>(null);
  void embedded;

  const groups = useMemo(
    () => (thread ? groupMessages(thread.transcript) : []),
    [thread],
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread?.transcript.length, thread?.transcript[thread.transcript.length - 1]?.content]);

  if (!thread) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <span className="text-sm" style={{ color: "var(--text-tertiary)" }}>
          Thread not found.
        </span>
      </div>
    );
  }

  const status = UNIFIED_THREAD_STATUS_META[thread.status];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="flex shrink-0 items-center gap-2 border-b px-3 py-2"
        style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
      >
        <span className="min-w-0 flex-1 truncate text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          {thread.title}
        </span>
        <span className="flex items-center gap-1.5 text-xs" style={{ color: "var(--text-secondary)" }}>
          <StatusDot color={status.color} pulse={thread.status === "running"} />
          {status.label}
        </span>
        {thread.status === "running" ? (
          <Button variant="danger" onClick={() => abortKernelRequest(thread.requestId)}>
            <CircleStop size={13} />
            Stop
          </Button>
        ) : null}
      </div>

      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4">
        {groups.map((group) =>
          group.type === "tool_group" ? (
            <div key={group.messages[0]?.id ?? "tools"} className="flex flex-col gap-1">
              {group.messages.map((m) => (
                <ToolRow key={m.id} message={m} />
              ))}
            </div>
          ) : (
            <MessageBubble key={group.message.id} message={group.message} />
          ),
        )}
        {thread.status === "running" ? (
          <span className="status-pulse text-xs" style={{ color: "var(--text-tertiary)" }}>
            Working…
          </span>
        ) : null}
      </div>
    </div>
  );
}
