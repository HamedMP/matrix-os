import type { AgentAttachment, AgentThreadEvent, AgentThreadSnapshot, RuntimeSummary } from "@matrix-os/contracts";
import {
  Check,
  CircleAlert,
  CircleCheck,
  Copy,
  Eye,
  FileDiff,
  FileText,
  GitPullRequest,
  Hourglass,
  Image as ImageIcon,
  Info,
  Link2,
  MessageSquarePlus,
  Minus,
  ScrollText,
  SquarePen,
  SquareTerminal,
  Wrench,
  X,
} from "@renderer/lib/hugeicons";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../design/primitives";
import { CHAT_CONTENT_WIDTH_CLASS } from "../../components/conversation/layout";
import { cn } from "../../lib/cn";
import { redactCredentialsForDisplay } from "../../lib/transcript-redaction";
import {
  codingAgentApprovalActionKey,
  codingAgentInputActionKey,
  useCodingAgentWorkspace,
} from "../../stores/coding-agent-workspace";
import { useConnection } from "../../stores/connection";
import { safeUrlTransform } from "../editor/MarkdownPreview";
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "../chat/elements/attachment";
import { Bubble, BubbleContent } from "../chat/elements/bubble";
import { Conversation, ConversationContent, ConversationItem } from "../chat/elements/conversation";
import { Marker, MarkerContent, MarkerIcon } from "../chat/elements/marker";
import { Message, MessageContent, MessageFooter } from "../chat/elements/message";
import { AttachmentPreviewRow } from "../chat/attachments/AttachmentPreviewRow";
import { useConversationAttachments } from "../chat/attachments/use-conversation-attachments";
import { abortAgentThread, agentThreadAbortSupported } from "./abort-thread";
import {
  SharedChatComposer,
  type ComposerReferenceToken,
  type SharedChatComposerSubmission,
} from "../chat/SharedChatComposer";
import {
  createLegacyProjectProviderCatalog,
  filterCatalogForLegacyProject,
  instanceIdForLegacyProvider,
} from "../chat/canonical-composer-adapter";
import {
  createCanonicalComposerSelection,
  type CanonicalComposerSelection,
} from "../chat/canonical-composer-state";
import { useChatProviderCatalog } from "../chat/chat-provider-catalog";
import { searchProjectChatResources } from "../chat/chat-resource-search";
import { useProviderSetup } from "../chat/use-provider-setup";
import {
  deriveProviderReadiness,
  type ProviderReadinessPresentation,
} from "./provider-readiness";
import {
  projectConversationTimeline,
  type AssistantEvent,
  type ConversationTimelineItem,
  type TimelineItem,
  type ToolEvent,
} from "./conversation-timeline";
import { ToolCallDetailMeta } from "./tool-call-detail";
import { deriveTurnSummaries } from "./turn-summary";

type ConversationStatus = "idle" | "loading" | "ready" | "error";

// Defensive ceiling for one rendered message; each delta is already bounded by
// the event schema (4,000 chars / 16KB), so this only guards runaway joins.
const ASSISTANT_RENDER_MAX_CHARS = 64_000;
const COLLAPSED_USER_MAX_CHARS = 600;
const COLLAPSED_USER_MAX_LINES = 8;
// Consecutive tool chips beyond this collapse behind a "+N earlier" toggle.
const TOOL_RUN_COLLAPSE_THRESHOLD = 5;
const TOOL_RUN_VISIBLE_TAIL = 3;

const TRANSCRIPT_MARKDOWN_CLASS =
  "prose-sm max-w-none text-sm leading-relaxed [&_a]:text-[var(--highlight)] [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-[var(--border-default)] [&_blockquote]:pl-3 [&_blockquote]:text-[var(--text-secondary)] [&_code]:rounded [&_code]:bg-[var(--bg-sunken)] [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[12px] [&_h1]:mb-2 [&_h1]:mt-5 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mb-1.5 [&_h2]:mt-4 [&_h2]:text-md [&_h2]:font-semibold [&_h3]:mb-1 [&_h3]:mt-3 [&_h3]:font-semibold [&_hr]:my-5 [&_hr]:border-[var(--border-subtle)] [&_li]:my-1 [&_li]:marker:text-[var(--text-tertiary)] [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-[var(--border-subtle)] [&_pre]:bg-[var(--bg-sunken)] [&_pre]:p-3 [&_pre_code]:bg-transparent [&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_table]:text-[13px] [&_td]:border [&_td]:border-[var(--border-subtle)] [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-[var(--border-subtle)] [&_th]:bg-[var(--bg-sunken)] [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-semibold [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5";

