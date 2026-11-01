import type { RoutineCliResult, RoutineCliErrorCode } from "@matrix-os/contracts/routine-cli";
const label = (value: string) => value.replace(/[\p{Cc}\p{Cf}]/gu, char => `\\u${char.codePointAt(0)!.toString(16).padStart(4, "0")}`);
export function routineExitCode(value: RoutineCliResult | RoutineCliErrorCode) {
  if (typeof value !== "string") return value.kind === "unknown" ? 75 : 0;
  return value === "invalid_input" ? 2 : ["permission_denied", "source_context_required"].includes(value) ? 3
    : ["revision_conflict", "request_conflict", "target_required", "target_unavailable", "not_found"].includes(value) ? 4 : 1;
}
export function formatRoutineHuman(result: RoutineCliResult): string {
  if (result.kind === "list") return result.routines.length ? result.routines.map(r => `${r.routineId} ${label(r.name)}: ${r.status}, revision ${r.revision}${r.requiresReview ? "; review required" : ""}`).join("\n") + (result.truncated ? "\nMore history is available." : "") : "No routines observed.";
  if (result.kind === "show") return `${result.routine.routineId} ${label(result.routine.name)}: ${result.routine.status}, revision ${result.routine.revision}${result.routine.requiresReview ? "; review required" : ""}.\nObserved fires: ${result.history.fires.map(f => f.status).join(", ") || "none"}${result.history.truncated ? " (truncated)" : ""}.`;
  if (result.kind === "not_observed") return `Request ${result.requestId} is not observed; it may still arrive. Reconcile with routines request ${result.requestId}.`;
  if (result.kind === "unknown") return `Request ${result.requestId}: outcome unknown. Do not retry the mutation. Reconcile with routines request ${result.requestId} from a fresh authorized source.`;
  const { receipt, proposal } = result;
  const reconcile = `Read current progress with routines request ${receipt.requestId} from a fresh authorized source.`;
  if (receipt.operation === "propose") {
    if (proposal?.routine) return `Routine ${proposal.routine.routineId}: ${proposal.routine.status}, revision ${proposal.routine.revision}. ${reconcile}`;
    const approval = proposal?.approval;
    if (approval === "pending" || !proposal && result.approval === "pending") return `Pending human approval. ${reconcile}`;
    if (approval === "approved") return proposal?.routineLink === "unavailable"
      ? `Approved; current routine link unavailable. The routine may have changed; inspect routines list or routines show. ${reconcile}`
      : `Approved; no standing routine is confirmed. ${reconcile}`;
    if (approval === "denied") return `Declined; no standing routine is confirmed. ${reconcile}`;
    if (approval === "expired" || approval === "cancelled") return `Approval ${approval}; no standing routine is confirmed. ${reconcile}`;
    if (proposal?.handoff === "rejected") return `Handoff rejected after admission. ${reconcile}`;
    return `${receipt.disposition === "unknown" || proposal?.handoff === "unknown" ? "Outcome unknown" : "Queued"}; human approval and activation are not yet observed. ${reconcile}`;
  }
  return receipt.disposition === "applied" ? `Desired state ${receipt.routine.status} committed at revision ${receipt.routine.revision}.${receipt.operation === "pause" || receipt.operation === "archive" ? " Worker/effect stop remains unconfirmed." : ""} ${reconcile}` : `${receipt.disposition}. ${reconcile}`;
}
