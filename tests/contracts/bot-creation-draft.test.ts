import { expect, it } from "vitest";
import { BotCreationSnapshotSchema, BotCreationDraftSchema, BotCreationDraftPatchSchema, CanonicalCreateChatTurnRequestSchema, BotToolRequestSchema } from "@matrix-os/contracts";

export const snapshot = { sessionId: "creation_test", draftRevision: 0, seed: { kind: "scratch" }, draft: { name: "", description: "", instructions: "", selection: null } };
it("accepts incomplete bounded drafts and lossless options, recipe removal and executor intent", () => {
  expect(BotCreationSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  const draft = { ...snapshot.draft, selection: { instanceId: "matrix_pi_default", model: "test", options: [{ id: "account", value: "exact" }] }, recipe: null, taskExecutor: { connectionId: "claude_code_tasks", model: null }, coordinatorInstanceId: "matrix_pi_default" };
  expect(BotCreationSnapshotSchema.parse({ ...snapshot, draft }).draft).toEqual(draft);
});
it("rejects unknown authority, schedules, oversized bytes and labeling elevation in model patches", () => {
  for (const extra of [{ ownerId: "other" }, { grants: [] }, { schedule: "daily" }, { recipeRef: { id: "x" } }]) {
    expect(BotCreationSnapshotSchema.safeParse({ ...snapshot, draft: { ...snapshot.draft, ...extra } }).success).toBe(false);
  }
  expect(BotCreationSnapshotSchema.safeParse({ ...snapshot, draft: { ...snapshot.draft, instructions: "😀".repeat(8_000) } }).success).toBe(false);
  expect(BotCreationDraftPatchSchema.safeParse({ recipe: { skills: [], integrations: [], output: "", jevInboxLabeling: true } }).success).toBe(false);
  expect(BotCreationSnapshotSchema.safeParse({ ...snapshot, draft: { ...snapshot.draft, recipe: { skills: [], integrations: [], output: "", jevInboxTriage: { ownerId: "other" } } } }).success).toBe(false);
  // Each text field is individually within its limit, but JSON escaping can exceed the envelope cap.
  const oversized = { ...snapshot, draft: { ...snapshot.draft, instructions: "\0".repeat(8_000),
    selection: { instanceId: "matrix_pi_default", model: "test", options: Array.from({ length: 32 }, (_, index) => ({ id: `opt${index}${"x".repeat(74)}`, value: "v".repeat(160) })) },
    recipe: { skills: Array.from({ length: 8 }, (_, index) => `skill${index}${"x".repeat(150)}`), integrations: Array.from({ length: 8 }, (_, index) => ({ service: `service${index}`, accountLabel: "\0".repeat(100) })), output: "\0".repeat(1_000) } } };
  expect(BotCreationDraftSchema.safeParse(oversized.draft).success).toBe(true);
  expect(BotCreationSnapshotSchema.safeParse(oversized).success).toBe(false);
  expect(BotCreationDraftPatchSchema.safeParse({}).success).toBe(false);
});
it("validates the real turn snapshot and strictly advertised broker patch", () => {
  const input = { clientRequestId: "req_create", baseRevision: 0, parts: [{ type: "text", text: "draft a planner" }], selection: { instanceId: "matrix_pi_default", model: "test" }, interactionMode: "default", permissionMode: "supervised", botCreation: snapshot };
  expect(CanonicalCreateChatTurnRequestSchema.parse(input).botCreation).toEqual(snapshot);
  expect(BotToolRequestSchema.parse({ toolCallId: "draft_tool", capability: "bot.creation.propose", args: { patch: { name: "Planner" } } }).capability).toBe("bot.creation.propose");
  expect(BotToolRequestSchema.safeParse({ toolCallId: "draft_tool", capability: "bot.creation.propose", args: { patch: { name: "Planner" }, ownerId: "other" } }).success).toBe(false);
});
