import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import type { BotRunCommand } from "@matrix-os/contracts";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBotBrokerClient } from "../../../packages/bot-runtime/src/broker-client.js";
import { runBotTurn } from "../../../packages/bot-runtime/src/loop.js";
import { createBotBrokerActions } from "../../../packages/gateway/src/bots/broker-actions.js";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { createBotStateTransactions } from "../../../packages/gateway/src/bots/events.js";
import { createBotMemoryService } from "../../../packages/gateway/src/bots/memory-service.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { createBotCheckpointsRepository } from "../../../packages/gateway/src/bots/repositories/checkpoints.js";
import { createBotMemoryRepository } from "../../../packages/gateway/src/bots/repositories/memory.js";
import { createBotSessionsRepository } from "../../../packages/gateway/src/bots/repositories/sessions.js";
import { createBotTasksRepository } from "../../../packages/gateway/src/bots/repositories/tasks.js";
import { BotStateError } from "../../../packages/gateway/src/bots/repositories/shared.js";
import { BotRuntimeRegistry } from "../../../packages/gateway/src/bots/runtime-registry.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { jsonb } from "../../../packages/gateway/src/chat/records.js";
import { createScopeRuntimeBrokerServer } from "../../../packages/gateway/src/collaboration/scope-runtime-broker.js";
import { BOT, NOW, OWNER, at, createBotStateDatabase, insertChat } from "./bot-state-support.js";

const CHAT = "chat_forget_summary";
const RUNTIME = `runtime_${"c".repeat(32)}`;
const key = { ownerId: OWNER, botId: BOT, chatId: CHAT };
const FORGOTTEN = "The owner prefers FORGOTTEN_SUMMARY_SENTINEL in greetings.";
const LIVE = "The owner prefers LIVE_MEMORY_SENTINEL for headings.";
const original = { role: "user", content: `Please remember: ${FORGOTTEN}`, timestamp: 1 };
const recent = [
  { role: "user", content: "Continue the safe report.", timestamp: 3 },
  { ...fauxAssistantMessage(fauxText("The report is ready.")), timestamp: 4 },
] as unknown as Record<string, unknown>[];
let db: Kysely<OwnerBotDatabase>;
let destroy: () => Promise<void>;
const cleanup: Array<() => Promise<void>> = [];

beforeEach(async () => {
  ({ db, destroy } = await createBotStateDatabase());
  await insertChat(db, CHAT);
  await createBotBindingsRepository(db).bindDirect({ ...key, now: NOW });
  await db.insertInto("chat_messages").values({
    id: "msg_original_forget", chat_id: CHAT, seq: 1, role: "user", state: "committed", turn_id: null,
    run_id: null, actor_id: OWNER, purpose: "discussion", parts: jsonb([{ type: "text", text: original.content }]),
    search_text: original.content, byte_count: original.content.length, created_at: new Date(NOW),
  } as never).execute();
});
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  await destroy();
});

function memory() {
  return createBotMemoryService({
    transact: createBotStateTransactions(new ChatRepository(db as unknown as Kysely<ChatDatabase>)),
    now: () => new Date(at(2)),
  });
}

async function remember(content: string) {
  return createBotMemoryRepository(db).remember({ ...key, kind: "preference", scope: "bot", content,
    source: { at: NOW }, confirmed: true, now: NOW });
}

async function saveSeed(messages: Record<string, unknown>[]) {
  return createBotSessionsRepository(db).save({ ...key, baseRevision: 0, messages,
    tokenEstimate: 50, runtimeVersions: {}, now: NOW });
}

