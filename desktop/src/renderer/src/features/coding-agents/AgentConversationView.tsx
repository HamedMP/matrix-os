import {
  SafeAssistantPreviewSourceTextSchema,
  SafeAssistantPreviewTextSchema,
  type AgentThreadEvent,
  type AgentThreadSnapshot,
} from "@matrix-os/contracts";
import { Bot, GitPullRequest, Send, UserRound, Wrench } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../design/primitives";
import {
  codingAgentApprovalActionKey,
  codingAgentInputActionKey,
  useCodingAgentWorkspace,
} from "../../stores/coding-agent-workspace";

type ConversationStatus = "idle" | "loading" | "ready" | "error";
type AssistantEvent = Extract<AgentThreadEvent, { type: "assistant.text.delta" | "assistant.text.completed" }>;
type ToolEvent = Extract<AgentThreadEvent, { type: "tool.started" | "tool.output" | "tool.completed" }>;
type ConversationItem =
  | { kind: "assistant"; key: string; events: AssistantEvent[]; order: number }
  | { kind: "tool"; key: string; events: ToolEvent[]; order: number }
  | { kind: "event"; event: AgentThreadEvent; order: number };

const PREVIEW_MAX_CHARS = 240;

function conversationItems(events: AgentThreadEvent[]): ConversationItem[] {
  const assistants = new Map<string, AssistantEvent[]>();
  const tools = new Map<string, ToolEvent[]>();
  const items: ConversationItem[] = [];
  for (const [order, event] of events.entries()) {
    if (event.type === "assistant.text.delta" || event.type === "assistant.text.completed") {
      const group = assistants.get(event.messageId);
      if (group) group.push(event);
      else {
        const next = [event];
        assistants.set(event.messageId, next);
        items.push({ kind: "assistant", key: `assistant:${event.messageId}`, events: next, order });
      }
      continue;
    }
    if (event.type === "tool.started" || event.type === "tool.output" || event.type === "tool.completed") {
      const group = tools.get(event.toolCallId);
      if (group) group.push(event);
      else {
        const next = [event];
        tools.set(event.toolCallId, next);
        items.push({ kind: "tool", key: `tool:${event.toolCallId}`, events: next, order });
      }
      continue;
    }
    items.push({ kind: "event", event, order });
  }
  return items.sort((left, right) => left.order - right.order);
}

function assistantCopy(events: AssistantEvent[]) {
  const deltas = events.filter(
    (event): event is Extract<AssistantEvent, { type: "assistant.text.delta" }> => event.type === "assistant.text.delta",
  );
  const completed = events.some((event) => event.type === "assistant.text.completed");
  const source = deltas.map((event) => event.delta).join("").trim();
  const safeSource = source && SafeAssistantPreviewSourceTextSchema.safeParse(source).success ? source : null;
  const previewCandidate = safeSource && safeSource.length > PREVIEW_MAX_CHARS
    ? `${safeSource.slice(0, PREVIEW_MAX_CHARS).trimEnd()}...`
    : safeSource;
  const preview = previewCandidate && SafeAssistantPreviewTextSchema.safeParse(previewCandidate).success
    ? previewCandidate
    : null;
  const updates = `${deltas.length} ${deltas.length === 1 ? "text update" : "text updates"} received`;
  const status = completed ? `${updates}, complete` : updates;
  return {
    title: completed ? "Assistant message" : deltas.length === 1 ? "Assistant update" : "Assistant updates",
    status,
    preview,
    displayText: safeSource && safeSource.length <= PREVIEW_MAX_CHARS ? safeSource : preview,
  };
}

