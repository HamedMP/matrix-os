import { expect, it, vi } from "vitest";
import { createCreationConversation, creationConversationSelection } from "../../../packages/ui/src/chat-agents/creation-conversation.js";
import type { CreationConversationClient } from "../../../packages/ui/src/chat-agents/creation-conversation.js";
import { createCanonicalProviderCatalogFixture } from "../../contracts/fixtures/canonical-chat.js";
import type { BotCreationSnapshot, CanonicalChatDetailResponse, CanonicalChatTurnAdmissionResponse } from "@matrix-os/contracts";

const now = "2026-10-14T00:00:00.000Z";
const selection = { instanceId: "matrix_pi_default", model: "matrix-model" };
const snapshot: BotCreationSnapshot = {
  sessionId: "creation_session", draftRevision: 3, seed: { kind: "scratch" },
  draft: { name: "", description: "", instructions: "", selection }
};
function fixture() {
  const detail: CanonicalChatDetailResponse = { record: { chat: { id: "chat_creation", ownerScope: { type: "personal", ownerId: "owner" }, title: "New agent", lifecycle: "active", attention: "none", revision: 0, messageCount: 0, createdAt: now, updatedAt: now } }, messages: [], turns: [], runs: [], activities: [] };
  const client = {
    create: vi.fn<CreationConversationClient["create"]>(async () => detail.record), detail: vi.fn<CreationConversationClient["detail"]>(async () => detail),
    admitTurn: vi.fn<CreationConversationClient["admitTurn"]>(async () => ({ record: detail.record, run: { id: "run_creation" } } as CanonicalChatTurnAdmissionResponse)), cancelRun: vi.fn<CreationConversationClient["cancelRun"]>(async () => { })
  };
  let current = true;
  const onProposal = vi.fn(() => true);
  const conversation = createCreationConversation({ client, sessionId: snapshot.sessionId, isCurrent: () => current, onProposal, onChange: vi.fn() });
  return { conversation, client, detail, onProposal, expire: () => { current = false; } };
}
it("uses the catalog's actual Matrix AI default without falling back to another provider", () => {
  const catalog = createCanonicalProviderCatalogFixture();
  expect(creationConversationSelection(catalog)).toBeNull();
  catalog.instances.push({ ...catalog.instances[0]!, id: selection.instanceId, driverKind: "matrix_pi", defaultSelection: selection, models: [{ ...catalog.instances[0]!.models[0]!, id: selection.model }] });
  expect(creationConversationSelection(catalog)).toEqual(selection);
  catalog.instances.at(-1)!.models[0]!.availability = "unavailable";
  expect(creationConversationSelection(catalog)).toBeNull();
});
it("sends a real canonical turn carrying the exact bounded draft without changing the saved Agent", async () => {
  const { conversation, client } = fixture();
  expect(await conversation.send("Help configure this Bot", snapshot, selection)).toBe(true);
  expect(client.admitTurn).toHaveBeenCalledWith("chat_creation", expect.objectContaining({ botCreation: snapshot, selection, permissionMode: "supervised", parts: [{ type: "text", text: "Help configure this Bot" }] }));
  expect(conversation.state().activeRunId).toBe("run_creation");
});
it("reuses the uncertain exact turn request on retry instead of duplicating model inference", async () => {
  const { conversation, client } = fixture();
  client.admitTurn.mockRejectedValueOnce(new Error("connection lost"));
  expect(await conversation.send("Configure", snapshot, selection)).toBe(false);
  expect(await conversation.send("Configure", snapshot, selection)).toBe(true);
  expect(client.create).toHaveBeenCalledTimes(1);
  expect(client.admitTurn.mock.calls[0]![1]).toEqual(client.admitTurn.mock.calls[1]![1]);
});
it("does not continue to paid turn admission after the creation session expires while Chat creation awaits", async () => {
  const { conversation, client, detail, expire } = fixture();
  let resolve!: (value: typeof detail.record) => void;
  client.create.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const sending = conversation.send("Configure", snapshot, selection);
  expire(); resolve(detail.record);
  expect(await sending).toBe(false); expect(client.admitTurn).not.toHaveBeenCalled();
});
it("applies only a genuine proposal for this admitted run/session once; prose is not configuration", async () => {
  const { conversation, detail, onProposal } = fixture();
  await conversation.send("Configure", snapshot, selection);
  detail.activities.push({
    id: "activity_creation", chatId: "chat_creation", runId: "run_creation", occurredAt: now,
    type: "bot.draft.proposed", proposalId: "proposal_creation", sessionId: snapshot.sessionId, baseDraftRevision: 3, patch: { name: "Proposed" }
  });
  await conversation.refresh(); await conversation.refresh();
  expect(onProposal).toHaveBeenCalledTimes(1);
  detail.activities.push({ ...detail.activities[0]!, id: "activity_other", runId: "run_other", proposalId: "proposal_other" } as typeof detail.activities[number]);
  await conversation.refresh(); expect(onProposal).toHaveBeenCalledTimes(1);
});
it("discards a late readback after owner expiry without applying a proposal", async () => {
  const { conversation, client, detail, onProposal, expire } = fixture();
  await conversation.send("Configure", snapshot, selection);
  let resolve!: (value: typeof detail) => void;
  client.detail.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const refreshing = conversation.refresh(); expire(); resolve(detail);
  await refreshing; expect(onProposal).not.toHaveBeenCalled();
});
it("keeps a shared or project-bound Chat result outside owner setup before model admission", async () => {
  const { conversation, client, detail } = fixture();
  client.create.mockResolvedValueOnce({ ...detail.record, projectId: "project_shared" });
  expect(await conversation.send("Configure", snapshot, selection)).toBe(false);
  expect(client.admitTurn).not.toHaveBeenCalled();
  expect(conversation.state().detail).toBeNull();
});

