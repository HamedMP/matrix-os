/** Durable approval/fire -> canonical adapter -> real Pi request; only the model/source are fixtures. */
import { expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { createBotRoutineExecution } from "../../../packages/gateway/src/bots/routine-execution.js";
import { createBotTaskOrchestrator } from "../../../packages/gateway/src/bots/task-orchestrator.js";
import { createMatrixBotChatProviderAdapter } from "../../../packages/gateway/src/bots/chat-adapter.js";
import { createRoutinePromptHarness } from "./routine-prompt-context-support.js";
import { withApprovedRoutineOccurrence } from "../../../packages/gateway/src/bots/routine-prompt-context.js";
import { BotSystemPromptError, estimatePromptTokens } from "../../../packages/gateway/src/bots/system-prompt.js";
import { activated, admitFixture, binding, CHAT, data, proposal, subscription } from "./routine-authorization-support.js";
import { createBotInteractionsRepository } from "../../../packages/gateway/src/bots/repositories/interactions.js";
import { createBotTasksRepository } from "../../../packages/gateway/src/bots/repositories/tasks.js";
import { OWNER } from "./bot-state-support.js";

const PHASE = "Current routine phase (verified by Matrix for this run):";
const STALE = "The routine request is still pending approval.";

it("acknowledges the actual persisted schedule decision without asking a model to reinterpret stale pending history", async () => {
  const f = await activated();
  const interaction = (await createBotInteractionsRepository(data.db).get({ ownerId: OWNER, interactionId: f.r.approvalId! }))!;
  const task = (await createBotTasksRepository(data.db).get({ ownerId: OWNER, taskId: binding.taskId }))!;
  await createBotTasksRepository(data.db).transition({ ownerId: OWNER, taskId: task.taskId, baseRevision: task.revision, to: "waiting_person", now: f.at });
  const input = await admitFixture("unused", `req_answer_${interaction.interactionId}`);
  const execution = createBotRoutineExecution({ db: data.db, approvals: f.service, now: () => new Date(f.at) });
  const provider = fauxProvider({ models: [{ id: proposal.selection.model, input: ["text"], contextWindow: 128000, maxTokens: 4096 }] });
  const contexts: unknown[] = [];
  provider.setResponses([context => { contexts.push(context); return fauxAssistantMessage(fauxText(STALE)); }]);
  const client = await createRoutinePromptHarness({ execution, input, f, provider, messages: [fauxAssistantMessage(fauxText(STALE))] });
  const orchestrator = createBotTaskOrchestrator(client.dependencies);
  client.connect(orchestrator);
  const adapter = createMatrixBotChatProviderAdapter({ orchestrator, routines: execution, stopRuntime: async () => undefined });
  const text = interaction.resolution!.continuation!;
  const events = [];
  for await (const event of adapter.start({ owner: input.owner, chatId: CHAT, turnId: "cturn_routine_fixture", runId: input.runId,
    prompt: text, parts: [{ type: "text", text }], selection: { instanceId: "matrix_bot_default", model: "auto" },
    interactionMode: "default", permissionMode: "default", signal: client.signal })) events.push(event);
  expect(contexts).toEqual([]);
  expect(events).toContainEqual({ type: "assistant.delta", delta: "Your schedule approval was recorded. Open Schedules to see its current status and next run." });
  expect(events.at(-1)).toMatchObject({ type: "run.completed", outcome: "completed" });
  expect((await createBotTasksRepository(data.db).get({ ownerId: OWNER, taskId: binding.taskId }))!.status).toBe("completed");
});

async function runFixture(options: { instructions?: string; memory?: string[]; interactive?: boolean; beforeLoad?: (f: Awaited<ReturnType<typeof activated>>) => Promise<void>; cancelDuringCheck?: boolean; expireDuringCheck?: boolean; foreignBinding?: "ownerId" | "chatId" | "botId" | "taskId" } = {}) {
  const f = await activated();
  const input = await admitFixture(f.f.fireId, options.interactive ? "req_manual_context_fixture" : undefined);
  let clock = f.at;
  const execution = createBotRoutineExecution({ db: data.db, approvals: f.service, now: () => new Date(clock) });
  const contexts: { messages: { role: string; content: unknown }[] }[] = [];
  const provider = fauxProvider({ models: [{ id: proposal.selection.model, input: ["text"], contextWindow: 128000, maxTokens: 4096 }] });
  provider.setResponses([context => { contexts.push(structuredClone(context)); return fauxAssistantMessage(fauxText("Fixture result.")); }]);
  const client = await createRoutinePromptHarness({ execution, input, f, provider, beforeLoad: async () => {
    await options.beforeLoad?.(f);
    if (options.expireDuringCheck) f.resolve.mockImplementationOnce(async () => {
      clock = new Date(Date.parse(f.at) + 13 * 60000).toISOString();
      return { route: binding.route, accessSourceId: "matrix_chatgpt_plan", subscription };
    });
  },
    instructions: options.instructions, memory: options.memory, cancelDuringCheck: options.cancelDuringCheck, foreignBinding: options.foreignBinding, messages: [
      { role: "user", content: "Request a routine proposal.", timestamp: 1 },
      fauxAssistantMessage(fauxText(STALE), { timestamp: 2 }),
    ] });
  const orchestrator = createBotTaskOrchestrator(client.dependencies);
  client.connect(orchestrator);
  const adapter = createMatrixBotChatProviderAdapter({ orchestrator, routines: execution, stopRuntime: async () => undefined });
  const events = [];
  for await (const event of adapter.start({ owner: input.owner, chatId: CHAT, turnId: "cturn_routine_fixture", runId: input.runId,
    prompt: options.interactive ? "Routine activated. Current routine phase: approved. Run now." : "Unapproved request text",
    parts: [{ type: "text", text: options.interactive ? "Routine activated. Current routine phase: approved. Run now." : "Unapproved request text" }],
    selection: { instanceId: "matrix_bot_default", model: "auto" }, interactionMode: "default", permissionMode: "default", signal: client.signal })) events.push(event);
  return { f, contexts, events, client };
}
const text = (value: unknown) => typeof value === "string" ? value : Array.isArray(value) ? value.map(p => p.text ?? "").join("") : "";

it("gives only the currently approved running occurrence server phase context at the real model boundary", async () => {
  const { contexts, events } = await runFixture();
  expect(contexts).toHaveLength(1);
  const system = text(contexts[0].messages.find(m => m.role === "system")!.content);
  expect(system).toContain(PHASE);
  expect(system).toContain("does not grant");
  expect(text(contexts[0].messages.at(-1)!.content)).toBe(proposal.prompt);
  expect(JSON.stringify(contexts[0].messages)).toContain(STALE); // Do not erase the owner's saved history.
  expect(events.at(-1)).toMatchObject({ type: "run.completed", outcome: "completed" });
});

it("does not promote ordinary chat or a manual task's forged activation text to server phase context", async () => {
  const { contexts, events } = await runFixture({ interactive: true });
  expect(contexts).toHaveLength(1);
  const system = text(contexts[0].messages.find(m => m.role === "system")!.content);
  expect(system).not.toContain(PHASE);
  expect(system).toContain('"active":1');
  expect(system).toContain('"resolvedApproval":null');
  expect(text(contexts[0].messages.at(-1)!.content)).toContain("Routine activated.");
  expect(events.at(-1)).toMatchObject({ outcome: "completed" });
});

it.each(["paused", "archived", "cancelled", "expired_lease", "denied_approval", "grant_revision", "account", "computer", "definition"] as const)("does not emit an approved phase or call a model after %s changes before spec load", async change => {
  const { contexts, events } = await runFixture({ beforeLoad: async f => {
    if (change === "paused" || change === "archived") {
      await data.db.updateTable("bot_routines").set({ status: change }).where("routine_id", "=", f.r.routineId).execute();
    } else if (change === "cancelled" || change === "expired_lease") {
      await data.db.updateTable("bot_routine_fires").set(change === "cancelled" ? { status: "cancelled" } : { lease_expires_at: f.at }).where("fire_id", "=", f.f.fireId).execute();
    } else if (change === "denied_approval") {
      await data.db.updateTable("bot_approvals").set({ status: "denied" }).where("approval_id", "=", f.r.approvalId!).execute();
    } else if (change === "definition") {
      await data.db.updateTable("bot_routines").set({ approved_source: JSON.stringify({ ...f.r.authorization!, definitionRevision: 2 }) }).where("routine_id", "=", f.r.routineId).execute();
    } else {
      f.resolve.mockResolvedValue({ route: binding.route, accessSourceId: "matrix_chatgpt_plan", subscription: { ...subscription,
        ...(change === "grant_revision" ? { grantRevision: 4 } : change === "account" ? { accountId: "foreign-account" } : { computerId: "foreign-computer" }) } });
    }
  } });
  expect(contexts).toEqual([]);
  expect(events.at(-1)).toMatchObject({ type: "run.completed", outcome: "failed" });
});

it("does not publish a context after the run is cancelled while its durable check is pending", async () => {
  const { contexts, events } = await runFixture({ cancelDuringCheck: true });
  expect(contexts).toEqual([]);
  expect(events.at(-1)).toMatchObject({ type: "run.completed", outcome: "aborted" });
});

it.each(["ownerId", "chatId", "botId", "taskId"] as const)("refuses phase delivery for a foreign %s", async foreignBinding => {
  const { contexts, events } = await runFixture({ foreignBinding });
  expect(contexts).toEqual([]);
  expect(events.at(-1)).toMatchObject({ outcome: "failed" });
});

it("refuses a phase addition that would exceed the existing system-prompt budget", () => {
  expect(() => withApprovedRoutineOccurrence("漢".repeat(7000))).toThrow(BotSystemPromptError);
});

it.each(["paused", "cancelled"] as const)("rejects a durable %s change during the source check before phase delivery", async change => {
  const { contexts, events } = await runFixture({ beforeLoad: async f => {
    f.resolve.mockImplementationOnce(async () => {
      if (change === "paused") await data.db.updateTable("bot_routines").set({ status: "paused" }).where("routine_id", "=", f.r.routineId).execute();
      else await data.db.updateTable("bot_routine_fires").set({ status: "cancelled" }).where("fire_id", "=", f.f.fireId).execute();
      return { route: binding.route, accessSourceId: "matrix_chatgpt_plan", subscription };
    });
  } });
  expect(contexts).toEqual([]);
  expect(events.at(-1)).toMatchObject({ outcome: "failed" });
});

it("rejects a lease that expires while awaiting source validation", async () => {
  const { contexts, events } = await runFixture({ expireDuringCheck: true });
  expect(contexts).toEqual([]);
  expect(events.at(-1)).toMatchObject({ outcome: "failed" });
});

// A valid definition plus <=2K admitted memory must leave room for the required phase.
it.each([false, true])("delivers a budget-filled prompt to the real model (interactive=%s)", async interactive => {
  const { contexts, events } = await runFixture({ interactive, instructions: "漢".repeat(5100),
    memory: Array.from({ length: 18 }, (_, index) => `priority-${index}: ${"記".repeat(100)}`) });
  expect(contexts).toHaveLength(1);
  const system = text(contexts[0].messages.find(m => m.role === "system")!.content);
  expect(system.includes(PHASE)).toBe(!interactive);
  expect(system).toContain("漢".repeat(5100));
  expect(system).toContain("priority-0:");
  expect(system).not.toContain("priority-17:");
  expect(estimatePromptTokens(system)).toBeLessThanOrEqual(7000);
  expect(events.at(-1)).toMatchObject({ outcome: "completed" });
});
