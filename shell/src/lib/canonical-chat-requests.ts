import type { CanonicalChatRunActivity, CanonicalChatRun } from "@matrix-os/contracts";
import type { ChatMessage } from "./chat";

/** Run activities are the source of live consent; message parts alone omit Codex requests. */
export function projectCanonicalRequests(activities: CanonicalChatRunActivity[], runs: CanonicalChatRun[], messages: ChatMessage[] = []): ChatMessage[] {
  const requests = new Map<string, ChatMessage>(); // Bounded by the API's message and 500-event replay windows.
  const isActive = (id: string) => runs.some((run) => run.id === id
    && ["accepted", "running", "waiting_for_approval", "waiting_for_input"].includes(run.status));
  const ordinary = messages.filter((message) => {
    const approval = message.metadata?.canonicalApproval;
    if (!approval || typeof approval !== "object" || !("runId" in approval) || !("approvalId" in approval)
      || typeof approval.runId !== "string" || typeof approval.approvalId !== "string") return true;
    requests.set(`${approval.runId}:approval:${approval.approvalId}`, { ...message,
      metadata: { ...message.metadata, canonicalApproval: { ...approval, pending: isActive(approval.runId) && "pending" in approval && approval.pending === true } } });
    return false;
  });
  for (const event of activities.slice(-500)) {
    const run = runs.find((run) => run.id === event.runId);
    if (!run) continue;
    const active = isActive(run.id);
    if (event.type === "approval.requested") {
      const id = `${event.runId}:approval:${event.approvalId}`;
      if (requests.has(id)) continue;
      requests.set(id, { id, role: "system", content: event.title, timestamp: Date.parse(event.occurredAt),
        metadata: { canonicalApproval: { runId: event.runId, approvalId: event.approvalId, title: event.title,
          description: "Review this request to continue.", risk: event.risk, allowedDecisions: event.allowedDecisions, pending: active } } });
    } else if (event.type === "input.requested" && event.input) {
      const id = `${event.runId}:input:${event.requestId}`;
      requests.set(id, { id, role: "system", content: event.title, timestamp: Date.parse(event.occurredAt),
        metadata: { canonicalInput: { runId: event.runId, request: event.input, pending: active } } });
    } else if (event.type === "approval.resolved" || event.type === "input.resolved") {
      const id = event.type === "approval.resolved" ? `${event.runId}:approval:${event.approvalId}` : `${event.runId}:input:${event.requestId}`;
      const request = requests.get(id);
      const key = event.type === "approval.resolved" ? "canonicalApproval" : "canonicalInput";
      const value = request?.metadata?.[key];
      if (request && value && typeof value === "object") requests.set(id, { ...request, metadata: { [key]: { ...value, pending: false } } });
    }
  }
  return [...ordinary, ...requests.values()].sort((left, right) => left.timestamp - right.timestamp);
}
