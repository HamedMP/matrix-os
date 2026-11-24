import { expect, it } from "vitest";
import { BotCreationSnapshotSchema, projectChatBotCreationResponse, projectChatBotCreationFrame, chatBotCreationVersionUrl } from "@matrix-os/contracts";
import type { CanonicalChatTransportFrame } from "@matrix-os/contracts";
const snapshot = BotCreationSnapshotSchema.parse({ sessionId: "creation_wire", draftRevision: 0, seed: { kind: "scratch" }, draft: { name: "", description: "", instructions: "", selection: null } });
const proposal = { type: "bot.draft.proposed", proposalId: "proposal_wire", sessionId: snapshot.sessionId, baseDraftRevision: 0, patch: { name: "Planner" }, id: "activity_wire", chatId: "chat_wire", runId: "run_wire", occurredAt: "2026-10-14T00:00:00.000Z" };
const context = { version: 1, requestHash: "a".repeat(64), chats: [], botCreation: snapshot };
it("strips proposal and admitted draft context for released strict clients in every response position", () => {
  const detail = { runs: [{ context }], activities: [proposal], messages: [{ parts: [{ type: "text", text: "botCreation" }] }] };
  const value = projectChatBotCreationResponse(detail, "0");
  expect(value.activities).toEqual([]); expect(value.runs[0]?.context).not.toHaveProperty("botCreation");
  expect(value.messages).toEqual(detail.messages); expect(detail.runs[0]?.context).toHaveProperty("botCreation");
  for (const key of ["run", "queuedTurn"]) expect(projectChatBotCreationResponse({ [key]: { context } }, "0")[key]?.context).not.toHaveProperty("botCreation");
  expect(projectChatBotCreationResponse(detail, "1")).toEqual(detail);
});
it("projects live/replay content frames identically and current URL composition opts in", () => {
  const frame = { type: "chat.content", event: { cursor: 1 }, content: { runs: [{ context }], activities: [proposal] } } as unknown as CanonicalChatTransportFrame;
  expect(projectChatBotCreationFrame(frame, "0")).toMatchObject({ content: { activities: [], runs: [{ context: { chats: [] } }] } });
  expect(projectChatBotCreationFrame(frame, "0")).not.toHaveProperty("content.runs.0.context.botCreation");
  expect(projectChatBotCreationFrame(frame, "2")).toBe(frame);
  expect(chatBotCreationVersionUrl("/api/chats?limit=20")).toContain("&botCreationVersion=2");
});

it("keeps recipe context and structured setup questions on the opted-in wire only", () => {
  const recipeDraft = { ...snapshot, intent: "open", seed: { kind: "recipe", recipeId: "personal-daily-brief", version: "2026-09-27.1" } };
  expect(BotCreationSnapshotSchema.safeParse(recipeDraft).success).toBe(true);
  const event = { type: "bot.setup.question", question: "What should the brief cover?", suggestedReplies: ["Email", "Calendar"] };
  const detail = { runs: [{ context: { ...context, botCreation: recipeDraft } }], activities: [proposal, event] };
  expect(projectChatBotCreationResponse(detail, "2")).toBe(detail);
  for (const version of ["0", "1"] as const) {
    const result = projectChatBotCreationResponse(detail, version);
    expect(result.runs[0]?.context).not.toHaveProperty("botCreation");
    expect(result.activities).toEqual(version === "1" ? [proposal] : []);
  }
  expect(projectChatBotCreationResponse({ context: { ...context, botCreation: { ...snapshot, intent: "reply" } } }, "1").context.botCreation).toEqual(snapshot);
});
