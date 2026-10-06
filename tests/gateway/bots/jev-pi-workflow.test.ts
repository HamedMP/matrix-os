import { expect, it, vi } from "vitest";
import { EMAIL_TRIAGE_LABELS, JEV_EMAIL_TRIAGE_ANSWER_IDS } from "@matrix-os/contracts";
import { createBotTools } from "../../../packages/bot-runtime/src/tools.js";
import { createBotJevTools } from "../../../packages/gateway/src/bots/jev-tools.js";
import { createBotBrokerActions } from "../../../packages/gateway/src/bots/broker-actions.js";
import { BotRuntimeRegistry } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { createBotTasksRepository } from "../../../packages/gateway/src/bots/repositories/tasks.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { createBotSessionsRepository } from "../../../packages/gateway/src/bots/repositories/sessions.js";
import { createBotCheckpointsRepository } from "../../../packages/gateway/src/bots/repositories/checkpoints.js";
import { createBotToolDispatcher } from "../../../packages/gateway/src/bots/tool-dispatcher.js";
import { createBotRecipeCatalog } from "../../../packages/gateway/src/bots/recipe-catalog.js";
import { createBotGrantsRepository } from "../../../packages/gateway/src/bots/repositories/grants.js";
import type { BotRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import type { BatchDocument, JevInboxBatchStore } from "../../../packages/gateway/src/jev/inbox-batch-store.js";
import { BOT, OWNER, createBotStateDatabase, insertChat } from "./bot-state-support.js";

it.each(["success", "revoke", "uncertain"])("Pi worker Jev workflow preserves checkpoint certainty (%s)", async mode => {
  const { db, destroy } = await createBotStateDatabase();
  const run = new AbortController();
  let tools: ReturnType<typeof createBotJevTools> | undefined;
  try {
    const observedTime = Date.now();
    const now = new Date(observedTime).toISOString();
    const savedGrant = await createBotGrantsRepository(db).grant({ ownerId: OWNER, botId: BOT, service: "gmail", connectionId: "conn_pi", accountLabel: "Work",
      effects: ["read", "label"], audience: "direct", grantedByActorId: OWNER, now });
    const recipes = createBotRecipeCatalog();
    const recipe = recipes.list().find(recipe => recipe.recipeId === "jev-inbox-triage")!;
    await insertChat(db, "chat_pi_jev");
    await createBotBindingsRepository(db).bindDirect({ ownerId: OWNER, botId: BOT, chatId: "chat_pi_jev", now });
    const task = await createBotTasksRepository(db).create({ ownerId: OWNER, botId: BOT, chatId: "chat_pi_jev", now });
    const binding: BotRuntimeBinding = { ownerId: OWNER, botId: BOT, runId: "run_pi_jev", capabilities: recipe.capabilities,
      runtimeHandle: "runtime_" + "a".repeat(32), executionGeneration: "1", chatId: "chat_pi_jev", taskId: task.taskId,
      rootFingerprint: "f".repeat(64), route: { api: "anthropic-messages", modelId: "claude-sonnet-5", input: ["text"], contextWindow: 200000, maxOutputTokens: 8192 },
      accessSourceId: "matrix_included", requestClass: "interactive" };
    const registry = new BotRuntimeRegistry(); registry.bind(binding);
    const mail = new Map(["thread1", "thread2"].map(id => [id, ["INBOX", "ExistingLabel"]]));
    const read = vi.fn(async (_owner, _scope, action, params) => {
      if (action === "get_profile") return { emailAddress: "work@example.test" };
      if (action === "list_threads") return params?.pageToken ? { threads: [{ id: "thread2" }] } : { threads: [{ id: "thread1" }], nextPageToken: "page2" };
      if (action === "get_thread_ids") return { id: params.threadId, historyId: "h1", messages: [{ id: params.threadId + "msg", internalDate: String(observedTime) }] };
      if (action === "get_message") return { id: params.messageId, threadId: params.messageId.replace("msg", ""), internalDate: String(observedTime),
        labelIds: mail.get(params.messageId.replace("msg", "")), payload: { mimeType: "text/plain", body: { data: Buffer.from("Weekly product newsletter").toString("base64url") } } };
      throw new Error("Unexpected read");
    });
    const evaluate = vi.fn(async () => ({ requestId: "jev_req_pi_fixture", recipe: "email-triage-v1" as const, model: "typesafe/jev" as const, latencyMs: 1,
      answers: JEV_EMAIL_TRIAGE_ANSWER_IDS.map(id => ({ id, type: "boolean" as const, probability: id === "newsletter" ? .96 : .1 })) }));
    const label = vi.fn(async (_owner, _scope, input, _signal, authorize) => {
      await authorize();
      const existing = mail.get(input.threadId)!;
      mail.set(input.threadId, [...existing, ...input.labels.filter(value => !existing.includes(value))]);
      if (mode === "revoke") await createBotGrantsRepository(db).revoke({ ownerId: OWNER, grantId: savedGrant.grant.grantId, now });
      if (mode === "uncertain" && input.threadId === "thread1") throw new Error("Lost external acknowledgment");
      return { confirmed: true, messageIds: input.messageIds, labelIds: ["Label_Newsletter"] };
    });
    let document: BatchDocument | null = null;
    const batchStore: JevInboxBatchStore = {
      async get() { return document ? structuredClone(document) : null; },
      async open(value) { document = structuredClone(value); return structuredClone(document); },
      async save(value, revision) { if (document?.revision !== revision) throw new Error("Revision conflict"); document = structuredClone(value); return structuredClone(document); },
    };
    tools = createBotJevTools({ agents: { get: async () => ({ id: BOT, revision: 1, recipeRef: { recipeId: recipe.recipeId, version: recipe.version } }) as never }, recipes,
      listGrants: (ownerId, botId) => createBotGrantsRepository(db).listLive({ ownerId, botId, audience: "direct", now }), signalFor: candidate => registry.inferenceSignal(candidate) ?? undefined,
      workflow: { read, evaluate, label, batchStore, fundedReady: async () => true,
        listGmailAccounts: async () => [{ id: "conn_pi", service: "gmail", account_label: "Work", account_email: "work@example.test", status: "active" }] } });
    const dispatcher = createBotToolDispatcher({ homePath: "/unused", jev: tools });
    const actions = createBotBrokerActions({ db, registry, sessions: createBotSessionsRepository(db), checkpoints: createBotCheckpointsRepository(db),
      runs: { loadRunSpec: async () => { throw new Error("Not requested"); }, readImageChunk: async () => { throw new Error("Not requested"); } },
      events: { publish: async () => undefined }, tools: dispatcher,
      inference: { homePath: "/unused", lifetime: run.signal, resolveCodexIdentity: async () => { throw new Error("No Codex or Hermes requested"); } },
    });
    const broker = { tool: async request => {
      const reply = await actions.handleFrame({ version: 1, requestId: "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1",
        runtimeHandle: binding.runtimeHandle, executionGeneration: "1", runId: binding.runId, action: "bot.tool", tool: request });
      return reply!.ok ? reply!.result : { ok: false, code: reply!.code };
    } };
    const worker = createBotTools({ capabilities: recipe.capabilities, broker: broker as never, state: { waitingForPerson: false, effectUnknown: false } });
    const tool = worker.find(tool => tool.name === "jev_inbox")!;
    expect(tool).toBeDefined();
    expect(worker.some(tool => tool.name === "integration_call")).toBe(false);
    let calls = 0;
    const execute = async args => {
      const result = await tool.execute(`call_${++calls}`, args, run.signal);
      return JSON.parse(result.content[0]!.text!);
    };
    const start = await execute({ operation: "batch_start" });
    if (mode === "revoke") {
      await expect(execute({ operation: "batch_next", jobId: start.jobId, revision: start.revision })).rejects.toThrow("unavailable");
      const checkpoints = await createBotCheckpointsRepository(db).listForRun({ ownerId: OWNER, runId: binding.runId });
      expect(checkpoints.map(row => row.phase)).toContain("effect_unknown");
      expect(label).toHaveBeenCalledOnce();
      expect(mail.get("thread1")).toContain(EMAIL_TRIAGE_LABELS.newsletter);
      return;
    }
    if (mode === "uncertain") {
      await expect(execute({ operation: "batch_next", jobId: start.jobId, revision: start.revision })).rejects.toThrow("unavailable");
      const status = await execute({ operation: "batch_status", jobId: start.jobId });
      expect(status).toMatchObject({ unconfirmed: 1, processed: 1 });
      const resumed = await execute({ operation: "batch_resume", jobId: start.jobId });
      const finished = await execute({ operation: "batch_next", jobId: start.jobId, revision: resumed.revision });
      expect(finished).toMatchObject({ status: "completed_with_unconfirmed", processed: 2, labeled: 1, unconfirmed: 1 });
      expect(label.mock.calls.map(call => call[2].threadId)).toEqual(["thread1", "thread2"]);
      const checkpoints = await createBotCheckpointsRepository(db).listForRun({ ownerId: OWNER, runId: binding.runId });
      expect(checkpoints.filter(row => row.phase === "effect_unknown")).toHaveLength(1);
      return;
    }
    const first = await execute({ operation: "batch_next", jobId: start.jobId, revision: start.revision });
    const completed = await execute({ operation: "batch_next", jobId: start.jobId, revision: first.revision });
    expect(completed).toMatchObject({ kind: "batch", status: "completed", labeled: 2, processed: 2, unconfirmed: 0 });
    const checkpoints = await db.selectFrom("bot_tool_checkpoints").select("phase").where("run_id", "=", binding.runId).execute();
    expect(checkpoints).toHaveLength(3);
    expect(checkpoints.every(row => row.phase === "observed_complete")).toBe(true);
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(label).toHaveBeenCalledTimes(2);
    expect([...mail.values()]).toEqual(Array(2).fill(["INBOX", "ExistingLabel", EMAIL_TRIAGE_LABELS.newsletter]));
    expect(read.mock.calls.some(call => call[2] === "list_threads" && call[3]?.pageToken === "page2")).toBe(true);
  } finally { await tools?.close(); run.abort(); await destroy(); }
});
