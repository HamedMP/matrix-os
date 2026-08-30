import type { CanonicalChatApprovalDecision } from "@matrix-os/contracts";
import type { ChatMessage } from "@/lib/chat";
import { Button } from "@/components/ui/button";

const APPROVAL_DECISIONS = new Set<CanonicalChatApprovalDecision>([
  "approve", "approve_for_session", "decline", "cancel",
]);

interface CanonicalApprovalView {
  approvalId: string;
  title: string;
  description: string;
  risk: "low" | "medium" | "high";
  allowedDecisions: CanonicalChatApprovalDecision[];
  pending: boolean;
}

export function canonicalApproval(message: ChatMessage): CanonicalApprovalView | null {
  const value = message.metadata?.canonicalApproval;
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<CanonicalApprovalView>;
  if (typeof candidate.approvalId !== "string" || typeof candidate.title !== "string"
    || typeof candidate.description !== "string" || !["low", "medium", "high"].includes(candidate.risk ?? "")
    || !Array.isArray(candidate.allowedDecisions) || typeof candidate.pending !== "boolean") return null;
  const allowedDecisions = candidate.allowedDecisions.filter((decision): decision is CanonicalChatApprovalDecision =>
    typeof decision === "string" && APPROVAL_DECISIONS.has(decision as CanonicalChatApprovalDecision));
  if (allowedDecisions.length === 0) return null;
  return { ...candidate, allowedDecisions } as CanonicalApprovalView;
}

function approvalLabel(decision: CanonicalChatApprovalDecision): string {
  if (decision === "approve_for_session") return "Approve for session";
  return decision.charAt(0).toUpperCase() + decision.slice(1);
}

export function CanonicalApprovalMessage({
  message,
  submitting,
  onSubmit,
}: {
  message: ChatMessage;
  submitting: boolean;
  onSubmit?: (approvalId: string, decision: CanonicalChatApprovalDecision) => Promise<void>;
}) {
  const approval = canonicalApproval(message);
  if (!approval) {
    return <div className="rounded-md bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">{message.content}</div>;
  }
  return (
    <div className="space-y-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs">
      <div>
        <p className="font-medium text-foreground">{approval.title}</p>
        <p className="text-muted-foreground">{approval.description}</p>
      </div>
      {approval.pending && onSubmit ? (
        <div className="flex flex-wrap gap-2">
          {approval.allowedDecisions.map((decision) => (
            <Button
              key={decision}
              type="button"
              size="sm"
              variant={decision === "approve" || decision === "approve_for_session" ? "default" : "outline"}
              disabled={submitting}
              onClick={() => void onSubmit(approval.approvalId, decision)}
            >
              {approvalLabel(decision)}
            </Button>
          ))}
        </div>
      ) : <p className="text-muted-foreground">{approval.pending ? "Approval unavailable" : "Resolved"}</p>}
    </div>
  );
}
