import React from "react";
import { createRoot } from "react-dom/client";
import { RoutineActionConfirmation } from "../../../packages/ui/src/routine-action/RoutineActionConfirmation";
import { CanonicalApprovalMessage } from "../../../shell/src/components/chat/CanonicalApprovalMessage";
import type { RoutineActionView } from "../../../packages/contracts/src/routine-action";

export const pending: RoutineActionView = {
  challengeId: `rcact_${"a".repeat(32)}`, actionDigest: "d".repeat(64), sourceKind: "terminal_launch", operation: "pause",
  intent: { operation: "pause", requestId: "de000000-0000-4000-8000-000000000001", routineId: `rt_${"b".repeat(24)}`, baseRevision: 3 },
  target: { botId: "bot_fixture", chatId: "chat_fixture" }, sourceLabel: "Terminal fixture",
  expiresAt: "2099-01-01T00:00:00.000Z", status: "pending", title: "Allow routine pause?",
  description: "Allow this operation only. Routine activation, background model consent and integration permissions remain separate.",
};
const client = { read: async () => pending, list: async () => [pending], submit: async () => ({ submission: "accepted" as const }) };
const message = { id: "message_fixture", role: "system" as const, content: "Fixture confirmation", timestamp: 0, metadata: {
  canonicalApproval: { runId: "run_fixture", approvalId: pending.challengeId, title: pending.title, description: pending.description,
    risk: "medium", allowedDecisions: ["approve", "decline", "cancel"], pending: true },
} };
function Fixture() {
  return <main style={{ maxWidth: "48rem", margin: "0 auto", padding: 16, display: "grid", gap: 24 }}>
    <p>Isolated UI fixture · no real approval or account</p>
    <div data-fixture="owner"><h2 className="mb-2 font-semibold">Owner browser</h2>
      <RoutineActionConfirmation client={client} challengeId={pending.challengeId} identity="fixture-owner"/></div>
    <div data-fixture="canonical"><h2 className="mb-2 font-semibold">Canonical Chat card</h2>
      <CanonicalApprovalMessage message={message} submitting={false}/></div>
    <div data-fixture="native"><h2 className="mb-2 font-semibold">Native browser handoff</h2>
      <RoutineActionConfirmation client={client} challengeId={pending.challengeId} identity="fixture-native" openConfirmation={async () => {}}/></div>
    <div data-fixture="settled"><h2 className="mb-2 font-semibold">Cancelled canonical card</h2>
      <CanonicalApprovalMessage message={{ ...message, metadata: { canonicalApproval: { ...message.metadata.canonicalApproval, pending: false, decision: "cancel" } } }} submitting={false}/></div>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
