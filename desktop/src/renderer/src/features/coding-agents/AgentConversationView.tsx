import type { AgentThreadEvent, AgentThreadSnapshot } from "@matrix-os/contracts";
import {
  Check,
  Copy,
  Eye,
  GitPullRequest,
  Minus,
  SquarePen,
  SquareTerminal,
  Wrench,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { useMemo, useState } from "react";
import { Button } from "../../design/primitives";
import { redactCredentialsForDisplay } from "../../lib/transcript-redaction";
import {
  codingAgentApprovalActionKey,
  codingAgentInputActionKey,
  useCodingAgentWorkspace,
} from "../../stores/coding-agent-workspace";
import { safeUrlTransform } from "../editor/MarkdownPreview";
import { Conversation, ConversationContent } from "../chat/elements/conversation";
import { PromptInput } from "../chat/elements/prompt-input";

type ConversationStatus = "idle" | "loading" | "ready" | "error";
type AssistantEvent = Extract<AgentThreadEvent, { type: "assistant.text.delta" | "assistant.text.completed" }>;
type ToolEvent = Extract<AgentThreadEvent, { type: "tool.started" | "tool.output" | "tool.completed" }>;
type ConversationItem =
  | { kind: "assistant"; key: string; events: AssistantEvent[]; order: number }
  | { kind: "tool"; key: string; events: ToolEvent[]; order: number }
  | { kind: "event"; event: AgentThreadEvent; order: number };
type TimelineItem =
  | Exclude<ConversationItem, { kind: "tool" }>
  | { kind: "tool-run"; key: string; runs: Array<Extract<ConversationItem, { kind: "tool" }>>; order: number };

// Defensive ceiling for one rendered message; each delta is already bounded by
// the event schema (4,000 chars / 16KB), so this only guards runaway joins.
const ASSISTANT_RENDER_MAX_CHARS = 64_000;
const COLLAPSED_USER_MAX_CHARS = 600;
const COLLAPSED_USER_MAX_LINES = 8;
// Consecutive tool chips beyond this collapse behind a "+N earlier" toggle.
const TOOL_RUN_COLLAPSE_THRESHOLD = 5;
const TOOL_RUN_VISIBLE_TAIL = 3;

const TRANSCRIPT_MARKDOWN_CLASS =
  "prose-sm max-w-none text-sm leading-relaxed [&_a]:text-[var(--highlight)] [&_blockquote]:border-l-2 [&_blockquote]:border-[var(--border-default)] [&_blockquote]:pl-3 [&_blockquote]:text-[var(--text-secondary)] [&_code]:rounded [&_code]:bg-[var(--bg-sunken)] [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[12px] [&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mt-3 [&_h2]:mb-1.5 [&_h2]:text-md [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:font-semibold [&_hr]:my-4 [&_hr]:border-[var(--border-subtle)] [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-[var(--border-subtle)] [&_pre]:bg-[var(--bg-sunken)] [&_pre]:p-3 [&_pre_code]:bg-transparent [&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-[var(--border-subtle)] [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-[var(--border-subtle)] [&_th]:bg-[var(--bg-sunken)] [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_ul]:list-disc [&_ul]:pl-5";

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

/** Batches consecutive tool items into one run so long runs can collapse. */
function timelineItems(items: ConversationItem[]): TimelineItem[] {
  const timeline: TimelineItem[] = [];
  for (const item of items) {
    if (item.kind !== "tool") {
      timeline.push(item);
      continue;
    }
    const previous = timeline.at(-1);
    if (previous?.kind === "tool-run") {
      previous.runs.push(item);
      continue;
    }
    timeline.push({ kind: "tool-run", key: `run:${item.key}`, runs: [item], order: item.order });
  }
  return timeline;
}

function assistantText(events: AssistantEvent[]): { text: string; completed: boolean } {
  const deltas = events.filter(
    (event): event is Extract<AssistantEvent, { type: "assistant.text.delta" }> => event.type === "assistant.text.delta",
  );
  const completed = events.some((event) => event.type === "assistant.text.completed");
  let text = deltas.map((event) => event.delta).join("");
  if (text.length > ASSISTANT_RENDER_MAX_CHARS) {
    text = `_Earlier content truncated._\n\n${text.slice(text.length - ASSISTANT_RENDER_MAX_CHARS)}`;
  }
  return { text: redactCredentialsForDisplay(text), completed };
}

function occurredAtLabel(occurredAt: string): string {
  const parsed = new Date(occurredAt);
  return Number.isNaN(parsed.getTime())
    ? ""
    : parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function copyText(text: string): void {
  const clipboard = navigator.clipboard;
  if (!clipboard?.writeText) return;
  clipboard.writeText(text).catch((err: unknown) => {
    console.warn("[coding-agents] copy failed:", err instanceof Error ? err.message : String(err));
  });
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      className="flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--bg-hover)]"
      style={{ color: "var(--text-tertiary)" }}
      onClick={() => {
        copyText(text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

// Assistant messages render full-width markdown — no bubble — with a
// hover-revealed meta row, matching the reference chat anatomy.
function AssistantRow({ events }: { events: AssistantEvent[] }) {
  const { text, completed } = useMemo(() => assistantText(events), [events]);
  if (!text) {
    return completed ? (
      <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>(empty response)</p>
    ) : null;
  }
  return (
    <div className="group/assistant flex min-w-0 flex-col">
      <div className={TRANSCRIPT_MARKDOWN_CLASS} style={{ color: "var(--text-primary)" }} data-selectable>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]}
          urlTransform={safeUrlTransform}
        >
          {text}
        </ReactMarkdown>
      </div>
      <div className="mt-1 flex items-center gap-2 opacity-0 transition-opacity group-hover/assistant:opacity-100">
        <CopyButton text={text} label="Copy assistant message" />
        <span className="text-[10px] tabular-nums" style={{ color: "var(--text-tertiary)" }}>
          {occurredAtLabel(events[0]?.occurredAt ?? "")}
        </span>
      </div>
    </div>
  );
}

function UserRow({ event }: { event: Extract<AgentThreadEvent, { type: "user.message" }> }) {
  const [expanded, setExpanded] = useState(false);
  const lines = event.text.split("\n").length;
  const collapsible = event.text.length > COLLAPSED_USER_MAX_CHARS || lines > COLLAPSED_USER_MAX_LINES;
  return (
    <div className="group/user flex flex-col items-end gap-1">
      <div
        className="relative max-w-[80%] overflow-hidden rounded-2xl rounded-br-md border px-3.5 py-2 text-sm whitespace-pre-wrap"
        style={{
          borderColor: "var(--border-subtle)",
          background: "var(--bg-sunken)",
          color: "var(--text-primary)",
          ...(collapsible && !expanded
            ? { maxHeight: 176, maskImage: "linear-gradient(to bottom, black 60%, transparent 100%)" }
            : {}),
        }}
        data-selectable
      >
        {event.text}
      </div>
      <div className="flex max-w-[80%] items-center gap-2">
        {collapsible ? (
          <button
            type="button"
            className="text-[11px]"
            style={{ color: "var(--text-tertiary)" }}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Show less" : "Show full message"}
          </button>
        ) : null}
        <span className="flex items-center gap-1 opacity-0 transition-opacity group-hover/user:opacity-100">
          <CopyButton text={event.text} label="Copy your message" />
          <span className="text-[10px] tabular-nums" style={{ color: "var(--text-tertiary)" }}>
            {occurredAtLabel(event.occurredAt)}
          </span>
        </span>
      </div>
    </div>
  );
}

function toolKindIcon(displayName: string) {
  if (/shell|command|terminal|bash|exec|run/i.test(displayName)) return SquareTerminal;
  if (/write|edit|apply|patch|create/i.test(displayName)) return SquarePen;
  if (/read|view|open|list|search|glob|grep/i.test(displayName)) return Eye;
  return Wrench;
}

// A tool call renders as a one-line chip: kind icon, heading, muted preview,
// and a trailing status glyph. Expansion reveals the same bounded detail copy
// the old cards showed — no raw payloads.
function ToolChip({ events }: { events: ToolEvent[] }) {
  const [open, setOpen] = useState(false);
  const started = events.find((event): event is Extract<ToolEvent, { type: "tool.started" }> => event.type === "tool.started");
  const outputs = events.filter((event): event is Extract<ToolEvent, { type: "tool.output" }> => event.type === "tool.output");
  const completed = events.find((event): event is Extract<ToolEvent, { type: "tool.completed" }> => event.type === "tool.completed");
  const name = started?.displayName ?? "Tool";
  const failed = completed?.outcome === "failed";
  const detail = completed
    ? `${name} completed ${completed.outcome === "success" ? "successfully" : completed.outcome === "failed" ? "with errors" : "cancelled"}${outputs.length ? (outputs.some((event) => event.truncated) ? " after receiving partial output" : " after receiving output") : " without captured output"}`
    : `${name} running${outputs.length ? " with output received" : ""}`;
  const KindIcon = toolKindIcon(name);
  const StatusIcon = completed ? (failed ? X : Check) : Minus;
  return (
    <div className="flex min-w-0 flex-col">
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-[var(--bg-hover)]"
        aria-label={`Tool call ${name}`}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <KindIcon size={14} className="shrink-0" style={{ color: "var(--text-tertiary)" }} />
        <span
          className="min-w-0 shrink truncate text-[12px] font-medium"
          style={{ color: failed ? "var(--danger)" : "var(--text-primary)" }}
        >
          {name}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px]" style={{ color: "var(--text-tertiary)" }}>
          {detail}
        </span>
        <StatusIcon
          size={13}
          className="shrink-0"
          style={{ color: failed ? "var(--danger)" : completed ? "var(--success)" : "var(--text-tertiary)" }}
          aria-label={completed ? (failed ? "Failed" : "Completed") : "Running"}
        />
      </button>
      {open ? (
        <div className="mt-1 ml-7 border-l pl-3" style={{ borderColor: "var(--border-subtle)" }}>
          <pre className="max-h-64 overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap" style={{ color: "var(--text-secondary)" }} data-selectable>
            {detail}
            {outputs.some((event) => event.truncated) ? "\nOutput was truncated for display." : ""}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

function ToolRun({ runs }: { runs: Array<Extract<ConversationItem, { kind: "tool" }>> }) {
  const [showAll, setShowAll] = useState(false);
  const collapsed = !showAll && runs.length > TOOL_RUN_COLLAPSE_THRESHOLD;
  const visible = collapsed ? runs.slice(runs.length - TOOL_RUN_VISIBLE_TAIL) : runs;
  const hiddenCount = runs.length - visible.length;
  return (
    <section aria-label={`${runs.length} tool ${runs.length === 1 ? "call" : "calls"}`} className="flex flex-col gap-0.5">
      {collapsed ? (
        <button
          type="button"
          className="self-start rounded-md px-1 py-0.5 text-[11px] hover:bg-[var(--bg-hover)]"
          style={{ color: "var(--text-tertiary)" }}
          onClick={() => setShowAll(true)}
        >
          +{hiddenCount} earlier tool {hiddenCount === 1 ? "call" : "calls"}
        </button>
      ) : null}
      {!collapsed && runs.length > TOOL_RUN_COLLAPSE_THRESHOLD ? (
        <button
          type="button"
          className="self-start rounded-md px-1 py-0.5 text-[11px] hover:bg-[var(--bg-hover)]"
          style={{ color: "var(--text-tertiary)" }}
          onClick={() => setShowAll(false)}
        >
          Show fewer tool calls
        </button>
      ) : null}
      {visible.map((run) => (
        <ToolChip key={run.key} events={run.events} />
      ))}
    </section>
  );
}

function WorkingRow() {
  return (
    <div className="flex items-center gap-2" role="status" aria-label="Agent is working">
      <span className="flex items-center gap-1">
        <span className="h-1 w-1 animate-pulse rounded-full" style={{ background: "var(--text-tertiary)" }} />
        <span className="h-1 w-1 animate-pulse rounded-full [animation-delay:200ms]" style={{ background: "var(--text-tertiary)" }} />
        <span className="h-1 w-1 animate-pulse rounded-full [animation-delay:400ms]" style={{ background: "var(--text-tertiary)" }} />
      </span>
      <span className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>Working…</span>
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
    <div className="w-full rounded-lg border px-3 py-2" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-overlay)" }}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold" style={{ color: "var(--text-primary)" }}>{copy.title}</h3>
        <span className="text-[10px] tabular-nums" style={{ color: "var(--text-tertiary)" }}>{occurredAtLabel(event.occurredAt)}</span>
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

function ConversationComposer({ threadId, waitingForAction }: { threadId: string; waitingForAction: boolean }) {
  const [message, setMessage] = useState("");
  const turnStatus = useCodingAgentWorkspace((state) => state.turnStatus);
  const turnThreadId = useCodingAgentWorkspace((state) => state.turnThreadId);
  const turnError = useCodingAgentWorkspace((state) => state.turnError);
  const send = useCodingAgentWorkspace((state) => state.sendThreadMessage);
  const submitting = turnStatus === "submitting" && turnThreadId === threadId;

  async function submit() {
    if (!message.trim() || submitting || waitingForAction) return;
    const sent = await send({ threadId, message });
    if (sent) setMessage("");
  }

  return (
    <div className="shrink-0 px-4 pb-4">
      <div className="mx-auto w-full max-w-[760px]">
        {turnThreadId === threadId && turnError ? (
          <p className="mb-1 px-1 text-xs" style={{ color: "var(--danger)" }}>{turnError}</p>
        ) : null}
        <PromptInput
          key={threadId}
          value={message}
          onChange={setMessage}
          onSubmit={() => void submit()}
          busy={submitting}
          disabled={waitingForAction || submitting}
          ariaLabel="Message conversation"
          placeholder={waitingForAction ? "Respond to the pending request above to continue" : "Ask a follow-up…"}
        />
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
  const items = useMemo(() => timelineItems(conversationItems(snapshot?.events.items ?? [])), [snapshot?.events.items]);
  const answeredInputs = useMemo(() => new Set((snapshot?.events.items ?? [])
    .filter((event) => event.type === "user_input.answered")
    .map((event) => codingAgentInputActionKey(event.threadId, event.requestId))), [snapshot?.events.items]);
  // Approvals already resolved in the snapshot must not re-render live
  // decision buttons; a second click would reach the provider as a duplicate
  // decision under a fresh client request id.
  const resolvedApprovals = useMemo(() => new Set((snapshot?.events.items ?? [])
    .filter((event) => event.type === "approval.resolved")
    .map((event) => codingAgentApprovalActionKey(event.threadId, event.approvalId))), [snapshot?.events.items]);

  if (status === "loading") return <div className="flex min-h-[360px] items-center justify-center text-sm" style={{ color: "var(--text-secondary)" }}>Loading conversation…</div>;
  if (status === "error") return <div className="flex min-h-[360px] items-center justify-center p-6 text-sm" style={{ color: "var(--danger)" }}>{error ?? "Thread state unavailable"}</div>;
  if (!snapshot) return <div className="flex min-h-[360px] items-center justify-center p-6 text-center text-sm" style={{ color: "var(--text-secondary)" }}>Choose a conversation from the project navigator, or start a new chat.</div>;

  const running = snapshot.thread.status === "running" || snapshot.thread.status === "starting" || snapshot.thread.status === "queued";
  const lastItem = items.at(-1);
  const streamingAssistant = lastItem?.kind === "assistant"
    && !lastItem.events.some((event) => event.type === "assistant.text.completed");
  const showWorking = running && !streamingAssistant;

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
      <Conversation>
        <ConversationContent>
          {items.map((item) =>
            item.kind === "assistant" ? <AssistantRow key={item.key} events={item.events} />
              : item.kind === "tool-run" ? <ToolRun key={item.key} runs={item.runs} />
                : item.event.type === "user.message" ? <UserRow key={item.event.eventId} event={item.event} />
                  : <SystemEvent key={item.event.eventId} event={item.event} answeredInputs={answeredInputs} resolvedApprovals={resolvedApprovals} />)}
          {showWorking ? <WorkingRow /> : null}
          {items.length === 0 && !showWorking ? (
            <p className="py-12 text-center text-sm" style={{ color: "var(--text-tertiary)" }}>
              Send a message to start the conversation.
            </p>
          ) : null}
        </ConversationContent>
      </Conversation>
      {canSendTurns ? (
        // The gateway rejects turns while the thread waits for an approval or
        // input answer, so the composer is disabled rather than offering a
        // doomed send.
        <ConversationComposer
          threadId={snapshot.thread.id}
          waitingForAction={snapshot.thread.status === "waiting_for_approval" || snapshot.thread.status === "waiting_for_input"}
        />
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
