import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { Kysely } from "kysely";
import { expect, it, onTestFinished } from "vitest";
import { runBotTurn } from "../../../packages/bot-runtime/src/loop.js";
import { createBotStateTransactions } from "../../../packages/gateway/src/bots/events.js";
import { createBotIntegrationClient } from "../../../packages/gateway/src/bots/integration-client.js";
import { createBotIntegrationTools } from "../../../packages/gateway/src/bots/integration-tools.js";
import { createBotMemoryService } from "../../../packages/gateway/src/bots/memory-service.js";
import { createBotRecipeCatalog } from "../../../packages/gateway/src/bots/recipe-catalog.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { createBotGrantsRepository } from "../../../packages/gateway/src/bots/repositories/grants.js";
import { createBotMemoryRepository } from "../../../packages/gateway/src/bots/repositories/memory.js";
import { createBotTasksRepository } from "../../../packages/gateway/src/bots/repositories/tasks.js";
import type { BotRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { buildBotSystemPrompt } from "../../../packages/gateway/src/bots/system-prompt.js";
import { createBotSelectedChatReader } from "../../../packages/gateway/src/chat/bot-selected-chat.js";
import { bootstrapChatSharing } from "../../../packages/gateway/src/chat/sharing.js";
import { runCommandFromSpec } from "../../../packages/bot-runtime/src/worker.js";
import { ownerHttpInputProvenance } from "../../../packages/gateway/src/chat/owner-http-input.js";
import { ChatAgentContext } from "../../../packages/gateway/src/chat/agent-context.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import { jsonb } from "../../../packages/gateway/src/chat/records.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { BOT, NOW, OWNER, createBotStateDatabase, createRealBotStateDatabase, insertChat } from "./bot-state-support.js";

it("grounds an onboarding brief in granted work accounts and confirmed memory and a prior Chat selected for this turn only", async () => {
  const fixture = await (process.env.MATRIX_TEST_POSTGRES_URL ? createRealBotStateDatabase() : createBotStateDatabase());
  onTestFinished(fixture.destroy);
  const { db } = fixture;
  const chatId = "chat_onboarding", prior = "chat_prior";
  const owner = { type: "personal" as const, ownerId: OWNER };
  const scope = { ownerId: OWNER, botId: BOT, chatId };
  await insertChat(db, chatId);
  await insertChat(db, prior);
  const repository = new ChatRepository(db as unknown as Kysely<ChatDatabase>);
  const priorText = "Restricted mentor assignment from a separate conversation.";
  await repository.kysely.insertInto("chat_messages").values({
    id: "msg_mentor", chat_id: prior, seq: 1, role: "user", state: "committed", purpose: "discussion",
    run_id: null, turn_id: null, actor_id: OWNER, parts: jsonb([{ type: "text", text: priorText }]),
    byte_count: Buffer.byteLength(priorText), search_text: priorText, created_at: new Date(NOW),
  }).execute();
  const bindings = createBotBindingsRepository(db);
  await bindings.bindDirect({ ...scope, now: NOW });
  const task = await createBotTasksRepository(db).create({ ...scope, now: NOW });
  const recipes = createBotRecipeCatalog();
  const recipe = recipes.list().find(item => item.recipeId === "personal-daily-brief")!;
  const selection = { instanceId: "matrix_pi_default", model: "claude-sonnet-5" };
  const agent = { id: BOT, name: recipe.name, description: recipe.description, instructions: recipe.instructions,
    recipeRef: { recipeId: recipe.recipeId, version: recipe.version }, selection, archived: false,
    revision: 1, createdAt: NOW, updatedAt: NOW };
  const agents = { get: async () => agent };
  await bootstrapChatSharing(repository.kysely);
  const selectedChats = createBotSelectedChatReader(repository);
  const admission = new ChatAgentContext({ repository, selectedChats, agents, enabled: () => true, botChats: {
    directBot: async (actor, id) => (await bindings.forChat({ ownerId: actor.ownerId, chatId: id }))[0]?.botId ?? null,
  } });
  const request = { selection, clientRequestId: "req_onboarding", baseRevision: 0, interactionMode: "default" as const,
    permissionMode: "supervised" as const, parts: [{ type: "text" as const, text: "Prepare my first-week brief." }] };
  const withPrior = { ...request, parts: [...request.parts,
    { type: "resource_reference" as const, resource: { kind: "chat" as const, id: prior, label: "Earlier decisions" } },
  ] };
  // A continuation can carry the same structured request without the owner's HTTP selection.
  await expect(admission.prepare(owner, chatId, withPrior)).rejects.toMatchObject({ code: "context_unavailable" });
  const unverified = ownerHttpInputProvenance({ userId: OWNER, source: "configured-container" }, owner);
  await expect(admission.prepare(owner, chatId, withPrior, unverified)).rejects.toMatchObject({ code: "context_unavailable" });
  const ownerInput = ownerHttpInputProvenance({ userId: OWNER, source: "jwt" }, owner);
  const prepared = await admission.prepare(owner, chatId, withPrior, ownerInput);
  expect(prepared.context?.botChatSources?.sources.map(source => source.chatId)).toEqual([prior]);
  await expect(admission.prepare(owner, chatId, request)).resolves.toHaveProperty("selection");

  const selectionProof = prepared.context!.botChatSources!;
  expect(JSON.stringify(selectionProof)).not.toContain(priorText);
  expect((await admission.prepare(owner, chatId, request)).context?.botChatSources).toBeUndefined();
  const accounts = [
    { id: "conn_work_mail", service: "gmail", account_label: "Work inbox" },
    { id: "conn_work_calendar", service: "google_calendar", account_label: "Work calendar" },
    { id: "conn_private_mail", service: "gmail", account_label: "Other inbox" },
  ];
  for (const account of accounts.slice(0, 2)) {
    await createBotGrantsRepository(db).grant({ ...scope, service: account.service, connectionId: account.id,
      accountLabel: account.account_label, effects: ["read"], audience: "direct", grantedByActorId: OWNER, now: NOW });
  }
  const mail = "Collect the training badge on Monday.";
  const calendar = "Learning lab on Tuesday at 14:00.";
  const preference = "Use a short checklist.";
  const unconfirmed = "Unconfirmed preference for a public post.";
  for (const [content, confirmed] of [[preference, true], [unconfirmed, false]] as const) {
    await createBotMemoryRepository(db).remember({ ...scope, kind: "preference", scope: "bot", source: {},
      content, confirmed, now: NOW });
  }
  const now = () => new Date(NOW);
  const transact = createBotStateTransactions(repository);
  const memory = await createBotMemoryService({ transact, now }).admitted(scope);
  const reads: string[] = [];
  const client = createBotIntegrationClient(async (actor, input) => {
    expect(actor).toBe(OWNER);
    if (input.method === "GET" && input.path === "/") return Response.json(accounts.map(a => ({ ...a, status: "active" })));
    expect(input.path).toBe("/read-call");
    const connectionId = input.body?.connectionId;
    if (typeof connectionId !== "string") throw new Error("Missing connection ID");
    reads.push(connectionId);
    const fact = new Map([[accounts[0].id, mail], [accounts[1].id, calendar]]).get(connectionId);
    if (!fact) throw new Error("Unexpected read on an ungranted account");
    return Response.json({ data: { fact } });
  });
  const integrations = createBotIntegrationTools({ agents, recipes, transact, client, now });
  const binding: BotRuntimeBinding = { ...scope, runtimeHandle: "runtime_" + "b".repeat(32), executionGeneration: "1",
    runId: "run_onboarding", taskId: task.taskId, rootFingerprint: "c".repeat(64), capabilities: ["integration.call"],
    accessSourceId: "owner_anthropic_key", requestClass: "interactive",
    route: { api: "anthropic-messages", modelId: "training", input: ["text"], contextWindow: 32000, maxOutputTokens: 2048 } };
  const query = (service: string, connectionId: string, action: string) => ({ service, connectionId, action, params: {} });
  await integrations.call(binding, query("gmail", accounts[2].id, "list_threads"));
  expect(reads).toEqual([]);

  const provider = fauxProvider({ models: [{ id: "training", input: ["text"], contextWindow: 32000, maxTokens: 2048 }] });
  const contexts: string[] = [];
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall("integration_call", query("gmail", accounts[0].id, "list_threads"), { id: "call_mail" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("integration_call", query("google_calendar", accounts[1].id, "list_events"), { id: "call_calendar" }), { stopReason: "toolUse" }),
    context => {
      contexts.push(JSON.stringify(context.messages));
      const reference = context.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes(priorText));
      const checklist = JSON.stringify(context.messages.find(message => message.role === "system")).includes(preference);
      const facts = context.messages.flatMap(message => message.role === "toolResult"
        ? message.content.flatMap(part => part.type === "text" ? [JSON.parse(part.text).fact as string] : []) : []);
      return fauxAssistantMessage(fauxText([...facts, ...(reference ? [priorText] : [])].map(fact => checklist ? `- ${fact}` : fact).join("\n")));
    },
  ]);
  const output: string[] = [];
  const result = await runBotTurn({ route: { provider: provider.provider, model: provider.getModel() }, bridgeOrigin: "http://127.0.0.1:1",
    command: runCommandFromSpec(binding.runId, { selectedChatReference: await selectedChats.read(owner, chatId, selectionProof), route: binding.route, capabilities: ["integration.call"],
      limits: { maxToolActions: 4 }, turn: { kind: "prompt", text: request.parts[0].text },
      systemPrompt: buildBotSystemPrompt({ botName: recipe.name, instructions: recipe.instructions, recipe, now: now(), memory }) }, []),
    broker: { loadSession: async () => ({ revision: 0, needsRecompaction: false, messages: [] }),
      saveSession: async snapshot => {
        expect(JSON.stringify(snapshot.messages)).not.toContain(JSON.stringify(selectionProof.sources));
        expect(JSON.stringify(snapshot.messages.filter(message => message.role === "user"))).not.toContain(priorText);
        return { revision: 1 };
      }, event: async ({ event }) => { if (event.type === "assistant_delta") output.push(event.text); },
      tool: async (call, signal) => {
        if (call.capability !== "integration.call") throw new Error("Unexpected onboarding tool");
        return integrations.call(binding, call.args, signal);
      } },
  });
  expect(result.status).toBe("completed");
  expect(reads).toEqual([accounts[0].id, accounts[1].id]);
  expect(output.join("")).toBe(`- ${mail}\n- ${calendar}\n- ${priorText}`);
  expect(contexts).toHaveLength(1);
  for (const included of [mail, calendar, preference, priorText]) expect(contexts[0]).toContain(included);
  expect(contexts[0]).not.toContain(unconfirmed);
});
