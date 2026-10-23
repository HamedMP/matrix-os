import { expect, it } from "vitest";
import { saveAgentDraft, type AgentCreationAttempt } from "../../../packages/ui/src/chat-agents/save-agent-draft.js";
import { recoverCreatedAgent } from "../../../packages/ui/src/chat-agents/recover-created-custom-bot.js";
import { BotClientError } from "../../../packages/ui/src/chat-agents/bots/client.js";
import { AppError } from "../../../desktop/src/shared/app-error.js";
import { clientFixture, saved } from "../../desktop/chat-agents-fixture.js";

const draft = { name: saved.name, description: saved.description, instructions: saved.instructions, selection: saved.selection, requestId: "req_original01" };

it("replays an uncertain generic create by original request and edits only its returned identity", async () => {
  const client = clientFixture(), attempt: { current: AgentCreationAttempt | null } = { current: null };
  client.create.mockRejectedValueOnce(new Error("lost response"));
  await expect(saveAgentDraft(client, attempt, draft, "new")).rejects.toThrow("lost response");
  const original = client.create.mock.calls[0]![0];
  client.list.mockResolvedValue({ enabled: true, agents: [saved] });
  await saveAgentDraft(client, attempt, { ...draft, name: "Edited after timeout", requestId: "req_edited01" }, "new");
  expect(client.create.mock.calls[1]![0]).toEqual(original);
  expect(client.update).toHaveBeenCalledExactlyOnceWith(saved.id, expect.objectContaining({ name: "Edited after timeout", baseRevision: saved.revision }));
});

it("keeps conflicts uncertain but allows revised requests after definite validation rejection", async () => {
  const client = clientFixture(), attempt: { current: AgentCreationAttempt | null } = { current: null };
  client.create.mockRejectedValueOnce(new BotClientError(409, "conflict"));
  await expect(saveAgentDraft(client, attempt, draft, "new")).rejects.toThrow();
  expect(attempt.current?.input.clientRequestId).toBe(draft.requestId);
  attempt.current = null;
  client.create.mockRejectedValueOnce(new BotClientError(400, "invalid request"));
  await expect(saveAgentDraft(client, attempt, draft, "new")).rejects.toThrow();
  expect(attempt.current).toBeNull();
  await saveAgentDraft(client, attempt, { ...draft, name: "Corrected", requestId: "req_corrected01" }, "new");
  expect(client.create).toHaveBeenLastCalledWith(expect.objectContaining({ name: "Corrected", clientRequestId: "req_corrected01" }));
});

it("never patches from a recovery read that settles after its editor expires", async () => {
  const client = clientFixture(); let active = true;
  let resolve!: (value: { enabled: boolean; agents: typeof saved[] }) => void;
  client.list.mockImplementationOnce(() => new Promise(value => { resolve = value; }));
  const recovery = recoverCreatedAgent(client, saved.id, { ...draft, name: "Would patch" }, false, () => active);
  active = false; resolve({ enabled: true, agents: [saved] });
  await expect(recovery).rejects.toThrow("ended");
  expect(client.update).not.toHaveBeenCalled();
});

it("does not read or create from an already expired editor", async () => {
  const client = clientFixture(), attempt = { current: null };
  await expect(saveAgentDraft(client, attempt, draft, "new", () => false)).rejects.toThrow("unavailable");
  expect(client.create).not.toHaveBeenCalled(); expect(client.list).not.toHaveBeenCalled();
});

it("allows corrections after an explicit desktop AppError httpStatus rejection", async () => {
  const client = clientFixture(), attempt: { current: AgentCreationAttempt | null } = { current: null };
  client.create.mockRejectedValueOnce(new AppError("server", { httpStatus: 400 }));
  await expect(saveAgentDraft(client, attempt, draft, "new")).rejects.toThrow();
  expect(attempt.current).toBeNull();
  await saveAgentDraft(client, attempt, { ...draft, name: "Corrected", requestId: "req_corrected01" }, "new");
  expect(client.create).toHaveBeenLastCalledWith(expect.objectContaining({ name: "Corrected", clientRequestId: "req_corrected01" }));
});
