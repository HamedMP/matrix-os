import { expect, it, vi, afterEach } from "vitest";
import { BotToolRequestSchema } from "@matrix-os/contracts";
import { createManagedPiOwnerTools } from "../../../packages/gateway/src/chat/managed-pi-owner-tools.js";
import { createBotGithubDeveloperTools } from "../../../packages/gateway/src/bots/github-developer-tools.js";
import type { BotRuntimeBinding, ManagedPiRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { createBotStateDatabase, insertChat, BOT, OWNER } from "./bot-state-support.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { createBotTasksRepository } from "../../../packages/gateway/src/bots/repositories/tasks.js";
import { createBotApprovalsRepository } from "../../../packages/gateway/src/bots/repositories/approvals.js";
import { createBotInteractionsRepository } from "../../../packages/gateway/src/bots/repositories/interactions.js";
import { createBotAccessHandlers } from "../../../packages/gateway/src/bots/access-handlers.js";
import { createBotStateTransactions } from "../../../packages/gateway/src/bots/events.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";

const managed = { kind: "managed_chat", ownerId: OWNER, chatId: "chat_github", runId: "run_github", runtimeHandle: `runtime_${"a".repeat(32)}`,
  executionGeneration: "1", capabilities: ["github.developer"], workspace: { kind: "chat_workspace" }, rootFingerprint: "a".repeat(64), requestClass: "interactive" } as ManagedPiRuntimeBinding;
let serial = 0;
const request = (args: object) => BotToolRequestSchema.parse({ capability: "github.developer", toolCallId: `github_${++serial}`, args }) as Extract<ReturnType<typeof BotToolRequestSchema.parse>, { capability: "github.developer" }>;
const clone = () => request({ action: "clone", path: "repo", repository: "owner/private-test" });
const signal = () => new AbortController().signal;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function service() { return { inspect: vi.fn(async () => ({ account: "owner" })), execute: vi.fn(async () => ({ account: "owner", head: "a".repeat(40) })) }; }

it("managed Chat waits for exact canonical approval before host execution and consumes its receipt once", async () => {
  const events: Array<Record<string, unknown>> = [];
  const ownerTools = createManagedPiOwnerTools({ githubDeveloper: true, authority: async () => ({ permissionMode: "full_access" }), signalFor: () => signal() });
  await ownerTools.open(managed, event => events.push(event));
  const host = service(); const tools = createBotGithubDeveloperTools({ service: host, transact: vi.fn(), authorizeManaged: ownerTools.authorizeGithub });
  const call = clone(); const pending = tools.prepare(managed, "/owned", call, signal());
  await vi.waitFor(() => expect(events[0]?.type).toBe("approval.requested"));
  expect(events[0]?.safeDescription).toContain("owner/private-test"); expect(host.execute).not.toHaveBeenCalled();
  await expect(ownerTools.submit({ owner: { type: "personal", ownerId: "other" }, chatId: managed.chatId, runId: managed.runId,
    approvalId: events[0]!.approvalId as string, decision: "approve", clientRequestId: "req_wrong" })).rejects.toThrow();
  await ownerTools.submit({ owner: { type: "personal", ownerId: OWNER }, chatId: managed.chatId, runId: managed.runId,
    approvalId: events[0]!.approvalId as string, decision: "approve", clientRequestId: "req_approve" });
  await pending;
  const revalidate = vi.fn(async () => undefined);
  await tools.dispatch(managed, "/owned", call, signal(), revalidate);
  expect(revalidate).toHaveBeenCalledOnce(); expect(host.execute).toHaveBeenCalledOnce();
  await expect(tools.dispatch(managed, "/owned", call, signal(), revalidate)).rejects.toMatchObject({ code: "denied" });
  ownerTools.closeRun(managed.runId);
});

it("denies supervised, group, background, ungranted, cancelled and changed-root requests without a host effect", async () => {
  const controller = new AbortController();
  const ownerTools = createManagedPiOwnerTools({ githubDeveloper: true, authority: async () => ({ permissionMode: "supervised" }), signalFor: () => controller.signal });
  await ownerTools.open(managed, () => undefined);
  const host = service(); const tools = createBotGithubDeveloperTools({ service: host, transact: vi.fn(), authorizeManaged: ownerTools.authorizeGithub });
  for (const binding of [managed, { ...managed, group: { scopeId: "shared" } }, { ...managed, requestClass: "background" }, { ...managed, capabilities: [] }] as ManagedPiRuntimeBinding[]) {
    await expect(tools.prepare(binding, "/owned", clone(), signal())).rejects.toThrow();
  }
  controller.abort();
  await expect(tools.prepare(managed, "/owned", request({ action: "status" }), signal())).rejects.toThrow();
  expect(host.execute).not.toHaveBeenCalled(); ownerTools.closeRun(managed.runId);

  const allowed = createBotGithubDeveloperTools({ service: host, transact: vi.fn(), authorizeManaged: async () => undefined });
  const call = request({ action: "status" }); await allowed.prepare(managed, "/owned", call, signal());
  await expect(allowed.dispatch({ ...managed, rootFingerprint: "b".repeat(64) }, "/owned", call, signal(), async () => undefined)).rejects.toMatchObject({ code: "denied" });
  expect(host.execute).not.toHaveBeenCalled();
});

it("recipe Bot persists exact action approval and requires a fresh approval when account or arguments change", async () => {
  const { db, destroy } = await createBotStateDatabase(); cleanup.push(destroy);
  await insertChat(db, managed.chatId);
  await createBotBindingsRepository(db).bindDirect({ ownerId: OWNER, botId: BOT, chatId: managed.chatId, now: new Date().toISOString() });
  const task = await createBotTasksRepository(db).create({ ownerId: OWNER, botId: BOT, chatId: managed.chatId, now: new Date().toISOString() });
  const binding = { ...managed, kind: undefined, botId: BOT, taskId: task.taskId } as unknown as BotRuntimeBinding;
  delete (binding as unknown as Record<string, unknown>).kind;
  const transact = createBotStateTransactions(new ChatRepository(db as never));
  const host = service(); const tools = createBotGithubDeveloperTools({ service: host, transact, authorizeManaged: async () => { throw new Error("Not Chat"); } });
  const first = clone();
  await expect(tools.prepare(binding, "/owned", first, signal())).rejects.toMatchObject({ code: "approval_required" });
  expect(host.execute).not.toHaveBeenCalled();
  const rows = await db.selectFrom("bot_approvals").selectAll().execute(); expect(rows).toHaveLength(1);
  const interaction = await createBotInteractionsRepository(db).get({ ownerId: OWNER, interactionId: rows[0]!.approval_id });
  const handlers = createBotAccessHandlers({ tools: { declaredEffects: async () => [] } });
  await transact(OWNER, tx => handlers.decideApproval(tx, interaction!, "approve"));
  // The ordinary continuation has a new run/tool-call ID, with the same task,
  // exact requested action, owner, root fingerprint and GitHub account.
  const next = { ...binding, runId: "run_github_continued" }; const repeated = clone();
  await tools.prepare(next, "/owned", repeated, signal());
  await tools.dispatch(next, "/owned", repeated, signal(), async () => undefined);
  expect(host.execute).toHaveBeenCalledOnce();
  expect((await createBotApprovalsRepository(db).get({ ownerId: OWNER, approvalId: rows[0]!.approval_id }))?.claimedAt).not.toBeNull();
  host.inspect.mockResolvedValue({ account: "different" });
  await expect(tools.prepare(next, "/owned", clone(), signal())).rejects.toMatchObject({ code: "approval_required" });
  expect(host.execute).toHaveBeenCalledOnce();
});
