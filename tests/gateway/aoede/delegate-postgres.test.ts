import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PostgresDialect } from "kysely";
import { CanonicalProviderCatalogSchema, type AoedeServerMessage } from "@matrix-os/contracts";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { CanonicalChatOrchestrator } from "../../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry } from "../../../packages/gateway/src/chat/provider-adapter.js";
import { createCanonicalChatEventStream } from "../../../packages/gateway/src/chat/event-stream.js";
import { createAoedeRepository } from "../../../packages/gateway/src/aoede/repository.js";
import { createAoedeDelegation } from "../../../packages/gateway/src/aoede/delegate.js";
import type { AoedeDispatchContext } from "../../../packages/gateway/src/aoede/session.js";
import { createAppDb } from "../../../packages/gateway/src/app-db.js";
import { createAppRegistry } from "../../../packages/gateway/src/app-db-registry.js";
import { registerNativeAppStorage } from "../../../packages/gateway/src/native-app-storage.js";

const principal = { userId: "owner", source: "jwt" as const };
const owner = { type: "personal" as const, ownerId: "owner" };
const selection = { instanceId: "codex_default", model: "test-model" };
let catalogHook: (() => Promise<void>) | undefined;
const catalog = { getCatalog: async () => { await catalogHook?.(); return CanonicalProviderCatalogSchema.parse({
  revision: "test_catalog", drivers: [{ kind: "codex", displayName: "Codex", adapterVersion: "1.0.0", capabilityClass: "coding_agent" }],
  instances: [{ id: selection.instanceId, driverKind: "codex", displayName: "Codex", availability: "available",
    workspaceRequirement: "none", catalogRevision: "test_catalog", defaultSelection: selection,
    models: [{ id: selection.model, displayName: "Test", availability: "available", capabilities: ["tools"], supportsVision: false, supportsToolUse: true }],
    options: [], skills: [], commands: [], setupActions: [], supports: { rootChat: true, resume: false, cancellation: true,
      steering: "none", attachments: [], tools: [], approvals: true, userInput: false, worktrees: "none", resources: [],
      interactionModes: ["default"], permissionModes: ["supervised"] } }],
}); } };
let admin: Pool, repository: ChatRepository, sessions: ReturnType<typeof createAoedeRepository>;
let stream: ReturnType<typeof createCanonicalChatEventStream>, orchestrator: CanonicalChatOrchestrator;
let delegate: ReturnType<typeof createAoedeDelegation>, name: string;
let finish: () => void, frames: AoedeServerMessage[], speech: string[], ctx: AoedeDispatchContext;
let approvalRisk: "low" | "high" | undefined;
let secondApproval: boolean;
let approvalTitle: string;
let approved: "approve" | "decline" | undefined;
let storage: ReturnType<typeof createAppDb>;
let clock: number;
let composition: Parameters<typeof createAoedeDelegation>[0];