async function worker() {
  const task = await createBotTasksRepository(db).create({ ...key, now: NOW });
  const route: BotRunCommand["route"] = { api: "anthropic-messages", modelId: "faux-bot", input: ["text"],
    contextWindow: 128_000, maxOutputTokens: 4_096 };
  const registry = new BotRuntimeRegistry();
  registry.bind({ ...key, runtimeHandle: RUNTIME, executionGeneration: "1", taskId: task.taskId,
    runId: "run_forget_summary", rootFingerprint: "f".repeat(64), route, accessSourceId: "matrix_included",
    capabilities: [], requestClass: "interactive" });
  const command: BotRunCommand = { version: 1, kind: "bot.run", runId: "run_forget_summary", route,
    systemPrompt: `You are the writing bot.\n${(await memory().admitted(key)).join("\n")}`,
    capabilities: [], limits: { maxToolActions: 10 }, turn: { kind: "prompt", text: "What next?" } };
  const actions = createBotBrokerActions({ db, registry, sessions: createBotSessionsRepository(db),
    checkpoints: createBotCheckpointsRepository(db), runs: { loadRunSpec: async () => command,
      readImageChunk: async () => { throw new Error("No images in this fixture"); } },
    events: { publish: async () => undefined }, tools: { effectClass: () => "read",
      dispatch: async () => { throw new Error("No tools in this fixture"); } },
    inference: { homePath: "/tmp", lifetime: new AbortController().signal,
      resolveCredentials: async () => { throw new Error("No real inference in this fixture"); } },
    now: () => new Date(at(3)),
  });
  const dir = await mkdtemp(join(tmpdir(), "bot-forget-"));
  const socketPath = join(dir, "broker.sock");
  const server = createScopeRuntimeBrokerServer({ socketPath, broker: { handle: vi.fn(), close: vi.fn() },
    routeFrame: (frame) => actions.handleFrame(frame) });
  await server.start();
  cleanup.push(async () => { await server.close(); registry.shutdown(); await rm(dir, { recursive: true, force: true }); });
  const broker = createBotBrokerClient({ socketPath, runtimeHandle: RUNTIME, executionGeneration: "1",
    runId: command.runId, timeoutMs: 2_000 });
  const provider = fauxProvider({ models: [{ id: "faux-bot", contextWindow: 128_000, maxTokens: 4_096 }] });
  provider.setResponses([fauxAssistantMessage(fauxText("The next safe step."))]);
  const stream = vi.spyOn(provider.provider, "streamSimple");
  return { command, broker, stream, route: { provider: provider.provider, model: provider.getModel() } };
}

