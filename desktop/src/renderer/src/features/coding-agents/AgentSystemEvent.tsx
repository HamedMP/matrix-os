import type { AgentThreadEvent } from "@matrix-os/contracts";
import { CircleAlert, CircleCheck, FileDiff, GitPullRequest, Hourglass, Info, MessageSquarePlus, SquareTerminal } from "@renderer/lib/hugeicons";
import { useState } from "react";
import { StructuredInputForm } from "../../components/conversation/StructuredInputForm";
import { Button } from "../../design/primitives";
import { codingAgentApprovalActionKey, codingAgentInputActionKey, useCodingAgentWorkspace } from "../../stores/coding-agent-workspace";

function occurredAtLabel(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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

export function SystemEvent({ event, answeredInputs, resolvedApprovals }: {
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
        input.questions ? <StructuredInputForm key={inputKey} request={input} submit={async (structuredAnswers) => {
          await submitInput({ threadId: input.threadId, inputRequestId: input.requestId, answer: "Structured response submitted.", structuredAnswers, correlationId: input.correlationId });
          if (useCodingAgentWorkspace.getState().inputActionErrors[inputKey]) throw new Error("InputSubmissionFailed");
        }} /> :
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