function assistantText(events: AssistantEvent[]): { text: string; completed: boolean } {
  const completedIndex = events.findIndex((event) => event.type === "assistant.text.completed");
  const messageEvents = completedIndex >= 0 ? events.slice(0, completedIndex) : events;
  const deltas = messageEvents.filter(
    (event): event is Extract<AssistantEvent, { type: "assistant.text.delta" }> => event.type === "assistant.text.delta",
  );
  const completed = completedIndex >= 0;
  // Redact BEFORE the defensive tail slice: truncation can sever a credential
  // prefix (e.g. password=) while its value survives in the retained tail.
  let text = redactCredentialsForDisplay(deltas.map((event) => event.delta).join(""));
  if (text.length > ASSISTANT_RENDER_MAX_CHARS) {
    text = `_Earlier content truncated._\n\n${text.slice(text.length - ASSISTANT_RENDER_MAX_CHARS)}`;
  }
  return { text, completed };
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

// Assistant messages render full-width markdown in a ghost bubble — no framed
// surface — with a hover-revealed footer, matching the reference chat anatomy.
// The markdown pipeline (react-markdown + GFM + highlight + redaction) is
// unchanged; Message/Bubble own layout only.
function AssistantRow({ events, showMeta }: { events: AssistantEvent[]; showMeta: boolean }) {
  const { text, completed } = useMemo(() => assistantText(events), [events]);
  if (!text) {
    return completed ? (
      <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>(empty response)</p>
    ) : null;
  }
  return (
    <Message>
      <MessageContent className={showMeta ? "gap-1" : "gap-0"}>
        <Bubble variant="ghost">
          <BubbleContent className="overflow-visible">
            <div className={TRANSCRIPT_MARKDOWN_CLASS} style={{ color: "var(--text-primary)" }} data-selectable>
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]}
                urlTransform={safeUrlTransform}
                components={{
                  // Never auto-fetch remote images: a transcript image would fire a
                  // request to an arbitrary host the moment the thread opens
                  // (tracking pixel / exfiltration channel). Degrade to inert text.
                  img: ({ alt, src: imageSrc }) => (
                    <span
                      className="rounded border px-1.5 py-0.5 font-mono text-[11px]"
                      style={{ borderColor: "var(--border-subtle)", color: "var(--text-tertiary)" }}
                    >
                      image: {alt || "untitled"}{typeof imageSrc === "string" && imageSrc ? ` (${imageSrc})` : ""}
                    </span>
                  ),
                }}
              >
                {text}
              </ReactMarkdown>
            </div>
          </BubbleContent>
        </Bubble>
        {showMeta ? (
          <MessageFooter className="gap-2 opacity-0 transition-opacity group-hover/message:opacity-100">
            <CopyButton text={text} label="Copy assistant message" />
            <span className="text-[10px] tabular-nums" style={{ color: "var(--text-tertiary)" }}>
              {occurredAtLabel(events[0]?.occurredAt ?? "")}
            </span>
          </MessageFooter>
        ) : null}
      </MessageContent>
    </Message>
  );
}

const ATTACHMENT_KIND_LABEL: Record<AgentAttachment["kind"], string> = {
  file: "File",
  diff: "Diff",
  image: "Image",
  log_excerpt: "Log excerpt",
  structured_ref: "Reference",
};

function attachmentKindIcon(kind: AgentAttachment["kind"]) {
  if (kind === "image") return ImageIcon;
  if (kind === "diff") return FileDiff;
  if (kind === "log_excerpt") return ScrollText;
  if (kind === "structured_ref") return Link2;
  return FileText;
}

