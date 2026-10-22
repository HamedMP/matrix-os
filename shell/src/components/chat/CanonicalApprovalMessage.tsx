import { BrowserPermissionCard, type BrowserPermissionClient } from "@matrix-os/ui";
import { browserCanonicalDecision, type BrowserPermissionChoice, type CanonicalChatApprovalView } from "@matrix-os/contracts";
import {
  CanonicalChatRunIdSchema,
  canonicalChatApprovalOutcome,
  supervisedToolApproval,
  type CanonicalChatApprovalDecision,
} from "@matrix-os/contracts";
import type { ChatMessage } from "@/lib/chat";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { SupervisedToolApprovalCard } from "@matrix-os/ui";

const APPROVAL_DECISIONS = new Set<CanonicalChatApprovalDecision>([
  "approve", "approve_for_session", "decline", "cancel",
]);

interface CanonicalApprovalView {
  runId: string;
  approvalId: string;
  title: string;
  description: string;
  risk: "low" | "medium" | "high";
  allowedDecisions: CanonicalChatApprovalDecision[];
  pending: boolean;
  decision?: CanonicalChatApprovalDecision;
  browserApproval?: CanonicalChatApprovalView["browserApproval"];
  browserGrant?: CanonicalChatApprovalView["browserGrant"];
  reason?: "expired";
}

export function canonicalApproval(message: ChatMessage): CanonicalApprovalView | null {
  const value = message.metadata?.canonicalApproval;
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<CanonicalApprovalView>;
  const runId = CanonicalChatRunIdSchema.safeParse(candidate.runId);
  if (!runId.success || typeof candidate.approvalId !== "string" || typeof candidate.title !== "string"
    || typeof candidate.description !== "string" || !["low", "medium", "high"].includes(candidate.risk ?? "")
    || !Array.isArray(candidate.allowedDecisions) || typeof candidate.pending !== "boolean") return null;
  const allowedDecisions = candidate.allowedDecisions.filter((decision): decision is CanonicalChatApprovalDecision =>
    typeof decision === "string" && APPROVAL_DECISIONS.has(decision as CanonicalChatApprovalDecision));
  if (allowedDecisions.length === 0) return null;
  const decision = candidate.decision && APPROVAL_DECISIONS.has(candidate.decision) ? candidate.decision : undefined;
  const reason = candidate.reason === "expired" ? candidate.reason : undefined;
  return {
    ...candidate, runId: runId.data, allowedDecisions, decision,
    ...(reason ? { reason } : {}),
  } as CanonicalApprovalView;
}

function approvalLabel(decision: CanonicalChatApprovalDecision): string {
  if (decision === "approve_for_session") return "Approve for session";
  return decision.charAt(0).toUpperCase() + decision.slice(1);
}

export function CanonicalApprovalMessage({
  message,
  chatId,
  submitting,
  permissionMode,
  onPermissionMode,
  onTryAgain,
  onSubmit,
  browserPermissions,
  onOpenPermissionMode,
}: {
  message: ChatMessage;
  chatId?: string;
  browserPermissions?: BrowserPermissionClient;
  onOpenPermissionMode?: () => void;
  submitting: boolean;
  permissionMode?: string;
  onPermissionMode?: (mode: "supervised" | "full_access") => void;
  onTryAgain?: (prompt: string) => void;
  onSubmit?: (runId: string, approvalId: string, decision: CanonicalChatApprovalDecision, browserChoice?: BrowserPermissionChoice) => Promise<void>;
}) {
  const [failed, setFailed] = useState<{ runId: string; approvalId: string } | null>(null);
  const approval = canonicalApproval(message);
  if (!approval) {
    return <div className="rounded-md bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">{message.content}</div>;
  }
  if (approval.browserApproval) return <BrowserPermissionCard chatId={chatId} approval={approval as CanonicalChatApprovalView} submitting={submitting} client={browserPermissions} onOpenPermissionMode={onOpenPermissionMode}
    onDecision={onSubmit ? choice => onSubmit(approval.runId, approval.approvalId, browserCanonicalDecision(choice), choice) : undefined}/>;
  async function submitGeneric(decision: CanonicalChatApprovalDecision) {
    if (!approval || !onSubmit) return;
    setFailed(null);
    try { await onSubmit(approval.runId, approval.approvalId, decision); }
    catch (error: unknown) {
      console.warn("[chat] Approval submission failed", error instanceof Error ? error.name : "UnknownError");
      setFailed({ runId: approval.runId, approvalId: approval.approvalId });
    }
  }
  const failureNotice = approval.pending && failed?.runId === approval.runId && failed.approvalId === approval.approvalId
    ? <p role="alert">Could not submit approval. Try again.</p> : null;
  const tool = supervisedToolApproval(approval);
  if (tool) {
    return (<>
      <SupervisedToolApprovalCard
        approval={tool}
        anchorId={`tool-approval-${approval.approvalId}`}
        submitting={submitting}
        permissionMode={permissionMode}
        onPermissionMode={onPermissionMode}
        onTryAgain={onTryAgain}
        onDecision={onSubmit ? (decision) => void submitGeneric(decision) : undefined}
      />
      {failureNotice}
    </>);
  }
  return (
    <div className="space-y-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs">
      <div>
        <p className="font-medium text-foreground">{approval.title}</p>
        <p className="whitespace-pre-wrap text-muted-foreground">{approval.description}</p>
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
              onClick={() => void submitGeneric(decision)}
            >
              {approvalLabel(decision)}
            </Button>
          ))}
        </div>
      ) : <p className="text-muted-foreground">{approval.pending ? "Approval unavailable" : canonicalChatApprovalOutcome(approval.decision)}</p>}
      {failureNotice}
    </div>
  );
}
