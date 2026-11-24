import { expect, it, vi } from "vitest";
import { BotCreationSnapshotSchema } from "@matrix-os/contracts";
import { ChatAgentContext, chatContextRequestHash } from "../../../packages/gateway/src/chat/agent-context.js";
import { enqueueCanonicalQueuedTurn } from "../../../packages/gateway/src/chat/queue-admission.js";
import { admitCanonicalRetry } from "../../../packages/gateway/src/chat/retry-admission.js";
import type { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
const owner = { type: "personal" as const, ownerId: "owner_draft" };
const botCreation = BotCreationSnapshotSchema.parse({ sessionId: "creation_test", draftRevision: 0, seed: { kind: "scratch" }, draft: { name: "", description: "", instructions: "", selection: null } });
const input = { clientRequestId: "req_draft", baseRevision: 0, selection: { instanceId: "matrix_pi_default", model: "test" }, interactionMode: "default", permissionMode: "supervised", parts: [{ type: "text" as const, text: "Plan my day" }], botCreation };
function setup(overrides = {}) {
  const record = { chat: { id: "chat_draft", lifecycle: "active", collaboration: null }, ...overrides };
  const get = vi.fn(async () => record);
  const directBot = vi.fn(async (): Promise<string | null> => null);
  const context = new ChatAgentContext({ repository: { get } as unknown as ChatRepository, agents: { get: vi.fn() }, enabled: () => true, botChats: { directBot } });
  return { context, get, directBot };
}
it("binds the snapshot to an eligible owner Chat and hashes every draft revision", async () => {
  const { context } = setup();
  expect(await context.prepare(owner, "chat_draft", input)).toMatchObject({ context: { botCreation } });
  expect(chatContextRequestHash(input)).not.toBe(chatContextRequestHash({ ...input, botCreation: { ...botCreation, draftRevision: 1 } }));
  expect(chatContextRequestHash(input)).not.toBe(chatContextRequestHash({ ...input, botCreation: undefined }));
});
it("refuses organization/shared/project/direct Bot and Agent/drive references", async () => {
  for (const overrides of [{ projectId: "project_a" }, { chat: { lifecycle: "active", collaboration: { scopeId: "scope_a" } } }]) await expect(setup(overrides).context.prepare(owner, "chat_draft", input)).rejects.toThrow();
  const { context, directBot } = setup();
  await expect(context.prepare({ ...owner, type: "organization" }, "chat_draft", input)).rejects.toThrow();
  await expect(context.prepare(owner, "chat_draft", { ...input, selection: { ...input.selection, instanceId: "matrix_pi_anthropic_api" } })).rejects.toThrow();
  await expect(context.prepare(owner, "chat_draft", { ...input, parts: [{ type: "resource_reference", resource: { kind: "agent", id: "bot_aaaaaaaa", label: "Agent" } }] })).rejects.toThrow();
  directBot.mockResolvedValue("bot_aaaaaaaa"); await expect(context.prepare(owner, "chat_draft", input)).rejects.toThrow();
});
it("rejects unsupported queued and retry drafting instead of silently retaining a stale snapshot", async () => {
  const get = vi.fn();
  await expect(enqueueCanonicalQueuedTurn({ input, repository: { get } } as unknown as Parameters<typeof enqueueCanonicalQueuedTurn>[0])).rejects.toThrow(/new message/i);
  expect(get).not.toHaveBeenCalled();
  const context = { latestRun: { context: { botCreation } } };
  await expect(admitCanonicalRetry({ assertOpen() {}, assertPersonalExecutionAllowed: vi.fn(), reconcileActiveRuns: vi.fn(), repository: { findRetryAdmission: vi.fn(), getTurnRunContext: vi.fn(async () => context) }, hasStoppingExecution: () => false } as unknown as Parameters<typeof admitCanonicalRetry>[0], { userId: owner.ownerId, source: "jwt" }, owner, "chat_draft", "cturn_draft", { clientRequestId: "req_retry", baseRevision: 0 })).rejects.toThrow(/new message/i);
});
it("rejects a removed or shared private drafting Chat before dispatch on revalidation", async () => {
  const { context, get, directBot } = setup();
  const admitted = await context.prepare(owner, "chat_draft", input);
  directBot.mockResolvedValue("bot_aaaaaaaa");
  await expect(context.revalidate(owner, "chat_draft", admitted?.context)).rejects.toThrow();
  directBot.mockResolvedValue(null);
  get.mockResolvedValue({ chat: { id: "chat_draft", lifecycle: "archived", collaboration: null } });
  await expect(context.revalidate(owner, "chat_draft", admitted?.context)).rejects.toThrow();
});

it("grounds setup in listed recipe declarations before a model run can start", async () => {
  const { context } = setup();
  const seed = { kind: "recipe" as const, recipeId: "personal-daily-brief", version: "2026-09-27.1" };
  const draft = { ...botCreation, intent: "open" as const, seed };
  const admitted = await context.prepare(owner, "chat_draft", { ...input, botCreation: draft });
  expect(admitted?.context?.botCreation).toEqual(draft);
  const { createManagedPiSystemPrompt } = await import("../../../packages/gateway/src/chat/managed-pi-system-prompt.js");
  const prompt = await createManagedPiSystemPrompt()({ owner, context: admitted?.context });
  expect(prompt).toContain("ask_bot_setup_question");
  expect(prompt).toContain("google_calendar");
  expect(prompt).toContain("gmail");
  await expect(context.prepare(owner, "chat_draft", { ...input, botCreation: { ...draft, seed: { ...seed, version: "future" } } })).rejects.toThrow();
});
