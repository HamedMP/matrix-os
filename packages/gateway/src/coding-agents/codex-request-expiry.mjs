/** Remove ownership before emitting any asynchronous resolution. Never grant on expiry. */
export async function expireNativeRequests({ approvals, inputs, send, persist, now, all = false, reply = true }) {
  const events = [];
  for (const [approvalId, entry] of approvals) {
    if (!all && entry.expiresAt > now) continue;
    approvals.delete(approvalId);
    if (reply) cancel(send, { id: entry.nativeRequestId, result: { decision: "cancel" } });
    events.push({ type: "matrix.codex.approval.resolved", approvalId, decision: "cancel" });
  }
  for (const [requestId, entry] of inputs) {
    if (!all && entry.expiresAt > now) continue;
    inputs.delete(requestId);
    if (reply) cancel(send, { id: entry.nativeRequestId, result: { answers: {} } });
    events.push({ type: "matrix.codex.user_input.resolved", requestId, correlationId: entry.correlationId });
  }
  for (const event of events) await persist(event);
}

export function cancel(send, response) {
  try { send(response); }
  catch (error) {
    if (!(error instanceof Error)) throw error;
    console.warn("[coding-agents] cancellation transport unavailable");
  }
}
