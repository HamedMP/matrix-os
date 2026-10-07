"use client";
import React, { useState } from "react";
import type { CanonicalChatApprovalView, CanonicalChatApprovalDecision, CanonicalOperationView } from "@matrix-os/contracts";
import { CanonicalChatInputForm } from "../chat/CanonicalChatInputForm.js";
import { Button } from "../Button.js";
import type { AoedeController } from "./controller.js";
import type { AoedeCanonicalProjection } from "./projection.js";
import { boundedAoedeText } from "./presentation.js";

const decisions: Record<CanonicalChatApprovalDecision, string> = { approve: "Approve", approve_for_session: "Approve for session", decline: "Decline", cancel: "Cancel" };
const operationStates: Record<CanonicalOperationView["state"], string> = {
  proposed: "Proposed",
  waiting_for_approval: "Waiting for approval",
  authorized: "Approved, starting",
  running: "Running",
  succeeded: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
  timed_out: "Timed out",
  outcome_unknown: "Outcome unknown — will be reconciled",
};
function friendlyToolLabel(toolId: string): string {
  const words = toolId.replace(/^matrix_/, "").replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Tool";
}
function WrenchIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M14.7 6.3a4 4 0 0 0-5-5L12 3.6 9.6 6 7.3 3.7a4 4 0 0 0 5 5L4 17a2.1 2.1 0 1 0 3 3l8.3-8.3a4 4 0 0 0 5-5L18 9l-2.4-2.4 2.3-2.3a4 4 0 0 0-3.2 2Z" /></svg>;
}
function ChevronIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6" /></svg>;
}
function ApprovalCard({ view, controller }: { view: CanonicalChatApprovalView; controller: AoedeController }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const submit = async (decision: CanonicalChatApprovalDecision) => {
    if (busy) return;
    setBusy(true); setFailed(false);
    try { setFailed(!await controller.submitApproval(view, decision)); }
    catch (error: unknown) { console.warn("[aoede] approval unavailable", error instanceof Error ? error.name : "UnknownError"); setFailed(true); }
    finally { setBusy(false); }
  };
  return <section aria-label="Action approval">
    <h3>{boundedAoedeText(view.title, 160)}</h3>
    {view.description ? <p>{boundedAoedeText(view.description)}</p> : null}
    <p>{view.pending ? "Your decision is required" : view.decision ? `Decision: ${decisions[view.decision]}` : "Approval closed"}</p>
    {view.pending ? <div className="matrix-aoede__decisions" role="group" aria-label="Approval decision">{view.allowedDecisions.map(decision =>
      <Button key={decision} className="matrix-aoede__button" variant={decision === "approve" || decision === "approve_for_session" ? "primary" : "secondary"}
        disabled={busy || !view.argumentDigest} onClick={() => void submit(decision)}>{decisions[decision]}</Button>)}</div> : null}
    {view.pending && !view.argumentDigest ? <p>This action has no verified argument binding. It cannot be approved here.</p> : null}
    {failed ? <p role="alert">The decision could not be applied. Review the current action and try again.</p> : null}
  </section>;
}
function CancellationCard({ controller }: { controller: AoedeController }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const cancel = async () => {
    if (busy) return;
    setBusy(true); setFailed(false);
    try { setFailed(!await controller.cancelGeneration()); }
    catch (error: unknown) { console.warn("[aoede] cancellation unavailable", error instanceof Error ? error.name : "UnknownError"); setFailed(true); }
    finally { setBusy(false); }
  };
  return <div><button type="button" disabled={busy} onClick={() => void cancel()}>Cancel generation</button>
    {failed ? <p role="alert">Generation could not be cancelled. Its current state is shown above.</p> : null}</div>;
}
/** One safe operation view per canonical action — tool label and state only, never arguments. */
function OperationCard({ view, cancellable, controller }: {
  view: CanonicalOperationView;
  cancellable: boolean;
  controller: AoedeController;
}) {
  const [busy, setBusy] = useState(false);
  const [requested, setRequested] = useState(false);
  const [failed, setFailed] = useState(false);
  const cancel = async () => {
    if (busy) return;
    setBusy(true); setFailed(false);
    try {
      const outcome = await controller.cancelAction(view.id);
      if (outcome === "requested") setRequested(true);
      setFailed(outcome === null || outcome === "unknown");
    }
    catch (error: unknown) { console.warn("[aoede] action cancellation unavailable", error instanceof Error ? error.name : "UnknownError"); setFailed(true); }
    finally { setBusy(false); }
  };
  return <section aria-label={`Action ${friendlyToolLabel(view.toolId)}`}>
    <p><span>{friendlyToolLabel(view.toolId)}</span> · <span>{operationStates[view.state]}</span></p>
    {view.cancellationRequested ? <p>Cancel requested</p> : null}
    {requested ? <p>Cancel requested — the effect may still complete</p> : null}
    {cancellable ? <button type="button" disabled={busy} onClick={() => void cancel()}>{busy ? "Cancelling…" : "Cancel action"}</button> : null}
    {failed ? <p role="alert">The action could not be cancelled. Its current state is shown above.</p> : null}
  </section>;
}
type ToolDetail = { id: string; label: string; state: string };
function ToolDisclosure({ tools }: { tools: ToolDetail[] }) {
  const [open, setOpen] = useState(false);
  const label = `${tools.length} ${tools.length === 1 ? "tool" : "tools"}`;
  return <section className="matrix-aoede__tool-disclosure">
    <button className="matrix-aoede__tool-disclosure-trigger" type="button" aria-label={label} aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <WrenchIcon /><span>{label}</span><ChevronIcon />
    </button>
    {open ? <ul>{tools.map(tool => <li key={tool.id}><span>{tool.label}</span><span>{tool.state}</span></li>)}</ul> : null}
  </section>;
}
export interface AoedeCanonicalCardsProps { projection: AoedeCanonicalProjection; controller: AoedeController }
/** Canonical control cards, not another task ledger or a conversation transcript. */
export function AoedeCanonicalCards({ projection, controller }: AoedeCanonicalCardsProps) {
  const runOperations = projection.operations.filter(operation => operation.runId === projection.runId);
  const cancellable = new Set(projection.cancellableActionIds);
  const exposedOperations = runOperations.filter(operation => cancellable.has(operation.id)
    || operation.cancellationRequested || operation.state === "failed" || operation.state === "outcome_unknown");
  const hiddenProgress = projection.progress.filter(activity => activity.state !== "failed");
  // Qualified runs have authoritative operations. Provider progress can emit
  // several differently ordered representations of each call; never zip them
  // onto operations or let a stale provider status override a completed action.
  const technicalTools: ToolDetail[] = runOperations.length
    ? runOperations.map(operation => ({ id: operation.id, label: friendlyToolLabel(operation.toolId), state: operationStates[operation.state] }))
    : hiddenProgress.map(activity => ({ id: activity.id,
      label: activity.label.startsWith("matrix_") ? friendlyToolLabel(activity.label) : activity.label,
      state: activity.state === "completed" ? "Done" : friendlyToolLabel(activity.state),
    }));
  return <>
    {projection.tasks?.length ? <section aria-label="Chat tasks"><h3>Tasks</h3>{projection.tasks.map(task => <div key={task.chatId}>
      <p>{boundedAoedeText(task.label, 160)}{task.state ? ` · ${task.state.replaceAll("_", " ")}` : ""}</p>
      <button type="button" onClick={() => controller.openLinkedChat(task.chatId)}>Open task in Chat</button>
      {task.state === "waiting_for_approval" ? <p>Review the exact action in Chat before approving.</p> : null}
    </div>)}</section> : null}
    {projection.sources?.length ? <section aria-label="Previous chat sources"><h3>Sources</h3>{projection.sources.map(source => <div key={source.chatId}>
      <button type="button" onClick={() => controller.openLinkedChat(source.chatId)}>{boundedAoedeText(source.title, 160)}</button>
      <p>{boundedAoedeText(source.snippet, 1600)}</p>
    </div>)}</section> : null}
    {projection.approvals.map(view => <ApprovalCard key={`${view.runId}:${view.approvalId}:${view.argumentDigest}`} view={view} controller={controller} />)}
    {projection.inputs.map(request => <CanonicalChatInputForm key={`${request.runId}:${request.requestId}:${request.id}`} request={request} onSubmit={answer => controller.submitInput(request, answer)} />)}
    {technicalTools.length ? <ToolDisclosure tools={technicalTools} /> : null}
    {projection.progress.some(activity => activity.state === "failed") ? <section aria-label="Activity errors"><h3>Errors</h3><ul>{projection.progress.filter(activity => activity.state === "failed").map(activity =>
      <li key={`${projection.runId}:${activity.id}`}><span>{activity.label}</span><span> · {activity.state}</span>
        {activity.subagent ? <span> · Delegated work</span> : null}</li>)}</ul></section> : null}
    {exposedOperations.map(view => <OperationCard key={view.id} view={view}
      cancellable={cancellable.has(view.id)} controller={controller} />)}
    {projection.outcomeUnknown.length ? <p role="status">The action's outcome is unknown; it will be reconciled — not retried.</p> : null}
    {projection.canCancel ? <CancellationCard key={projection.runId} controller={controller} /> : null}
    {projection.outcome && projection.outcome !== "completed" ? <p role="status">{projection.outcome === "aborted" ? "Generation cancelled" : "Failed"}</p> : null}
    {projection.navigation ? <button type="button" onClick={() => controller.openNavigation({ app: projection.navigation!.app, path: projection.navigation!.path })}>Open {projection.navigation.app}</button> : null}
    {projection.artifacts.length ? <section aria-label="Results"><h3>Results</h3>{projection.artifacts.map(artifact =>
      <button type="button" key={artifact.path} onClick={() => controller.openResult(artifact.path)}>Open result: {artifact.label}</button>)}</section> : null}
    {projection.actionArtifacts.length ? <section aria-label="Action results"><h3>Action results</h3>{projection.actionArtifacts.map(path =>
      <button type="button" key={path} onClick={() => controller.openResult(path)}>Open result: {path}</button>)}</section> : null}
  </>;
}
