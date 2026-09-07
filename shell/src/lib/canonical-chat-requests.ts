import type { CanonicalChatRunActivity, CanonicalChatRun } from "@matrix-os/contracts";
import type { ChatMessage } from "./chat";

/** Run activities are the source of live consent; message parts alone omit Codex requests. */
export function projectCanonicalRequests(activities: CanonicalChatRunActivity[], runs: CanonicalChatRun[], messages: ChatMessage[] = []): ChatMessage[] {
  const requests = new Map<string, ChatMessage>(); // Local cap: 500, evict oldest insertion first.
  const setRequest = (id: string, message: ChatMessage) => {
    if (!requests.has(id) && requests.size >= 500) requests.delete(requests.keys().next().value!);
    requests.set(id, message);
  };
  const isActive = (id: string) => runs.some((run) => run.id === id
    && ["accepted", "running", "waiting_for_approval", "waiting_for_input"].includes(run.status));
  const ordinary = messages.filter((message) => {
    const approval = message.metadata?.canonicalApproval;
    if (!approval || typeof approval !== "object" || !("runId" in approval) || !("approvalId" in approval)
      || typeof approval.runId !== "string" || typeof approval.approvalId !== "string") return true;
    setRequest(`${approval.runId}:approval:${approval.approvalId}`, { ...message,
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
      setRequest(id, { id, role: "system", content: event.title, timestamp: Date.parse(event.occurredAt),
        metadata: { canonicalApproval: { runId: event.runId, approvalId: event.approvalId, title: event.title,
          description: event.description ?? "Review this request to continue.", risk: event.risk, allowedDecisions: event.allowedDecisions, pending: active } } });
    } else if (event.type === "input.requested") {
      const id = `${event.runId}:input:${event.requestId}`;
      setRequest(id, { id, role: "system", content: event.title, timestamp: Date.parse(event.occurredAt),
        metadata: { canonicalInput: { runId: event.runId, pending: active,
          ...(event.input ? { request: event.input } : { requestId: event.requestId, title: event.title }) } } });
    } else if (event.type === "approval.resolved" || event.type === "input.resolved") {
      const id = event.type === "approval.resolved" ? `${event.runId}:approval:${event.approvalId}` : `${event.runId}:input:${event.requestId}`;
      const request = requests.get(id);
      const key = event.type === "approval.resolved" ? "canonicalApproval" : "canonicalInput";
      const value = request?.metadata?.[key];
      if (request && value && typeof value === "object") setRequest(id, { ...request, metadata: { [key]: { ...value, pending: false } } });
    }
  }
  return [...ordinary, ...requests.values()].sort((left, right) => left.timestamp - right.timestamp);
}
