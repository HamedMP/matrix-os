"use client";
import React, { useState } from "react";
import type { CanonicalChatApprovalView, CanonicalChatApprovalDecision } from "@matrix-os/contracts";
import { CanonicalChatInputForm } from "../chat/CanonicalChatInputForm.js";
import type { AoedeController } from "./controller.js";
import type { AoedeCanonicalProjection } from "./projection.js";
import { boundedAoedeText } from "./presentation.js";

const decisions: Record<CanonicalChatApprovalDecision, string> = { approve: "Approve", approve_for_session: "Approve for session", decline: "Decline", cancel: "Cancel" };
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
    {view.pending ? <div role="group" aria-label="Approval decision">{view.allowedDecisions.map(decision =>
      <button key={decision} type="button" disabled={busy || !view.argumentDigest} onClick={() => void submit(decision)}>{decisions[decision]}</button>)}</div> : null}
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
export interface AoedeCanonicalCardsProps { projection: AoedeCanonicalProjection; controller: AoedeController }
/** Canonical control cards, not another task ledger or a conversation transcript. */
export function AoedeCanonicalCards({ projection, controller }: AoedeCanonicalCardsProps) {
  return <>
    {projection.approvals.map(view => <ApprovalCard key={`${view.runId}:${view.approvalId}:${view.argumentDigest}`} view={view} controller={controller} />)}
    {projection.inputs.map(request => <CanonicalChatInputForm key={`${request.runId}:${request.requestId}:${request.id}`} request={request} onSubmit={answer => controller.submitInput(request, answer)} />)}
    {projection.progress.length ? <section aria-label="Canonical activity"><h3>Activity</h3><ul>{projection.progress.map(activity =>
      <li key={`${projection.runId}:${activity.id}`}><span>{activity.label}</span><span> · {activity.state}</span>
        {activity.subagent ? <span> · Delegated work</span> : null}</li>)}</ul></section> : null}
    {projection.canCancel ? <CancellationCard key={projection.runId} controller={controller} /> : null}
    {projection.outcome ? <p role="status">{projection.outcome === "completed" ? "Completed" : projection.outcome === "aborted" ? "Generation cancelled" : "Failed"}</p> : null}
    {projection.artifacts.length ? <section aria-label="Results"><h3>Results</h3>{projection.artifacts.map(artifact =>
      <button type="button" key={artifact.path} onClick={() => controller.openResult(artifact.path)}>Open result: {artifact.label}</button>)}</section> : null}
  </>;
}