describe("forgotten memory through repository, broker socket and actual Pi context", () => {
  it.each(["legacy", "tagged"] as const)("discards %s derived summaries before inference and keeps owner history", async (kind) => {
    const summary = kind === "legacy"
      ? { role: "user", content: `Summary of the earlier conversation, for context only:\n\n${FORGOTTEN}`, timestamp: 2 }
      : { role: "user", content: `Earlier preference: ${FORGOTTEN}`, timestamp: 2, matrixBotSessionKind: "summary" };
    await saveSeed([{ role: "system", content: `STALE_PROMPT ${FORGOTTEN}`, timestamp: 0 }, summary, ...recent]);
    const forgotten = await remember(FORGOTTEN);
    await remember(LIVE);
    await memory().forget(OWNER, BOT, forgotten.itemId, { baseRevision: forgotten.revision });
    const setup = await worker();
    const snapshot = await setup.broker.loadSession();
    const outcome = await runBotTurn({ ...setup, bridgeOrigin: "http://127.0.0.1:41000", now: () => 1_000 });
    expect(outcome).toMatchObject({ status: "completed", sessionRevision: 3 });
    expect(setup.stream).toHaveBeenCalledTimes(1);
    const context = JSON.stringify(setup.stream.mock.calls[0]![1]);
    expect(context).not.toContain("FORGOTTEN_SUMMARY_SENTINEL");
    expect(context).not.toContain("STALE_PROMPT");
    expect(context).toContain("LIVE_MEMORY_SENTINEL");
    expect(context).toContain("Continue the safe report.");
    expect(snapshot).toMatchObject({ revision: 2, needsRecompaction: true });
    const saved = await createBotSessionsRepository(db).load(key);
    expect(saved.needsRecompaction).toBe(false);
    expect(JSON.stringify(saved.messages)).not.toContain("FORGOTTEN_SUMMARY_SENTINEL");
    expect(saved.messages).toEqual(expect.arrayContaining(recent));
    // Forget removes standing/derived memory, while the actual owner statement remains inspectable.
    const canonical = await db.selectFrom("chat_messages").select(["search_text", "parts"]).where("id", "=", "msg_original_forget").executeTakeFirstOrThrow();
    expect(canonical.search_text).toBe(original.content);
    expect(canonical.parts).toEqual([{ type: "text", text: original.content }]);
  });

  it("rejects a stale invalidation acknowledgement when a second forget races a loaded turn", async () => {
    await saveSeed(recent);
    const first = await remember(FORGOTTEN);
    const second = await remember(LIVE);
    await memory().forget(OWNER, BOT, first.itemId, { baseRevision: first.revision });
    const sessions = createBotSessionsRepository(db);
    const loaded = await sessions.load(key);
    await memory().forget(OWNER, BOT, second.itemId, { baseRevision: second.revision });
    await expect(sessions.save({ ...key, baseRevision: loaded.revision, messages: recent,
      recompactionHandled: true, tokenEstimate: 50, runtimeVersions: {}, now: at(4) } as Parameters<typeof sessions.save>[0]))
      .rejects.toEqual(new BotStateError("revision_conflict"));
    await expect(sessions.load(key)).resolves.toMatchObject({ revision: loaded.revision + 1, needsRecompaction: true, messages: recent });
  });

  it("rejects the loaded turn's broker save after forgetting and cleans the next actual context", async () => {
    await saveSeed([{ role: "user", content: `Summary of the earlier conversation, for context only:\n\n${FORGOTTEN}`,
      timestamp: 2 }, ...recent]);
    const first = await remember(FORGOTTEN);
    const second = await remember(LIVE);
    await memory().forget(OWNER, BOT, first.itemId, { baseRevision: first.revision });
    const setup = await worker();
    const save = setup.broker.saveSession.bind(setup.broker);
    const staleSave = vi.spyOn(setup.broker, "saveSession").mockImplementation(async (request) => {
      // The model already ran; the person forgets another item before its save commits.
      await memory().forget(OWNER, BOT, second.itemId, { baseRevision: second.revision });
      return save(request);
    });
    const firstOutcome = await runBotTurn({ ...setup, bridgeOrigin: "http://127.0.0.1:41000" });
    expect(firstOutcome).toMatchObject({ status: "failed", failureCode: "stale_generation", sessionRevision: 2 });
    expect(staleSave).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ baseRevision: 2, recompactionHandled: true }));
    await expect(createBotSessionsRepository(db).load(key)).resolves.toMatchObject({ revision: 3, needsRecompaction: true });

    const next = await worker();
    const nextOutcome = await runBotTurn({ ...next, bridgeOrigin: "http://127.0.0.1:41000" });
    expect(nextOutcome).toMatchObject({ status: "completed", sessionRevision: 4 });
    expect(next.stream).toHaveBeenCalledTimes(1);
    const context = JSON.stringify(next.stream.mock.calls[0]![1]);
    expect(context).not.toContain("FORGOTTEN_SUMMARY_SENTINEL");
    expect(context).not.toContain("LIVE_MEMORY_SENTINEL");
    expect(context).toContain("Continue the safe report.");
    await expect(createBotSessionsRepository(db).load(key)).resolves.toMatchObject({ revision: 4, needsRecompaction: false });
  });

  it("preserves an ordinary person turn quoting the legacy summary envelope", async () => {
    const quoted = { role: "user", content: "Summary of the earlier conversation, for context only:\n\nPlease examine this quoted format.",
      timestamp: 5 };
    await saveSeed([{ role: "user", content: `Summary of the earlier conversation, for context only:\n\n${FORGOTTEN}`,
      timestamp: 2 }, ...recent, quoted]);
    const item = await remember(FORGOTTEN);
    await memory().forget(OWNER, BOT, item.itemId, { baseRevision: item.revision });
    const setup = await worker();
    await runBotTurn({ ...setup, bridgeOrigin: "http://127.0.0.1:41000" });
    const context = JSON.stringify(setup.stream.mock.calls[0]![1]);
    expect(context).not.toContain("FORGOTTEN_SUMMARY_SENTINEL");
    expect(context).toContain("Please examine this quoted format.");
    const saved = await createBotSessionsRepository(db).load(key);
    expect(saved.messages).toEqual(expect.arrayContaining([quoted]));
  });

  it("keeps a valid derived summary until forgetting invalidates it", async () => {
    const summary = { role: "user", content: "Summary of the earlier conversation, for context only:\n\nAn earlier safe decision.",
      timestamp: 2, matrixBotSessionKind: "summary" };
    await saveSeed([summary, ...recent]);
    const setup = await worker();
    const outcome = await runBotTurn({ ...setup, bridgeOrigin: "http://127.0.0.1:41000" });
    expect(outcome).toMatchObject({ status: "completed", sessionRevision: 2 });
    expect(JSON.stringify(setup.stream.mock.calls[0]![1])).toContain("An earlier safe decision.");
    const saved = await createBotSessionsRepository(db).load(key);
    expect(saved.messages).toEqual(expect.arrayContaining([summary, ...recent]));
    expect(saved.needsRecompaction).toBe(false);
  });

  it("leaves invalidated history untouched when the run is cancelled before it starts", async () => {
    await saveSeed(recent);
    const item = await remember(FORGOTTEN);
    await memory().forget(OWNER, BOT, item.itemId, { baseRevision: item.revision });
    const setup = await worker();
    const signal = new AbortController();
    signal.abort();
    const outcome = await runBotTurn({ ...setup, bridgeOrigin: "http://127.0.0.1:41000", signal: signal.signal });
    expect(outcome).toMatchObject({ status: "cancelled", sessionRevision: 2 });
    expect(setup.stream).not.toHaveBeenCalled();
    await expect(createBotSessionsRepository(db).load(key)).resolves.toMatchObject({ revision: 2, needsRecompaction: true, messages: recent });
  });
});
