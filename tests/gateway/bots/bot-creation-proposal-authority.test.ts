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

it("accepts text-only proposals for an exact Bot identity from the direct Bot adapter", () => {
  const direct = { driverKind: "matrix_bot" as const };
  const change = { ...event, sessionId: "bot_meeting01", baseDraftRevision: 1 };
  expect(() => assertBotDraftProposalAuthority(direct, change)).not.toThrow();
  for (const bad of [{ ...change, baseDraftRevision: 0 }, { ...change, sessionId: "creation_test" },
    { ...change, patch: { recipe: null } }, { ...change, patch: { archived: true } }]) {
    expect(() => assertBotDraftProposalAuthority(direct, bad)).toThrow();
  }
  expect(() => assertBotDraftProposalAuthority(run, change)).toThrow();
});


it("accepts connection navigation only for the matching owner setup reply without arbitrary addresses", () => {
  const { patch: _unused, ...identity } = event;
  const action = { ...identity, type: "bot.connection.requested", resource: { kind: "integration", service: "linear" } };
  const reply = { ...run, context: { ...run.context, botCreation: { ...snapshot, intent: "reply" as const } } };
  expect(() => assertBotDraftProposalAuthority(reply, action)).not.toThrow();
  expect(() => assertBotDraftProposalAuthority(run, action)).toThrow();
  expect(() => assertBotDraftProposalAuthority({ ...reply, driverKind: "codex" }, action)).toThrow();
  expect(() => assertBotDraftProposalAuthority(reply, { ...action, sessionId: "other_creation" })).toThrow();
  expect(() => assertBotDraftProposalAuthority(reply, { ...action, resource: { kind: "integration", service: "linear", url: "https://external.invalid" } })).toThrow();
  expect(() => assertBotDraftProposalAuthority(reply, { ...action, resource: { kind: "mcp", name: "x".repeat(81) } })).toThrow();
  expect(() => assertBotDraftProposalAuthority(reply, { ...action, resource: { kind: "mcp", url: "https://external.invalid" } })).toThrow();
});