function attachmentSizeLabel(sizeBytes: number | undefined): string | null {
  if (sizeBytes === undefined) return null;
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${Math.round(sizeBytes / 1024)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Transcript attachments are metadata-only (label, kind, size) — no URL ever
// reaches the renderer, so cards always show the icon treatment and never an
// <img> fetch. Composer-side attachment types are out of scope here.
function UserAttachmentCard({ attachment }: { attachment: AgentAttachment }) {
  const KindIcon = attachmentKindIcon(attachment.kind);
  const size = attachmentSizeLabel(attachment.sizeBytes);
  return (
    <Attachment size="sm" state="done">
      <AttachmentMedia>
        <KindIcon />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{attachment.label}</AttachmentTitle>
        <AttachmentDescription>
          {ATTACHMENT_KIND_LABEL[attachment.kind]}{size ? ` · ${size}` : ""}
        </AttachmentDescription>
      </AttachmentContent>
    </Attachment>
  );
}

function UserRow({ event }: { event: Extract<AgentThreadEvent, { type: "user.message" }> }) {
  const [expanded, setExpanded] = useState(false);
  const lines = event.text.split("\n").length;
  const collapsible = event.text.length > COLLAPSED_USER_MAX_CHARS || lines > COLLAPSED_USER_MAX_LINES;
  return (
    <Message align="end">
      <MessageContent className="gap-0">
        <Bubble variant="secondary" align="end">
          <BubbleContent
            className="rounded-[var(--radius-xl)] rounded-br-md border-[var(--border-subtle)] px-3.5 whitespace-pre-wrap"
            style={
              collapsible && !expanded
                ? { maxHeight: 176, maskImage: "linear-gradient(to bottom, black 60%, transparent 100%)" }
                : undefined
            }
            data-selectable
          >
            {event.text}
          </BubbleContent>
        </Bubble>
        {event.attachments?.length ? (
          <AttachmentGroup role="group" aria-label="Message attachments" tabIndex={0}>
            {event.attachments.map((attachment) => (
              <UserAttachmentCard key={attachment.id} attachment={attachment} />
            ))}
          </AttachmentGroup>
        ) : null}
        <MessageFooter className="max-w-[80%] gap-2">
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
          <span className="flex items-center gap-1 opacity-0 transition-opacity group-hover/message:opacity-100">
            <CopyButton text={event.text} label="Copy your message" />
            <span className="text-[10px] tabular-nums" style={{ color: "var(--text-tertiary)" }}>
              {occurredAtLabel(event.occurredAt)}
            </span>
          </span>
        </MessageFooter>
      </MessageContent>
    </Message>
  );
}

function toolKindIcon(displayName: string) {
  if (/shell|command|terminal|bash|exec|run/i.test(displayName)) return SquareTerminal;
  if (/write|edit|apply|patch|create/i.test(displayName)) return SquarePen;
  if (/read|view|open|list|search|glob|grep/i.test(displayName)) return Eye;
  return Wrench;
}

// A tool call renders as a Marker-style one-line row: kind icon, heading
// (shimmering while the call runs), muted preview, and a trailing status
// glyph. Expansion reveals the same bounded detail copy the old cards showed
// — no raw payloads.
function ToolChip({ events }: { events: ToolEvent[] }) {
  const [open, setOpen] = useState(false);
  const started = events.find((event): event is Extract<ToolEvent, { type: "tool.started" }> => event.type === "tool.started");
  const outputs = events.filter((event): event is Extract<ToolEvent, { type: "tool.output" }> => event.type === "tool.output");
  const completed = events.find((event): event is Extract<ToolEvent, { type: "tool.completed" }> => event.type === "tool.completed");
  const name = started?.displayName ?? "Tool";
  const failed = completed?.outcome === "failed";
  const cancelled = completed?.outcome === "cancelled";
  const detail = completed
    ? `${name} completed ${completed.outcome === "success" ? "successfully" : completed.outcome === "failed" ? "with errors" : "cancelled"}${outputs.length ? (outputs.some((event) => event.truncated) ? " after receiving partial output" : " after receiving output") : " without captured output"}`
    : `${name} running${outputs.length ? " with output received" : ""}`;
  const KindIcon = toolKindIcon(name);
  const StatusIcon = completed ? (failed ? X : cancelled ? Minus : Check) : Minus;
  return (
    <div className="flex min-w-0 flex-col">
      <Marker asChild>
        <button
          type="button"
          className="rounded-md px-1 py-0.5 hover:bg-[var(--bg-hover)]"
          aria-label={`Tool call ${name}`}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <MarkerIcon>
            <KindIcon className="size-3.5" style={{ color: "var(--text-tertiary)" }} />
          </MarkerIcon>
          <MarkerContent
            className={cn("shrink truncate text-[12px] font-medium", completed ? undefined : "shimmer")}
            style={{ color: failed ? "var(--danger)" : "var(--text-primary)" }}
          >
            {name}
          </MarkerContent>
          <span className="min-w-0 flex-1 truncate text-[12px]" style={{ color: "var(--text-tertiary)" }}>
            {detail}
          </span>
          <StatusIcon
            className="size-3.5 shrink-0"
            style={{ color: failed ? "var(--danger)" : completed && !cancelled ? "var(--success)" : "var(--text-tertiary)" }}
            aria-label={completed ? (failed ? "Failed" : cancelled ? "Cancelled" : "Completed") : "Running"}
          />
        </button>
      </Marker>
      {open ? (
        <div className="mt-1 ml-7 border-l pl-3" style={{ borderColor: "var(--border-subtle)" }}>
          <ToolCallDetailMeta events={events} />
          <pre className="max-h-64 overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap" style={{ color: "var(--text-secondary)" }} data-selectable>
            {detail}
            {outputs.some((event) => event.truncated) ? "\nOutput was truncated for display." : ""}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

function toolRunResult(runs: Array<Extract<ConversationTimelineItem, { kind: "tool" }>>): "running" | "completed" | "failed" | "cancelled" {
  const outcomes = runs.map((run) => run.events.find(
    (event): event is Extract<ToolEvent, { type: "tool.completed" }> => event.type === "tool.completed",
  )?.outcome);
  if (outcomes.some((outcome) => outcome === undefined)) return "running";
  if (outcomes.some((outcome) => outcome === "failed")) return "failed";
  if (outcomes.some((outcome) => outcome === "cancelled")) return "cancelled";
  return "completed";
}

function ToolRun({
  runs,
  settled = false,
}: {
  runs: Array<Extract<ConversationTimelineItem, { kind: "tool" }>>;
  settled?: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const result = toolRunResult(runs);
  if (settled) {
    const countLabel = `${runs.length} tool ${runs.length === 1 ? "call" : "calls"}`;
    const resultLabel = result === "completed" ? "Completed" : result[0]!.toUpperCase() + result.slice(1);
    const ResultIcon = result === "failed" ? X : result === "completed" ? Check : Minus;
    const resultColor = result === "failed"
      ? "var(--danger)"
      : result === "completed"
        ? "var(--success)"
        : "var(--text-tertiary)";
    return (
      <section aria-label={`${countLabel}, ${result}`} className="flex min-w-0 flex-col gap-0.5">
        <button
          type="button"
          className="flex min-w-0 items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-[var(--bg-hover)]"
          aria-label={`${countLabel}, ${result}`}
          aria-expanded={showAll}
          onClick={() => setShowAll((value) => !value)}
        >
          <Wrench className="size-3.5 shrink-0" aria-hidden="true" style={{ color: "var(--text-tertiary)" }} />
          <span className="truncate text-[12px] font-medium" style={{ color: "var(--text-secondary)" }}>{countLabel}</span>
          <span aria-hidden="true" className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>·</span>
          <span className="truncate text-[11px]" style={{ color: resultColor }}>{resultLabel}</span>
          <ResultIcon className="ml-auto size-3.5 shrink-0" aria-hidden="true" style={{ color: resultColor }} />
        </button>
        {showAll ? (
          <div className="flex flex-col gap-0.5 border-l pl-2" style={{ borderColor: "var(--border-subtle)" }}>
            {runs.map((run) => <ToolChip key={run.key} events={run.events} />)}
          </div>
        ) : null}
      </section>
    );
  }
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
    <Marker role="status" aria-label="Agent is working" className="px-1">
      <MarkerIcon className="flex items-center gap-1">
        <span className="h-1 w-1 animate-pulse rounded-full" style={{ background: "var(--text-tertiary)" }} />
        <span className="h-1 w-1 animate-pulse rounded-full [animation-delay:200ms]" style={{ background: "var(--text-tertiary)" }} />
        <span className="h-1 w-1 animate-pulse rounded-full [animation-delay:400ms]" style={{ background: "var(--text-tertiary)" }} />
      </MarkerIcon>
      <MarkerContent className="shimmer text-[11px]">Working…</MarkerContent>
    </Marker>
  );
}

// Subtle per-turn receipt ("Worked for 5m 35s"), rendered after a turn's
// terminal signal. Deliberately non-interactive this wave — no collapse.
function WorkedRow({ label }: { label: string }) {
  return (
    <Marker aria-label={label} className="px-1">
      <MarkerIcon>
        <Check className="size-3.5" style={{ color: "var(--text-tertiary)" }} />
      </MarkerIcon>
      <MarkerContent className="text-[11px]">{label}</MarkerContent>
    </Marker>
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

// Pure status events ("Thread created", "Terminal bound", "Thread
// completed", …) render as compact single-line timeline rows: a small
// leading glyph, the bounded copy, and the timestamp at the right — no card
// background, border, or shadow, so they read as history instead of
// dominating the conversation.
function systemEventIcon(event: AgentThreadEvent) {
  switch (event.type) {
    case "thread.created": return MessageSquarePlus;
    case "thread.completed": return CircleCheck;
    case "thread.error": return CircleAlert;
    case "terminal.bound": return SquareTerminal;
    case "turn.accepted": return Hourglass;
    case "approval.resolved":
    case "user_input.answered": return CircleCheck;
    case "approval.requested":
    case "user_input.requested": return CircleAlert;
    case "file.changed": return FileDiff;
    default: return Info;
  }
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
  // Events carrying a live action — a pending approval decision, a pending
  // input answer, or an openable review — keep the card treatment; every
  // other status event collapses to a compact timeline row.
  const interactive = Boolean(
    (approval && approvalKey && !resolvedApprovals.has(approvalKey))
    || (input && inputKey && !answeredInputs.has(inputKey))
    || event.type === "review.ready",
  );
  if (!interactive) {
    const Glyph = systemEventIcon(event);
    const failed = event.type === "thread.error";
    return (
      <div className="flex w-full items-center gap-2 px-1 py-0.5" data-slot="system-event-row">
        <Glyph
          size={12}
          className="shrink-0"
          style={{ color: failed ? "var(--danger)" : "var(--text-tertiary)" }}
          aria-hidden="true"
        />
        <p className="min-w-0 flex-1 truncate text-[12px]" style={{ color: "var(--text-tertiary)" }}>
          <span className="font-medium" style={{ color: failed ? "var(--danger)" : "var(--text-secondary)" }}>
            {copy.title}
          </span>
          {copy.detail ? (
            <>
              <span aria-hidden="true"> · </span>
              <span>{copy.detail}</span>
            </>
          ) : null}
        </p>
        <span className="shrink-0 text-[10px] tabular-nums" style={{ color: "var(--text-tertiary)" }}>
          {occurredAtLabel(event.occurredAt)}
        </span>
      </div>
    );
  }
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

function TranscriptItem({
  item,
  settled,
  showAssistantMeta = true,
  workedLabel,
  answeredInputs,
  resolvedApprovals,
}: {
  item: TimelineItem;
  settled: boolean;
  showAssistantMeta?: boolean;
  workedLabel: string | undefined;
  answeredInputs: ReadonlySet<string>;
  resolvedApprovals: ReadonlySet<string>;
}) {
  const itemKey = item.kind === "event" ? `event:${item.event.eventId}` : item.key;
  return (
    <Fragment>
      {item.kind === "assistant" ? (
        <ConversationItem messageId={item.key}>
          <AssistantRow events={item.events} showMeta={showAssistantMeta} />
        </ConversationItem>
      ) : item.kind === "tool-run" ? (
        <ConversationItem messageId={item.key}>
          <ToolRun runs={item.runs} settled={settled} />
        </ConversationItem>
      ) : item.event.type === "user.message" ? (
        <ConversationItem messageId={`user:${item.event.messageId}`} scrollAnchor>
          <UserRow event={item.event} />
        </ConversationItem>
      ) : (
        <ConversationItem messageId={`event:${item.event.eventId}`}>
          <SystemEvent event={item.event} answeredInputs={answeredInputs} resolvedApprovals={resolvedApprovals} />
        </ConversationItem>
      )}
      {workedLabel ? (
        <ConversationItem messageId={`turn-summary:${itemKey}`}>
          <WorkedRow label={workedLabel} />
        </ConversationItem>
      ) : null}
    </Fragment>
  );
}

function ConversationComposer({
  threadId,
  projectId,
  providerId,
  waitingForAction,
  threadBusy,
  attachments,
  readiness,
  summary,
}: {
  threadId: string;
  projectId?: string;
  providerId: string;
  waitingForAction: boolean;
  threadBusy: boolean;
  attachments: ReturnType<typeof useConversationAttachments>;
  readiness?: ProviderReadinessPresentation;
  summary?: RuntimeSummary;
}) {
  const [message, setMessage] = useState("");
  const [referenceTokens, setReferenceTokens] = useState<ComposerReferenceToken[]>([]);
  const api = useConnection((state) => state.api);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const turnStatus = useCodingAgentWorkspace((state) => state.turnStatus);
  const turnThreadId = useCodingAgentWorkspace((state) => state.turnThreadId);
  const turnError = useCodingAgentWorkspace((state) => state.turnError);
  const send = useCodingAgentWorkspace((state) => state.sendThreadMessage);
  const refreshSummary = useCodingAgentWorkspace((state) => state.refresh);
  const submitting = turnStatus === "submitting" && turnThreadId === threadId;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fallbackCatalog = useMemo(() => summary
    ? createLegacyProjectProviderCatalog(summary)
    : { revision: "legacy_empty", drivers: [], instances: [] }, [summary]);
  const loadedCatalog = useChatProviderCatalog(fallbackCatalog).catalog;
  const projectCatalog = useMemo(() => summary
    ? filterCatalogForLegacyProject(loadedCatalog, summary)
    : fallbackCatalog, [fallbackCatalog, loadedCatalog, summary]);
  const preferredInstanceId = summary
    ? instanceIdForLegacyProvider(projectCatalog, summary, providerId)
    : undefined;
  const providerStillExists = Boolean(summary?.providers.some((provider) => provider.id === providerId));
  const [selection, setSelection] = useState<CanonicalComposerSelection | null>(
    () => providerStillExists
      ? createCanonicalComposerSelection(fallbackCatalog, preferredInstanceId)
      : null,
  );
  const handleProviderSetup = useProviderSetup(summary?.providers ?? [], refreshSummary);

  useEffect(() => {
    setSelection((current) => {
      if (!providerStillExists) return null;
      const preferred = createCanonicalComposerSelection(projectCatalog, preferredInstanceId);
      if (!preferred) return null;
      return current
        && current.instanceId === preferred.instanceId
        && projectCatalog.instances.some((instance) => (
          instance.id === current.instanceId
          && instance.models.some((model) => model.id === current.model && model.availability === "available")
        ))
        ? current
        : preferred;
    });
  }, [preferredInstanceId, projectCatalog, providerStillExists]);
  // Stop renders while the thread is busy and the preload bridge carries the
  // "runtime:abort-thread" channel (see abort-thread.ts).
  const abortSupported = agentThreadAbortSupported();

  async function submit(submission: SharedChatComposerSubmission) {
    if (
      (!submission.agentPrompt && attachments.items.length === 0)
      || readiness?.blocked
      || waitingForAction
      || threadBusy
      || submitting
      || uploadingAttachments
    ) return;
    // Every accepted submit is a direct send. While the thread is known busy,
    // the draft remains local and editable, but Matrix does not offer a doomed
    // send or invent a renderer-owned queue.
    // Pending messages are durable server-owned records (SPEC 105 FR-100), and
    // queueing must be explicit rather than silent (FR-027, FR-101), so this
    // client deliberately keeps no local queue: a renderer-only queue would be
    // lost on reload and invisible to the mobile, browser, and CLI shells.
    setUploadingAttachments(true);
    try {
      const uploaded = await attachments.uploadAll();
      if (!uploaded.ok) return;
      const sent = await send({
        threadId,
        message: submission.agentPrompt || "Please inspect the attached files.",
        ...(uploaded.attachments.length > 0 ? { attachments: uploaded.attachments } : {}),
      });
      if (sent) {
        setMessage("");
        setReferenceTokens([]);
        attachments.clear();
      }
    } finally {
      setUploadingAttachments(false);
    }
  }

  return (
    <div className="shrink-0 px-6 pb-5">
      {/* Floating composer card: same centered column as the transcript; the
          rounded/shadowed surface itself lives on PromptInput's prompt-card. */}
      <div className={cn("mx-auto w-full", CHAT_CONTENT_WIDTH_CLASS)} data-slot="conversation-composer">
        {turnThreadId === threadId && turnError ? (
          <p className="mb-1 px-1 text-xs" style={{ color: "var(--danger)" }}>{turnError}</p>
        ) : null}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          aria-label="Choose files"
          className="sr-only"
          onChange={(event) => {
            attachments.add(Array.from(event.currentTarget.files ?? []));
            event.currentTarget.value = "";
          }}
        />
        <SharedChatComposer
          value={message}
          onChange={setMessage}
          referenceTokens={referenceTokens}
          onReferenceTokensChange={setReferenceTokens}
          onSubmit={(submission) => void submit(submission)}
          onAbort={abortSupported && (submitting || threadBusy) ? () => void abortAgentThread(threadId) : undefined}
          busy={submitting || threadBusy || uploadingAttachments}
          disabled={waitingForAction || uploadingAttachments}
          canSubmit={
            !readiness?.blocked
            && !waitingForAction
            && !threadBusy
            && !submitting
            && !uploadingAttachments
            && (message.trim().length > 0 || attachments.items.length > 0 || referenceTokens.length > 0)
          }
          catalog={projectCatalog}
          selection={selection}
          onSelectionChange={setSelection}
          onProviderSetup={(instance, action) => void handleProviderSetup(instance, action)}
          instanceLocked
          unavailableProviderLabel={selection ? undefined : `${providerId} (unavailable)`}
          resources={projectId ? [{ kind: "project", id: projectId, label: projectId }] : []}
          resourceSearch={(query) => api && projectId
            ? searchProjectChatResources(api, projectId, query)
            : Promise.resolve([])}
          onAttach={() => fileInputRef.current?.click()}
          attachments={(
            <AttachmentPreviewRow
              items={attachments.items}
              disabled={uploadingAttachments}
              onRemove={attachments.remove}
              onRetry={(localId) => void attachments.retry(localId)}
            />
          )}
          // Matches the CreateAgentTurnRequestSchema message cap so oversized
          // drafts are prevented client-side instead of failing generically.
          maxLength={24_000}
          ariaLabel="Message conversation"
          placeholder={waitingForAction
            ? "Respond to the pending request above to continue"
            : threadBusy
              ? "Draft a follow-up…"
              : "Ask a follow-up…"}
          footer={
            threadBusy && !waitingForAction ? (
              <span className="text-xs">Agent is working — draft now, send when this turn finishes</span>
            ) : undefined
          }
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
  summary,
}: {
  status: ConversationStatus;
  snapshot: AgentThreadSnapshot | null;
  error: string | null;
  canSendTurns: boolean;
  // When provided, the composer bar shows the thread's provider as a
  // display-only picker (turns cannot change provider or mode).
  summary?: RuntimeSummary;
}) {
  const threadRunning = snapshot?.thread.status === "running"
    || snapshot?.thread.status === "starting"
    || snapshot?.thread.status === "queued";
  const threadActive = threadRunning
    || snapshot?.thread.status === "waiting_for_approval"
    || snapshot?.thread.status === "waiting_for_input";
  const attachments = useConversationAttachments(snapshot?.thread.id ?? null);
  const timeline = useMemo(
    () => projectConversationTimeline(snapshot?.events.items ?? [], threadActive),
    [snapshot?.events.items, threadActive],
  );
  const { items, sections } = timeline;
  // Per-turn "Worked for Xs" rows, derived from event timestamps only.
  const turnSummaryByItemKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const summary of deriveTurnSummaries(snapshot?.events.items ?? [], threadActive)) {
      // Grouped assistant messages can complete after an intervening tool row
      // while still rendering at their first-event position. Anchor the receipt
      // to the last VISUAL timeline item that began within the finished turn.
      let anchor: TimelineItem | undefined;
      for (const item of items) {
        if (item.order > summary.endOrder) break;
        anchor = item;
      }
      if (!anchor) continue;
      const key = anchor.kind === "event" ? `event:${anchor.event.eventId}` : anchor.key;
      map.set(key, summary.label);
    }
    return map;
  }, [items, snapshot?.events.items, threadActive]);
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

  const running = threadRunning;
  const lastItem = items.at(-1);
  const streamingAssistant = lastItem?.kind === "assistant"
    && !lastItem.events.some((event) => event.type === "assistant.text.completed");
  const showWorking = running && !streamingAssistant;
  // Project Chats always supplies the runtime summary. Keeping this optional
  // preserves the transcript component's isolated story/test seam; every
  // product send path derives fail-closed readiness from the stored provider.
  const providerReadiness = summary
    ? deriveProviderReadiness({
        summary,
        providerId: snapshot.thread.providerId,
        loading: false,
      })
    : undefined;

  return (
    <section aria-label={`Conversation ${snapshot.thread.title}`} className="ph-no-capture flex min-h-[460px] min-w-0 flex-1 flex-col overflow-hidden" style={{ background: "var(--bg-app)" }} {...attachments.paneProps}>
      {/* pr-12 reserves the top-right corner for the floating inspector
          toggle (ProjectChatsView overlays it at right-2.5 top-2.5), so the
          attention pill is never clipped beneath it; the title column is the
          only element allowed to shrink and truncate. */}
      <header className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3 pr-12" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}>
        <div className="min-w-0 flex-1">
          <span className="sr-only">Thread details</span>
          <h2 className="truncate text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{snapshot.thread.title}</h2>
          <p className="flex min-w-0 items-center gap-1 truncate text-xs capitalize" style={{ color: "var(--text-tertiary)" }}>
            <span>{snapshot.thread.providerId}</span><span aria-hidden="true">·</span><span>{snapshot.thread.status.replaceAll("_", " ")}</span>
          </p>
        </div>
        {snapshot.thread.attention !== "none" ? <span className="shrink-0 whitespace-nowrap rounded-full px-2 py-1 text-[10px] font-semibold capitalize" style={{ background: "var(--warning-muted)", color: "var(--warning)" }}>{snapshot.thread.attention.replaceAll("_", " ")}</span> : null}
      </header>
      <Conversation key={`transcript:${snapshot.thread.id}`}>
        <ConversationContent>
          {sections.map((section) => {
            if (section.kind === "standalone") {
              const itemKey = section.item.kind === "event" ? `event:${section.item.event.eventId}` : section.item.key;
              return (
                <TranscriptItem
                  key={section.key}
                  item={section.item}
                  settled={!threadActive}
                  workedLabel={turnSummaryByItemKey.get(itemKey)}
                  answeredInputs={answeredInputs}
                  resolvedApprovals={resolvedApprovals}
                />
              );
            }
            const lastAgentOutputIndex = section.items.reduce(
              (lastIndex, item, index) => item.kind === "assistant" || item.kind === "tool-run" ? index : lastIndex,
              -1,
            );
            return (
              <section
                key={section.key}
                aria-label="Conversation turn"
                data-slot="agent-turn"
                data-state={section.settled ? "settled" : "active"}
                className="flex min-w-0 flex-col gap-2"
              >
                {section.items.map((item, index) => {
                  const itemKey = item.kind === "event" ? `event:${item.event.eventId}` : item.key;
                  // An assistant row followed by more assistant/tool output is
                  // commentary, not the turn result. Keep its text selectable
                  // without reserving a hidden copy/timestamp footer.
                  return (
                    <TranscriptItem
                      key={itemKey}
                      item={item}
                      settled={section.settled}
                      showAssistantMeta={item.kind === "assistant" && index === lastAgentOutputIndex}
                      workedLabel={turnSummaryByItemKey.get(itemKey)}
                      answeredInputs={answeredInputs}
                      resolvedApprovals={resolvedApprovals}
                    />
                  );
                })}
              </section>
            );
          })}
          {showWorking ? (
            <ConversationItem messageId="agent:working">
              <WorkingRow />
            </ConversationItem>
          ) : null}
          {items.length === 0 && !showWorking ? (
            <p className="py-12 text-center text-sm" style={{ color: "var(--text-tertiary)" }}>
              {canSendTurns ? "Send a message to start the conversation." : "No messages yet."}
            </p>
          ) : null}
        </ConversationContent>
      </Conversation>
      {canSendTurns ? (
        // The gateway rejects turns while the thread waits for an approval or
        // input answer, so the composer is disabled rather than offering a
        // doomed send.
        <ConversationComposer
          key={`composer:${snapshot.thread.id}`}
          threadId={snapshot.thread.id}
          projectId={snapshot.thread.projectId}
          providerId={snapshot.thread.providerId}
          waitingForAction={snapshot.thread.status === "waiting_for_approval" || snapshot.thread.status === "waiting_for_input"}
          threadBusy={running}
          attachments={attachments}
          readiness={providerReadiness}
          summary={summary}
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
