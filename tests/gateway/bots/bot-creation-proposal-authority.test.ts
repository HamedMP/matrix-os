import { expect, it } from "vitest";
import { BotCreationSnapshotSchema } from "@matrix-os/contracts";
import { assertBotDraftProposalAuthority } from "../../../packages/gateway/src/chat/activity-persistence.js";
const snapshot = BotCreationSnapshotSchema.parse({ sessionId: "creation_test", draftRevision: 3, seed: { kind: "scratch" }, draft: { name: "", description: "", instructions: "", selection: null } });
const run = { driverKind: "matrix_pi" as const, context: { version: 1 as const, requestHash: "a".repeat(64), chats: [], botCreation: snapshot } };
const event = { type: "bot.draft.proposed", proposalId: "proposal_test", sessionId: snapshot.sessionId, baseDraftRevision: 3, patch: { name: "Planner" } };
it("requires a genuine drafting run and exact admitted session/revision before canonical persistence", () => {
  expect(() => assertBotDraftProposalAuthority(run, event)).not.toThrow();
  for (const invalid of [{ ...run, driverKind: "codex" as const }, { ...run, context: undefined }, { ...run, context: { ...run.context, botCreation: undefined } }]) expect(() => assertBotDraftProposalAuthority(invalid, event)).toThrow();
  for (const invalid of [{ ...event, sessionId: "other_session" }, { ...event, baseDraftRevision: 4 }, { ...event, patch: { grants: [] } }]) expect(() => assertBotDraftProposalAuthority(run, invalid)).toThrow();
});
