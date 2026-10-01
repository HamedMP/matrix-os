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
  return <section aria-label={`Action ${view.toolId}`}>
    <p><span>{view.toolId}</span> · <span>{operationStates[view.state]}</span></p>
    {view.cancellationRequested ? <p>Cancel requested</p> : null}
    {requested ? <p>Cancel requested — the effect may still complete</p> : null}
    {cancellable ? <button type="button" disabled={busy} onClick={() => void cancel()}>{busy ? "Cancelling…" : "Cancel action"}</button> : null}
    {failed ? <p role="alert">The action could not be cancelled. Its current state is shown above.</p> : null}
  </section>;
}
export interface AoedeCanonicalCardsProps { projection: AoedeCanonicalProjection; controller: AoedeController }
/** Canonical control cards, not another task ledger or a conversation transcript. */
export function AoedeCanonicalCards({ projection, controller }: AoedeCanonicalCardsProps) {
  const runOperations = projection.operations.filter(operation => operation.runId === projection.runId);
  const cancellable = new Set(projection.cancellableActionIds);
  return <>
    {projection.approvals.map(view => <ApprovalCard key={`${view.runId}:${view.approvalId}:${view.argumentDigest}`} view={view} controller={controller} />)}
    {projection.inputs.map(request => <CanonicalChatInputForm key={`${request.runId}:${request.requestId}:${request.id}`} request={request} onSubmit={answer => controller.submitInput(request, answer)} />)}
    {projection.progress.length ? <section aria-label="Canonical activity"><h3>Activity</h3><ul>{projection.progress.map(activity =>
      <li key={`${projection.runId}:${activity.id}`}><span>{activity.label}</span><span> · {activity.state}</span>
        {activity.subagent ? <span> · Delegated work</span> : null}</li>)}</ul></section> : null}
    {runOperations.map(view => <OperationCard key={view.id} view={view}
      cancellable={cancellable.has(view.id)} controller={controller} />)}
    {projection.outcomeUnknown.length ? <p role="status">The action's outcome is unknown; it will be reconciled — not retried.</p> : null}
    {projection.canCancel ? <CancellationCard key={projection.runId} controller={controller} /> : null}
    {projection.outcome ? <p role="status">{projection.outcome === "completed" ? "Completed" : projection.outcome === "aborted" ? "Generation cancelled" : "Failed"}</p> : null}
    {projection.navigation ? <button type="button" onClick={() => controller.openNavigation({ app: projection.navigation!.app, path: projection.navigation!.path })}>Open {projection.navigation.app}</button> : null}
    {projection.artifacts.length ? <section aria-label="Results"><h3>Results</h3>{projection.artifacts.map(artifact =>
      <button type="button" key={artifact.path} onClick={() => controller.openResult(artifact.path)}>Open result: {artifact.label}</button>)}</section> : null}
    {projection.actionArtifacts.length ? <section aria-label="Action results"><h3>Action results</h3>{projection.actionArtifacts.map(path =>
      <button type="button" key={path} onClick={() => controller.openResult(path)}>Open result: {path}</button>)}</section> : null}
  </>;
}