function AssistantBubble({ events }: { events: AssistantEvent[] }) {
  const copy = assistantCopy(events);
  return (
    <div className="flex max-w-[min(760px,92%)] items-start gap-2">
      <span className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full" style={{ background: "var(--accent-muted)", color: "var(--accent)" }}>
        <Bot size={15} aria-hidden="true" />
      </span>
      <article className="min-w-0 rounded-2xl rounded-tl-md border px-4 py-3" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h3 className="text-xs font-semibold" style={{ color: "var(--text-primary)" }}>{copy.title}</h3>
          <span className="text-[10px]" style={{ color: "var(--text-tertiary)" }}>{events[0]?.occurredAt}</span>
        </div>
        {copy.displayText ? <p className="sr-only">{copy.preview ? `${copy.status}. ${copy.preview}` : copy.status}</p> : null}
        {copy.displayText ? (
          <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6" style={{ color: "var(--text-primary)" }}>
            {copy.displayText}
          </p>
        ) : (
          <p className="mt-1 text-xs" style={{ color: "var(--text-secondary)" }}>{copy.status}</p>
        )}
      </article>
    </div>
  );
}

function UserBubble({ event }: { event: Extract<AgentThreadEvent, { type: "user.message" }> }) {
  return (
    <div className="ml-auto flex max-w-[min(720px,88%)] flex-row-reverse items-start gap-2">
      <span className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full" style={{ background: "var(--bg-tertiary)", color: "var(--text-secondary)" }}>
        <UserRound size={14} aria-hidden="true" />
      </span>
      <article className="min-w-0 rounded-2xl rounded-tr-md px-4 py-3" style={{ background: "var(--accent-muted)" }}>
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
          <span className="text-[10px]" style={{ color: "var(--text-tertiary)" }}>{event.occurredAt}</span>
          <h3 className="text-xs font-semibold" style={{ color: "var(--text-primary)" }}>You</h3>
        </div>
        <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6" style={{ color: "var(--text-primary)" }}>{event.text}</p>
      </article>
    </div>
  );
}

