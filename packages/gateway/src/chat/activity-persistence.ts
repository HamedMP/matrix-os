import { botDraftPatchMatchesChoices, BotConnectionRequestedSchema, BotDraftProposalSchema, BotSavedSettingsPatchSchema, ChatAgentIdSchema, BotSetupQuestionSchema, type CanonicalChatRun } from "@matrix-os/contracts";
import { createHash, randomUUID } from "node:crypto";

/** Control replay and normal delivery use the same durable identity. */
export function activityPersistenceId(runId: string, event: Record<string, unknown>): string {
  let key: string | undefined;
  if ((event.type === "bot.draft.proposed" || event.type === "bot.setup.question" || event.type === "bot.connection.requested") && typeof event.proposalId === "string") key = `${event.type}\0${event.proposalId}`;
  else if (event.type === "agent.activity" && typeof event.activityId === "string") key = event.activityId;
  else if ((event.type === "approval.requested" || event.type === "approval.resolved") && typeof event.approvalId === "string") {
    key = `${event.type}\0${event.approvalId}`;
  } else if ((event.type === "input.requested" || event.type === "input.resolved") && typeof event.requestId === "string") key = `${event.type}\0${event.requestId}`;
  if (key === undefined) return `activity_${randomUUID().replaceAll("-", "")}`;
  return `activity_${createHash("sha256").update(`${runId}\0${key}`).digest("hex").slice(0, 32)}`;
}

/** Provider events are data, not authority to modify a renderer's draft. */
export function assertBotDraftProposalAuthority(run: Pick<CanonicalChatRun, "driverKind" | "context">, event: Record<string, unknown>): void {
  if (event.type !== "bot.draft.proposed" && event.type !== "bot.setup.question" && event.type !== "bot.connection.requested") return;
  const payload = { ...event };
  delete payload.type;
  if (event.type === "bot.connection.requested") {
    const request = BotConnectionRequestedSchema.parse(payload);
    if (run.driverKind === "matrix_bot" && !run.context?.botCreation && ChatAgentIdSchema.safeParse(request.sessionId).success
      && request.baseDraftRevision > 0) return;
    const setup = run.context?.botCreation;
    if (run.driverKind === "matrix_pi" && setup?.intent === "reply" && request.sessionId === setup.sessionId
      && request.baseDraftRevision === setup.draftRevision) return;
    throw new Error("Invalid Bot connection request provenance");
  }
  const proposal = event.type === "bot.setup.question" ? BotSetupQuestionSchema.parse(payload) : BotDraftProposalSchema.parse(payload);
  if (run.driverKind === "matrix_bot" && event.type === "bot.draft.proposed" && "patch" in proposal
    && !run.context?.botCreation && ChatAgentIdSchema.safeParse(proposal.sessionId).success
    && proposal.baseDraftRevision > 0 && BotSavedSettingsPatchSchema.safeParse(proposal.patch).success) return;
  const snapshot = run.context?.botCreation;
  if (run.driverKind !== "matrix_pi" || !snapshot || proposal.sessionId !== snapshot.sessionId
    || proposal.baseDraftRevision !== snapshot.draftRevision || ("patch" in proposal ? !botDraftPatchMatchesChoices(snapshot, proposal.patch) : !snapshot.intent)) throw new Error("Invalid Bot draft proposal provenance");
}
