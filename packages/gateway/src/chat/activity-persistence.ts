import { BotDraftProposalSchema, type CanonicalChatRun } from "@matrix-os/contracts";
import { createHash, randomUUID } from "node:crypto";

/** Control replay and normal delivery use the same durable identity. */
export function activityPersistenceId(runId: string, event: Record<string, unknown>): string {
  let key: string | undefined;
  if (event.type === "bot.draft.proposed" && typeof event.proposalId === "string") key = `bot.draft.proposed\0${event.proposalId}`;
  else if (event.type === "agent.activity" && typeof event.activityId === "string") key = event.activityId;
  else if ((event.type === "approval.requested" || event.type === "approval.resolved") && typeof event.approvalId === "string") {
    key = `${event.type}\0${event.approvalId}`;
  } else if ((event.type === "input.requested" || event.type === "input.resolved") && typeof event.requestId === "string") key = `${event.type}\0${event.requestId}`;
  if (key === undefined) return `activity_${randomUUID().replaceAll("-", "")}`;
  return `activity_${createHash("sha256").update(`${runId}\0${key}`).digest("hex").slice(0, 32)}`;
}

/** Provider events are data, not authority to modify a renderer's draft. */
export function assertBotDraftProposalAuthority(run: Pick<CanonicalChatRun, "driverKind" | "context">, event: Record<string, unknown>): void {
  if (event.type !== "bot.draft.proposed") return;
  const payload = { ...event };
  delete payload.type;
  const proposal = BotDraftProposalSchema.parse(payload);
  const snapshot = run.context?.botCreation;
  if (run.driverKind !== "matrix_pi" || !snapshot || proposal.sessionId !== snapshot.sessionId
    || proposal.baseDraftRevision !== snapshot.draftRevision) throw new Error("Invalid Bot draft proposal provenance");
}