it("clears prior setup transcript and stops polling when the Chat becomes shared", async () => {
  const { conversation, client, detail, onProposal } = fixture();
  expect(await conversation.send("Configure", snapshot, selection)).toBe(true);
  await conversation.refresh();
  expect(conversation.state().detail).toEqual(detail);
  client.detail.mockResolvedValueOnce({
    ...detail, record: {
      ...detail.record, chat: {
        ...detail.record.chat,
        collaboration: { mode: "shared", membership: { role: "owner", memberCount: 2 } }
      }
    }
  });
  await conversation.refresh();
  expect(conversation.state()).toMatchObject({ detail: null, activeRunId: null, busy: false });
  expect(onProposal).not.toHaveBeenCalled();
});

it("admits a single opening Run and accepts suggested replies only for the completed Run and current draft", async () => {
  const { conversation, client, detail } = fixture();
  await Promise.all([conversation.open(snapshot, selection), conversation.open(snapshot, selection)]);
  expect(client.admitTurn).toHaveBeenCalledTimes(1);
  expect(client.admitTurn.mock.calls[0]![1].botCreation?.intent).toBe("open");
  const question = {
    id: "activity_question", chatId: detail.record.chat.id, runId: "run_creation", occurredAt: now,
    type: "bot.setup.question" as const, proposalId: "proposal_question", sessionId: snapshot.sessionId, baseDraftRevision: 3,
    question: "Which inbox should I help you organize?", suggestedReplies: ["My support inbox", "My own inbox"]
  };
  detail.activities.push(question);
  await conversation.refresh();
  expect(conversation.state().question).toBeNull();
  detail.runs.push({ id: "run_creation", status: "completed" } as typeof detail.runs[number]);
  detail.activities = [{ ...question, runId: "run_other" }, { ...question, sessionId: "other_session" }, { ...question, baseDraftRevision: 2 }];
  await conversation.refresh();
  expect(conversation.state().question).toBeNull();
  detail.activities.push(question);
  await conversation.refresh();
  expect(conversation.state().question).toMatchObject(question);
  expect(await conversation.replyToQuestion("My own inbox", { ...snapshot, draftRevision: 4 }, selection)).toBe(false);
  expect(await conversation.replyToQuestion("Invented answer", snapshot, selection)).toBe(false);
  expect(await conversation.replyToQuestion("My own inbox", snapshot, selection)).toBe(true);
  expect(client.admitTurn.mock.calls.at(-1)![1]).toMatchObject({ parts: [{ type: "text", text: "My own inbox" }], botCreation: { intent: "reply" } });
  expect(conversation.state().question).toBeNull();
});

it("keeps a failed opener visible to explicit retry without readmission on remount effects", async () => {
  const { conversation, client } = fixture();
  client.admitTurn.mockRejectedValueOnce(new Error("unavailable"));
  expect(await conversation.open(snapshot, selection)).toBe(false);
  await conversation.open(snapshot, selection);
  expect(client.admitTurn).toHaveBeenCalledTimes(1);
  expect(conversation.state().retryIntent).toBe("open");
  expect(await conversation.retry()).toBe(true);
  expect(client.admitTurn.mock.calls[0]![1]).toEqual(client.admitTurn.mock.calls[1]![1]);
});

it("lets the owner retry a failed suggested answer with the same request id", async () => {
  const { conversation, client, detail } = fixture();
  await conversation.open(snapshot, selection);
  detail.runs.push({ id: "run_creation", status: "completed" } as typeof detail.runs[number]);
  detail.activities.push({ id: "activity_retry", chatId: detail.record.chat.id, runId: "run_creation", occurredAt: now,
    type: "bot.setup.question", proposalId: "proposal_retry", sessionId: snapshot.sessionId, baseDraftRevision: 3,
    question: "Where should this appear?", suggestedReplies: ["In my private chat", "In a file"] });
  await conversation.refresh();
  client.admitTurn.mockRejectedValueOnce(new Error("interrupted"));
  expect(await conversation.replyToQuestion("In my private chat", snapshot, selection)).toBe(false);
  expect(conversation.state().retryIntent).toBe("reply");
  expect(await conversation.retry()).toBe(true);
  expect(client.admitTurn.mock.calls[1]![1]).toEqual(client.admitTurn.mock.calls[2]![1]);
});

it("clears an existing private transcript on a rejected owner admission", async () => {
  const { conversation, client, detail } = fixture();
  await conversation.send("First", snapshot, selection);
  detail.runs.push({ id: "run_creation", status: "completed" } as typeof detail.runs[number]);
  await conversation.refresh();
  client.admitTurn.mockRejectedValueOnce(Object.assign(new Error("forbidden"), { status: 403 }));
  await conversation.send("Change the instructions", snapshot, selection);
  expect(conversation.state()).toMatchObject({ accessLost: true, detail: null, questions: [], question: null });
});