beforeEach(async () => {
  const url = process.env.MATRIX_TEST_POSTGRES_URL;
  if (!url || !new URL(url).pathname.includes("test")) throw new Error("Dedicated MATRIX_TEST_POSTGRES_URL required");
  admin = new Pool({ connectionString: url }); name = `aoede_test_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  const isolated = new URL(url); isolated.pathname = `/${name}`;
  storage = createAppDb(isolated.toString()); await storage.db.bootstrap();
  const registry = createAppRegistry(storage.db, storage.kysely); await registerNativeAppStorage(registry);
  repository = new ChatRepository(new PostgresDialect({ pool: new Pool({ connectionString: isolated.toString() }) }));
  await repository.bootstrap(); sessions = createAoedeRepository(repository.kysely, { ownerId: "owner", runtimeId: "runtime" });
  await sessions.bootstrap();
  approvalRisk = undefined; secondApproval = false; approvalTitle = "Read file";
  approved = undefined; catalogHook = undefined; clock = Date.now();
  const done = new Promise<void>(resolve => { finish = resolve; });
  orchestrator = new CanonicalChatOrchestrator({ repository, catalog, adapters: new CanonicalChatProviderRegistry([{
    driverKind: "codex", stateSchemaVersion: 1, parseState: value => value, serializeState: value => value,
    async submitApproval(input) {
      if (!input.platformApprovalProof) throw new Error("External permission bridge requires authenticated proof");
      approved = input.decision === "approve" ? "approve" : "decline"; finish();
    },
    async *start(input) {
      yield { type: "state.updated", state: { sessionId: "external-run" } };
      if (approvalRisk) yield { type: "approval.requested", approvalId: "appr_read", title: approvalTitle, risk: approvalRisk,
        allowedDecisions: ["approve", "decline"] };
      if (secondApproval) yield { type: "approval.requested", approvalId: "appr_other", title: "Read another file", risk: "low",
        allowedDecisions: ["approve", "decline"] };
      await Promise.race([done, new Promise<void>(resolve => input.signal.addEventListener("abort", () => resolve(), { once: true }))]);
      if (input.signal.aborted) return;
      if (approved) yield { type: "approval.resolved", approvalId: "appr_read", decision: approved };
      yield { type: "assistant.delta", delta: "Built the real timer. " + "🙂".repeat(200) };
      yield { type: "run.completed", outcome: "completed" }; },
  }]) });
  stream = createCanonicalChatEventStream({ repository, now: () => clock });
  composition = { ownerId: "owner", repository, orchestrator, eventStream: stream, catalog, sessionRepository: sessions,
    actions: { homePath: "/tmp", database: storage.kysely, registry, notifyDataChange: () => {} } };
  delegate = createAoedeDelegation(composition);
  const { record } = await sessions.reserve(randomUUID(), "fingerprint");
  await sessions.update(record.id, { state: "active" });
  const claim = (await sessions.claim(record.id, "delegation-one"))!;
  frames = []; speech = [];
  ctx = { principal, sessionId: record.id, delegationId: claim.delegation_id, requestId: claim.request_id,
    transcripts: [{ role: "user", text: "build a timer", offset: 1 }], signal: new AbortController().signal,
    append: async (kind, text) => {
      if (kind === "thinking" && text.includes("Chat")) expect((await sessions.delegations(record.id))[0].chat_id).not.toBeNull();
      speech.push(text);
    }, emit: frame => { frames.push(frame); },
    ui: async () => { throw new Error("Unexpected UI"); },
    record: result => sessions.delegationResult(record.id, claim.delegation_id, result) };
});
afterEach(async () => {
  finish?.(); await delegate?.shutdown(); await orchestrator?.drain(); stream?.shutdown(); await orchestrator?.close();
  vi.useRealTimers();
  await repository?.kysely.destroy(); await storage?.db.destroy();
  if (name) await admin.query(`DROP DATABASE "${name}"`); await admin?.end();
});

it("admits replay once as the real owner, persists mapping before status, and speaks only durable completion within 500 UTF8 bytes", async () => {
  await delegate.dispatch(ctx); await delegate.dispatch(ctx);
  const binding = (await sessions.delegations(ctx.sessionId))[0];
  const history = (await repository.exportChat(owner, binding.chat_id!))!;
  expect(history.chat.chat.title).toBe("Aoede");
  expect(history.turns).toHaveLength(1);
  expect(history.messages[0].actorId).toBe("owner");
  expect(history.runs[0].selection).toEqual(selection);
  expect(speech.some(s => s.includes("Built the real timer"))).toBe(false);
  expect(frames.some(f => f.type === "aoede:card" && f.card.runId === binding.run_id)).toBe(true);
  finish();
  await expect.poll(() => speech.some(s => s.includes("Built the real timer"))).toBe(true);
  expect(speech.every(s => Buffer.byteLength(s) <= 500)).toBe(true);
  expect(speech.filter(s => s.includes("Built the real timer"))).toHaveLength(1);
});

it("a busy voice turn queues canonically and cancellation removes that queue without cancelling unrelated work", async () => {
  await delegate.dispatch(ctx);
  const claim = (await sessions.claim(ctx.sessionId, "delegation-two"))!;
  const second = { ...ctx, delegationId: claim.delegation_id, requestId: claim.request_id,
    transcripts: [{ role: "user" as const, text: "build another timer", offset: 2 }],
    record: (result: any) => sessions.delegationResult(ctx.sessionId, claim.delegation_id, result) };
  await delegate.dispatch(second);
  const bindings = await sessions.delegations(ctx.sessionId), queued = bindings.find(b => b.queued_turn_id)!;
  expect((await repository.listQueuedTurns(owner, queued.chat_id!)).map(q => q.id)).toEqual([queued.queued_turn_id]);
  await delegate.onClientMessage(principal, "bound", { type: "aoede:cancel", sessionId: ctx.sessionId, cardId: claim.delegation_id });
  expect(await repository.listQueuedTurns(owner, queued.chat_id!)).toEqual([]);
  expect((await repository.exportChat(owner, queued.chat_id!))!.runs.find(r => r.id === bindings.find(b => b.run_id)!.run_id)!.status).toBe("running");
});

it("another owner cannot admit or cancel, and closing voice does not stop the canonical run", async () => {
  await expect(delegate.dispatch({ ...ctx, principal: { ...principal, userId: "intruder" } })).rejects.toThrow();
  expect((await repository.list(owner, { limit: 20 })).items).toHaveLength(0);
  await delegate.dispatch(ctx);
  const binding = (await sessions.delegations(ctx.sessionId))[0];
  await expect(delegate.onClientMessage({ ...principal, userId: "intruder" }, "bound", {
    type: "aoede:cancel", sessionId: ctx.sessionId, cardId: ctx.delegationId })).rejects.toThrow();
  await delegate.shutdown(); finish();
  await expect.poll(async () => (await repository.exportChat(owner, binding.chat_id!))?.runs[0].status).toBe("completed");
  expect(speech.some(s => s.includes("Built the real timer"))).toBe(false);
});

async function utterance(text: string) {
  const claim = (await sessions.claim(ctx.sessionId, randomUUID()))!;
  return { ...ctx, requestId: claim.request_id, delegationId: claim.delegation_id,
    transcripts: [{ role: "user" as const, text, offset: 2 }],
    record: (result: Parameters<AoedeDispatchContext["record"]>[0]) => sessions.delegationResult(ctx.sessionId, claim.delegation_id, result) };
}

it("sole presented low-risk yes requests shell HTTP only; a forged accepted result cannot claim an unrecorded approval", async () => {
  approvalRisk = "low";
  await delegate.dispatch(ctx);
  await expect.poll(() => speech.some(s => s.includes("Say exactly yes or no"))).toBe(true);
  const answer = await utterance("yes"); await delegate.dispatch(answer);
  const request = frames.find(f => f.type === "aoede:approval_decide")!;
  expect(request).toMatchObject({ decision: "approve_once", approvalId: "appr_read" });
  const binding = (await sessions.delegations(ctx.sessionId)).find(b => b.run_id)!;
  const frame = { type: "aoede:approval_result" as const, sessionId: ctx.sessionId, approvalId: "appr_read",
    clientRequestId: answer.requestId, accepted: true };
  await delegate.onClientMessage(principal, "bound", frame);
  expect(speech.some(s => s.includes("confirmed the approval"))).toBe(false);
  expect((await repository.exportChat(owner, binding.chat_id!))!.runs[0].status).toBe("waiting_for_approval");
  await expect(orchestrator.submitApproval(owner, binding.chat_id!, binding.run_id!, "appr_read", {
    clientRequestId: "req_missing_proof", decision: "approve" })).rejects.toThrow();
  expect((await repository.exportChat(owner, binding.chat_id!))!.activities.some(a => a.type === "approval.resolved")).toBe(false);
  // Simulates the authenticated shell's canonical decision, not voice submission.
  await orchestrator.submitApproval(owner, binding.chat_id!, binding.run_id!, "appr_read", {
    clientRequestId: `req_shell_${answer.requestId}`, decision: "approve" }, { platformApprovalProof: "external-provider-test-proof" });
  await expect.poll(async () => (await repository.exportChat(owner, binding.chat_id!))!.activities.some(a => a.type === "approval.resolved")).toBe(true);
  await delegate.onClientMessage(principal, "bound", frame);
  expect(speech.filter(s => s.includes("confirmed the approval"))).toHaveLength(1);
  await delegate.onClientMessage(principal, "bound", frame);
  expect(speech.filter(s => s.includes("confirmed the approval"))).toHaveLength(1);
});

it.each(["yes please", "yes and delete it", "no, maybe", "approve everything"])("ambiguous utterance %s never grants permission", async text => {
  approvalRisk = "low"; await delegate.dispatch(ctx);
  await expect.poll(() => speech.some(s => s.includes("Say exactly yes or no"))).toBe(true);
  await delegate.dispatch(await utterance(text));
  expect(frames.filter(f => f.type === "aoede:approval_decide")).toEqual([]);
  const binding = (await sessions.delegations(ctx.sessionId)).find(b => b.run_id)!;
  expect((await repository.exportChat(owner, binding.chat_id!))!.activities.some(a => a.type === "approval.resolved")).toBe(false);
});

it("a high-risk approval requires a click even for exact yes", async () => {
  approvalRisk = "high"; await delegate.dispatch(ctx);
  await expect.poll(() => speech.some(s => s.includes("click to review"))).toBe(true);
  await delegate.dispatch(await utterance("yes"));
  expect(frames.filter(f => f.type === "aoede:approval_decide")).toEqual([]);
});

it("uncertain terminal delivery is never retried on later canonical events", async () => {
  let attempts = 0;
  ctx.append = async (_, text) => { if (text.includes("Built the real timer")) { attempts++; throw new Error("Unknown send outcome"); } };
  await delegate.dispatch(ctx); finish();
  await expect.poll(() => attempts).toBe(1);
  const binding = (await sessions.delegations(ctx.sessionId))[0];
  await repository.appendOutboxEvent(owner, binding.chat_id!, 1, "chat.updated", {});
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(attempts).toBe(1);
});

it("an uncertain approval question is not replayed and does not authorize a later yes", async () => {
  approvalRisk = "low"; let attempts = 0;
  ctx.append = async (_, text) => { if (text.includes("Say exactly yes or no")) { attempts++; throw new Error("Unknown question outcome"); } };
  await delegate.dispatch(ctx);
  await expect.poll(() => attempts).toBe(1);
  await delegate.dispatch(await utterance("yes"));
  expect(frames.filter(f => f.type === "aoede:approval_decide")).toEqual([]);
  expect(attempts).toBe(1);
});

it("UI results validated by the session retain the action's correlation without claiming an uninstalled window effect", async () => {
  let opened: string | undefined;
  const admit = vi.spyOn(orchestrator, "admitTurn");
  ctx.ui = async (phase, _, target) => {
    if (phase === "execute") opened = target;
    return { type: "aoede:ui_result", sessionId: ctx.sessionId, correlationId: randomUUID(), phase, status: "ok", slug: "notes" };
  };
  await delegate.dispatch({ ...ctx, transcripts: [{ role: "user", text: "Can you open notes", offset: 1 }] });
  expect(opened).toBe("notes"); expect(speech).toContain("Notes opened.");
  await delegate.dispatch(await utterance("Can you list my apps"));
  expect(speech.at(-1)).toBe("Installed apps: Notes.");
  const other = await utterance("open missing");
  other.ui = async phase => ({ type: "aoede:ui_result", sessionId: ctx.sessionId, correlationId: randomUUID(), phase, status: "ok", slug: "missing" });
  await delegate.dispatch(other);
  expect(speech.at(-1)).toBe("App is not installed.");
  expect(admit).not.toHaveBeenCalled();
  expect((await repository.list(owner, { limit: 20 })).items).toEqual([]);
});

it("one concurrent Chat revision change retries admission without duplicating the owner's turn", async () => {
  catalogHook = async () => {
    const chat = (await repository.list(owner, { limit: 20 })).items[0];
    if (!chat) return;
    catalogHook = undefined;
    await repository.update(owner, chat.chat.id, { baseRevision: chat.chat.revision, title: "Aoede" });
  };
  await delegate.dispatch(ctx);
  const binding = (await sessions.delegations(ctx.sessionId))[0];
  const history = (await repository.exportChat(owner, binding.chat_id!))!;
  expect(history.turns).toHaveLength(1); expect(history.turns[0].clientRequestId).toBe(`req_aoede_${ctx.requestId}`);
  expect(history.messages[0].actorId).toBe("owner");
});

it("a long silent run survives subscription TTL through touch and a replay gap reloads completion without rerunning", async () => {
  await delegate.shutdown(); vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  delegate = createAoedeDelegation(composition); await delegate.dispatch(ctx);
  clock += 240_000; await vi.advanceTimersByTimeAsync(30_000);
  clock += 120_000; stream.evictStaleSubscribers();
  expect(stream.activeSubscriberCount()).toBe(1); // Actual bounded resource, not a mocked call count.
  const binding = (await sessions.delegations(ctx.sessionId))[0];
  clock += 360_000; stream.evictStaleSubscribers();
  finish();
  await expect.poll(async () => (await repository.exportChat(owner, binding.chat_id!))!.runs[0].status).toBe("completed");
  await repository.pruneOutbox(owner, Number.MAX_SAFE_INTEGER);
  await vi.advanceTimersByTimeAsync(30_000);
  await expect.poll(() => speech.some(s => s.includes("Built the real timer"))).toBe(true);
  expect((await repository.exportChat(owner, binding.chat_id!))!.turns).toHaveLength(1);
  expect(speech.filter(s => s.includes("Built the real timer"))).toHaveLength(1);
});

it("exact stop cancels the mapped canonical run, not merely speech playback", async () => {
  await delegate.dispatch(ctx);
  await delegate.dispatch(await utterance("stop"));
  const binding = (await sessions.delegations(ctx.sessionId)).find(b => b.run_id)!;
  expect((await repository.exportChat(owner, binding.chat_id!))!.runs[0].status).toBe("aborted");
  expect(frames.some(f => f.type === "aoede:card" && f.card.status === "cancelled")).toBe(true);
});

it("fresh-session recovery restores the actual terminal card without rerunning completed work", async () => {
  await delegate.dispatch(ctx); finish();
  await expect.poll(() => speech.some(s => s.includes("Built the real timer"))).toBe(true);
  const oldId = ctx.sessionId;
  const reserved = await sessions.reserve(randomUUID(), "fresh"); await sessions.update(reserved.record.id, { state: "active" });
  frames = []; speech = [];
  await delegate.seedRecentOutcomes({ ...ctx, sessionId: reserved.record.id }, oldId);
  expect(frames.some(f => f.type === "aoede:card" && f.sessionId === reserved.record.id && f.card.status === "done")).toBe(true);
  const binding = (await sessions.delegations(oldId))[0];
  expect((await repository.exportChat(owner, binding.chat_id!))!.turns).toHaveLength(1);
  expect(speech.some(s => s.includes("Built the real timer"))).toBe(false);
});

it("two current approvals cannot be resolved by exact yes", async () => {
  approvalRisk = "low"; secondApproval = true; await delegate.dispatch(ctx);
  const binding = (await sessions.delegations(ctx.sessionId))[0];
  await expect.poll(async () => (await repository.exportChat(owner, binding.chat_id!))!.activities.filter(a => a.type === "approval.requested").length).toBe(2);
  await delegate.dispatch(await utterance("yes"));
  expect(frames.filter(f => f.type === "aoede:approval_decide")).toEqual([]);
  expect((await repository.exportChat(owner, binding.chat_id!))!.activities.some(a => a.type === "approval.resolved")).toBe(false);
});

it("yes arriving before question acknowledgement does not gain authority from the question it triggers", async () => {
  approvalRisk = "low";
  let release!: () => void, pendingQuestion = false;
  const acknowledgement = new Promise<void>(resolve => { release = resolve; });
  ctx.append = async (_, text) => { if (text.includes("Say exactly yes or no")) { pendingQuestion = true; await acknowledgement; } };
  const dispatch = delegate.dispatch(ctx);
  try {
    await expect.poll(() => pendingQuestion).toBe(true);
    await delegate.dispatch(await utterance("yes"));
    expect(frames.filter(f => f.type === "aoede:approval_decide")).toEqual([]);
  } finally { release(); await dispatch; }
});

it("a low-risk question whose complete details exceed the speech byte bound requires a click, not truncated voice consent", async () => {
  approvalRisk = "low"; approvalTitle = "Read " + "読".repeat(150);
  await delegate.dispatch(ctx);
  await expect.poll(() => speech.some(s => s.includes("click to review"))).toBe(true);
  await delegate.dispatch(await utterance("yes"));
  expect(frames.filter(f => f.type === "aoede:approval_decide")).toEqual([]);
});

it("follow-up delegation carries bounded recent conversation as user input, never as synthetic assistant authority", async () => {
  ctx.transcripts = [{ role: "user", text: "Build a garden planner", offset: 1 },
    { role: "assistant", text: "Which theme?", offset: 2 }, { role: "user", text: "Use dark green", offset: 3 }];
  await delegate.dispatch(ctx);
  const binding = (await sessions.delegations(ctx.sessionId))[0];
  const history = (await repository.exportChat(owner, binding.chat_id!))!;
  const text = history.messages[0].parts.flatMap(p => p.type === "text" ? [p.text] : []).join(" ");
  expect(text).toContain("Build a garden planner"); expect(text).toContain("Which theme?"); expect(text).toContain("Use dark green");
  expect(history.messages[0]).toMatchObject({ role: "user", actorId: "owner" });
  expect(text.length).toBeLessThan(17_000);
});

it("durable supersession fences old voice delivery even before its process receives an abort", async () => {
  await delegate.dispatch(ctx);
  await sessions.reserve(randomUUID(), "new-invocation");
  finish();
  const binding = (await sessions.delegations(ctx.sessionId))[0];
  await expect.poll(async () => (await repository.exportChat(owner, binding.chat_id!))!.runs[0].status).toBe("completed");
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(speech.some(s => s.includes("Built the real timer"))).toBe(false);
  expect(frames.some(f => f.type === "aoede:card" && f.card.status === "done")).toBe(false);
});