function ToolActivity({ events }: { events: ToolEvent[] }) {
  const [expanded, setExpanded] = useState(false);
  const started = events.find((event): event is Extract<ToolEvent, { type: "tool.started" }> => event.type === "tool.started");
  const outputs = events.filter((event): event is Extract<ToolEvent, { type: "tool.output" }> => event.type === "tool.output");
  const completed = events.find((event): event is Extract<ToolEvent, { type: "tool.completed" }> => event.type === "tool.completed");
  const name = started?.displayName ?? "Tool";
  const outcome = completed?.outcome === "success" ? "successfully"
    : completed?.outcome === "failed" ? "with errors"
      : completed?.outcome === "cancelled" ? "cancelled"
        : "";
  const detail = completed
    ? `${name} completed ${outcome}${outputs.length ? outputs.some((event) => event.truncated) ? " after receiving partial output" : " after receiving output" : " without captured output"}`
    : `${name} running${outputs.length ? " with output received" : ""}`;
  return (
    <div className="mx-auto w-full max-w-[760px] rounded-lg border px-3 py-2" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-overlay)" }}>
      <div className="flex items-start gap-2">
        <Wrench size={14} className="mt-0.5 shrink-0" style={{ color: "var(--text-tertiary)" }} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-xs font-semibold" style={{ color: "var(--text-primary)" }}>Tool activity</h3>
            <span className="text-[10px]" style={{ color: "var(--text-tertiary)" }}>{events[0]?.occurredAt}</span>
          </div>
          <p className="mt-0.5 text-xs" style={{ color: "var(--text-secondary)" }}>{detail}</p>
          <p className="mt-1 text-[11px] font-medium" style={{ color: "var(--text-tertiary)" }}>
            {outputs.length} {outputs.length === 1 ? "output" : "outputs"}
          </p>
          <button type="button" className="mt-1 text-[11px] font-medium" style={{ color: "var(--accent)" }} aria-label={`${expanded ? "Collapse" : "Expand"} tool activity Tool activity`} onClick={() => setExpanded((value) => !value)}>
            {expanded ? "Hide details" : "Show details"}
          </button>
          {expanded ? (
            <div className="mt-2 grid gap-1 text-xs" style={{ color: "var(--text-secondary)" }}>
              {started ? <div><p>Started {started.kind}</p><p>Tool run started</p></div> : null}
              {outputs.map((output, index) => <div key={output.eventId}><p>Output {index + 1}</p><p>{output.truncated ? "Output received, partial" : "Output received"}</p></div>)}
              {completed ? <div><p>Completed</p><p>{completed.outcome === "success" ? "Completed successfully" : completed.outcome === "failed" ? "Failed" : "Cancelled"}</p></div> : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function eventCopy(event: AgentThreadEvent): { title: string; detail: string } {
  switch (event.type) {
    case "turn.accepted": return { title: "Message accepted", detail: "Waiting for the agent run" };
    case "turn.status": return { title: "Message status", detail: event.status };
    case "thread.created": return { title: "Thread created", detail: event.thread.title };
    case "thread.status": return { title: "Status changed", detail: event.status.replaceAll("_", " ") };
    case "approval.requested": return { title: "Approval needed", detail: event.approval.safeDescription };
    case "approval.resolved": return { title: "Approval resolved", detail: event.decision };
    case "user_input.requested": return { title: "Input needed", detail: event.request.safeDescription };
    case "user_input.answered": return { title: "Input answered", detail: "Input answer received" };
    case "file.changed": return { title: `File ${event.changeKind}`, detail: `${event.changeKind} file` };
    case "review.ready": return { title: "Review ready", detail: `${event.summary.changedFileCount} ${event.summary.changedFileCount === 1 ? "file" : "files"} changed, +${event.summary.additions} -${event.summary.deletions}${event.summary.partial ? ", partial" : ""}` };
    case "terminal.bound": return { title: "Terminal bound", detail: event.terminalSessionId };
    case "thread.error": return { title: "Thread needs attention", detail: event.error.retryable ? "Refresh the thread or check the runtime." : "Open the workspace again." };
    case "thread.completed": return { title: "Thread completed", detail: event.outcome };
    case "user.message": return { title: "You", detail: event.text };
    case "assistant.text.delta":
    case "assistant.text.completed": return { title: "Assistant update", detail: "Text update received" };
    case "tool.started":
    case "tool.output":
    case "tool.completed": return { title: "Tool activity", detail: "Tool state updated" };
  }
}

function approvalLabel(decision: string) {
  if (decision === "approve") return "Approve";
  if (decision === "approve_for_session") return "Approve for session";
  if (decision === "decline") return "Decline";
  if (decision === "cancel") return "Cancel";
  return "Decide";
}

function SystemEvent({ event, answeredInputs, resolvedApprovals }: {
  event: AgentThreadEvent;
  answeredInputs: ReadonlySet<string>;
  resolvedApprovals: ReadonlySet<string>;
}) {
  const copy = eventCopy(event);
  const pendingApprovalKeys = useCodingAgentWorkspace((state) => state.pendingApprovalKeys);
  const approvalErrors = useCodingAgentWorkspace((state) => state.approvalActionErrors);
  const submitApproval = useCodingAgentWorkspace((state) => state.submitApprovalDecision);
  const pendingInputKeys = useCodingAgentWorkspace((state) => state.pendingInputRequestKeys);
  const inputErrors = useCodingAgentWorkspace((state) => state.inputActionErrors);
  const submitInput = useCodingAgentWorkspace((state) => state.submitInputAnswer);
  const selectReview = useCodingAgentWorkspace((state) => state.selectReview);
  const [answer, setAnswer] = useState("");
  const approval = event.type === "approval.requested" ? event.approval : null;
  const input = event.type === "user_input.requested" ? event.request : null;
  const approvalKey = approval ? codingAgentApprovalActionKey(approval.threadId, approval.approvalId) : null;
  const inputKey = input ? codingAgentInputActionKey(input.threadId, input.requestId) : null;
  return (
    <div className="mx-auto w-full max-w-[760px] rounded-lg border px-3 py-2" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-overlay)" }}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold" style={{ color: "var(--text-primary)" }}>{copy.title}</h3>
        <span className="text-[10px]" style={{ color: "var(--text-tertiary)" }}>{event.occurredAt}</span>
      </div>
      <p className="mt-0.5 text-xs" style={{ color: "var(--text-secondary)" }}>{copy.detail}</p>
      {approval && approvalKey && !resolvedApprovals.has(approvalKey) ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {approval.allowedDecisions.map((decision) => (
            <Button key={decision} variant={decision.startsWith("approve") ? "primary" : "danger"} aria-label={`${approvalLabel(decision)} ${approval.title}`} disabled={Boolean(approvalKey && pendingApprovalKeys.includes(approvalKey))} onClick={() => void submitApproval({ threadId: approval.threadId, approvalId: approval.approvalId, decision, correlationId: approval.correlationId })}>
              {approvalKey && pendingApprovalKeys.includes(approvalKey) ? "Sending..." : approvalLabel(decision)}
            </Button>
          ))}
          {approvalKey && approvalErrors[approvalKey] ? <span className="text-xs" style={{ color: "var(--danger)" }}>{approvalErrors[approvalKey]}</span> : null}
        </div>
      ) : null}
      {input && inputKey && !answeredInputs.has(inputKey) ? (
        <div className="mt-2 grid gap-2">
          <textarea aria-label={`Answer ${input.title}`} className="min-h-20 resize-y rounded-md border px-3 py-2 text-sm outline-none" maxLength={8000} placeholder={input.placeholder ?? "Answer"} style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)", color: "var(--text-primary)" }} value={answer} onChange={(event) => setAnswer(event.currentTarget.value)} />
          <div className="flex items-center gap-2">
            <Button variant="primary" aria-label={`Send ${input.title}`} disabled={pendingInputKeys.includes(inputKey) || (input.required && !answer.trim())} onClick={() => void submitInput({ threadId: input.threadId, inputRequestId: input.requestId, answer, correlationId: input.correlationId })}>
              {pendingInputKeys.includes(inputKey) ? "Sending..." : "Send"}
            </Button>
            {inputErrors[inputKey] ? <span className="text-xs" style={{ color: "var(--danger)" }}>{inputErrors[inputKey]}</span> : null}
          </div>
        </div>
      ) : null}
      {event.type === "review.ready" ? (
        <div className="mt-2">
          <Button variant="subtle" aria-label="Open review from thread" onClick={() => void selectReview(event.reviewId)}>
            <GitPullRequest size={14} /> Open review
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function ConversationComposer({ threadId }: { threadId: string }) {
  const [message, setMessage] = useState("");
  const turnStatus = useCodingAgentWorkspace((state) => state.turnStatus);
  const turnThreadId = useCodingAgentWorkspace((state) => state.turnThreadId);
  const turnError = useCodingAgentWorkspace((state) => state.turnError);
  const send = useCodingAgentWorkspace((state) => state.sendThreadMessage);
  const submitting = turnStatus === "submitting" && turnThreadId === threadId;
  useEffect(() => setMessage(""), [threadId]);

  async function submit() {
    if (!message.trim() || submitting) return;
    const sent = await send({ threadId, message });
    if (sent) setMessage("");
  }

  return (
    <div className="shrink-0 border-t p-3" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}>
      <div className="mx-auto max-w-[820px] rounded-xl border p-2" style={{ borderColor: turnError && turnThreadId === threadId ? "var(--danger)" : "var(--border-default)", background: "var(--bg-overlay)" }}>
        <textarea aria-label="Message conversation" className="min-h-[72px] w-full resize-none bg-transparent px-2 py-1 text-sm leading-6 outline-none" maxLength={24_000} placeholder="Ask a follow-up…" style={{ color: "var(--text-primary)" }} value={message} onChange={(event) => setMessage(event.currentTarget.value)} onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void submit();
          }
        }} />
        <div className="flex items-center justify-between gap-3 px-1 pt-1">
          <p className="min-h-4 text-xs" style={{ color: "var(--danger)" }}>{turnThreadId === threadId ? turnError : null}</p>
          <Button variant="primary" aria-label="Send message" disabled={submitting || !message.trim()} onClick={() => void submit()}>
            <Send size={14} /> {submitting ? "Sending" : "Send"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function AgentConversationView({
  status,
  snapshot,
  error,
  canSendTurns,
}: {
  status: ConversationStatus;
  snapshot: AgentThreadSnapshot | null;
  error: string | null;
  canSendTurns: boolean;
}) {
  const endRef = useRef<HTMLDivElement | null>(null);
  const items = useMemo(() => conversationItems(snapshot?.events.items ?? []), [snapshot?.events.items]);
  const answeredInputs = useMemo(() => new Set((snapshot?.events.items ?? [])
    .filter((event) => event.type === "user_input.answered")
    .map((event) => codingAgentInputActionKey(event.threadId, event.requestId))), [snapshot?.events.items]);
  // Approvals already resolved in the snapshot must not re-render live
  // decision buttons; a second click would reach the provider as a duplicate
  // decision under a fresh client request id.
  const resolvedApprovals = useMemo(() => new Set((snapshot?.events.items ?? [])
    .filter((event) => event.type === "approval.resolved")
    .map((event) => codingAgentApprovalActionKey(event.threadId, event.approvalId))), [snapshot?.events.items]);
  useEffect(() => {
    const target = endRef.current as (HTMLDivElement & { scrollIntoView?: (options?: ScrollIntoViewOptions) => void }) | null;
    target?.scrollIntoView?.({ block: "end" });
  }, [items.length, snapshot?.thread.id]);

  if (status === "loading") return <div className="flex min-h-[360px] items-center justify-center text-sm" style={{ color: "var(--text-secondary)" }}>Loading conversation…</div>;
  if (status === "error") return <div className="flex min-h-[360px] items-center justify-center p-6 text-sm" style={{ color: "var(--danger)" }}>{error ?? "Thread state unavailable"}</div>;
  if (!snapshot) return <div className="flex min-h-[360px] items-center justify-center p-6 text-center text-sm" style={{ color: "var(--text-secondary)" }}>Choose a conversation from the project navigator, or start a new chat.</div>;

  return (
    <section aria-label={`Conversation ${snapshot.thread.title}`} className="ph-no-capture flex min-h-[460px] min-w-0 flex-1 flex-col overflow-hidden" style={{ background: "var(--bg-primary)" }}>
      <header className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}>
        <div className="min-w-0">
          <span className="sr-only">Thread details</span>
          <h2 className="truncate text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{snapshot.thread.title}</h2>
          <p className="flex min-w-0 items-center gap-1 truncate text-xs capitalize" style={{ color: "var(--text-tertiary)" }}>
            <span>{snapshot.thread.providerId}</span><span aria-hidden="true">·</span><span>{snapshot.thread.status.replaceAll("_", " ")}</span>
          </p>
        </div>
        {snapshot.thread.attention !== "none" ? <span className="rounded-full px-2 py-1 text-[10px] font-semibold capitalize" style={{ background: "var(--warning-muted)", color: "var(--warning)" }}>{snapshot.thread.attention.replaceAll("_", " ")}</span> : null}
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-5">
        {items.map((item) => item.kind === "assistant" ? <AssistantBubble key={item.key} events={item.events} />
          : item.kind === "tool" ? <ToolActivity key={item.key} events={item.events} />
            : item.event.type === "user.message" ? <UserBubble key={item.event.eventId} event={item.event} />
              : <SystemEvent key={item.event.eventId} event={item.event} answeredInputs={answeredInputs} resolvedApprovals={resolvedApprovals} />)}
        {items.length === 0 ? (
          <p className="py-12 text-center text-sm" style={{ color: "var(--text-tertiary)" }}>
            {canSendTurns ? "This conversation is ready. Send a message to continue." : "No messages yet."}
          </p>
        ) : null}
        <div ref={endRef} />
      </div>
      {canSendTurns ? (
        <ConversationComposer threadId={snapshot.thread.id} />
      ) : (
        <p
          className="shrink-0 border-t px-4 py-3 text-center text-xs"
          style={{ borderColor: "var(--border-subtle)", color: "var(--text-tertiary)", background: "var(--bg-surface)" }}
        >
          Follow-ups are unavailable on this computer.
        </p>
      )}
    </section>
  );
}
