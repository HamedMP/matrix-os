import { expect, it, vi } from "vitest";
import { saveAgentDraft, type AgentCreationAttempt } from "../../../packages/ui/src/chat-agents/save-agent-draft.js";
import { recoverCreatedAgent } from "../../../packages/ui/src/chat-agents/recover-created-custom-bot.js";
import { BotClientError } from "../../../packages/ui/src/chat-agents/bots/client.js";
import { AppError } from "../../../desktop/src/shared/app-error.js";
import { clientFixture, saved } from "../../desktop/chat-agents-fixture.js";
import type { BotClient } from "../../../packages/ui/src/chat-agents/bots/client.js";

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

it.each([503, 429, 409, "network"] as const)("retains the original managed request after a possibly committed %s followed by validation rejection", async status => {
  const base = clientFixture();
  const managed = { ...saved, selection: { instanceId: "matrix_pi_default", model: "sonnet" },
    recipeRef: { recipeId: "custom-coordinator", version: "1" } };
  const created = { agent: { id: managed.id, name: managed.name, avatarSeed: "a".repeat(32), revision: 1, status: "active" as const },
    chatId: "chat_retained01", operation: "replayed" as const };
  const createCustom = vi.fn().mockRejectedValueOnce(status === "network" ? new TypeError("lost response") : new BotClientError(status, "interrupted activation"))
    .mockRejectedValueOnce(new BotClientError(400, "source temporarily invalid")).mockResolvedValue(created);
  const client = { ...base, bots: { createCustom } as unknown as BotClient };
  const attempt: { current: AgentCreationAttempt | null } = { current: null };
  const original = { ...draft, selection: managed.selection };
  await expect(saveAgentDraft(client, attempt, original, "new")).rejects.toThrow();
  expect(attempt.current?.input.clientRequestId).toBe(original.requestId);
  await expect(saveAgentDraft(client, attempt, original, "new")).rejects.toThrow();
  expect(attempt.current?.input.clientRequestId).toBe(original.requestId);
  base.list.mockResolvedValue({ enabled: true, agents: [managed] });
  base.update.mockResolvedValue({ ...managed, name: "Edited after interrupted activation", revision: 2 });
  await saveAgentDraft(client, attempt, { ...original, name: "Edited after interrupted activation", requestId: "req_edited01" }, "new");
  expect(createCustom.mock.calls[1]).toEqual(createCustom.mock.calls[0]);
  expect(createCustom.mock.calls[2]).toEqual(createCustom.mock.calls[0]);
  expect(base.update).toHaveBeenCalledExactlyOnceWith(managed.id, expect.objectContaining({ name: "Edited after interrupted activation" }));
  expect(base.create).not.toHaveBeenCalled();
});

it("persists a restored original draft after an edited recovery had already saved a newer version", async () => {
  const client = clientFixture(), attempt: { current: AgentCreationAttempt | null } = { current: null };
  const openChat = vi.fn().mockRejectedValueOnce(new Error("First open failed"))
    .mockRejectedValueOnce(new Error("Second open failed")).mockResolvedValue(undefined);
  const saveAndOpen = async (current: typeof draft) => {
    const result = await saveAgentDraft(client, attempt, current, "new");
    await openChat("chat_same_saved_bot");
    return result;
  };
  let server = { ...saved };
  client.list.mockImplementation(async () => ({ enabled: true, agents: [server] }));
  client.update.mockImplementation(async (_id, input) => {
    server = { ...server, name: input.name ?? server.name, description: input.description ?? server.description,
      instructions: input.instructions ?? server.instructions, selection: input.selection ?? server.selection,
      revision: server.revision + 1 };
    return server;
  });
  await expect(saveAndOpen(draft)).rejects.toThrow("First open failed");
  await expect(saveAndOpen({ ...draft, name: "Saved B", requestId: "req_edited01" })).rejects.toThrow("Second open failed");
  expect(server.name).toBe("Saved B");
  const recovered = await saveAndOpen({ ...draft, requestId: "req_restored01" });
  expect(client.create).toHaveBeenCalledTimes(1);
  expect(client.update).toHaveBeenCalledTimes(2);
  expect(client.update).toHaveBeenLastCalledWith(saved.id, expect.objectContaining({ name: draft.name, baseRevision: 2 }));
  expect(server.name).toBe(draft.name);
  expect(recovered.saved).toEqual(server);
  expect(openChat).toHaveBeenCalledTimes(3);
  expect(attempt.current?.agent).toEqual(server);
});
