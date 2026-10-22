import * as workspaceSaves from "../../../packages/gateway/src/bots/tool-dispatcher.js";
import * as googleRuntime from "../../../packages/gateway/src/startup/google-data.js";
import { createOwnerChatHistoryRepository } from '../../../packages/gateway/src/startup/chat-history.js';
import { createExecutionAdmissionFence } from '../../../packages/gateway/src/execution-admission-fence.js';
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { createBotCheckpointsRepository } from "../../../packages/gateway/src/bots/repositories/checkpoints.js";
import * as managedPiCheckpoints from "../../../packages/gateway/src/chat/managed-pi-checkpoints.js";
import { createBotTasksRepository } from "../../../packages/gateway/src/bots/repositories/tasks.js";
import { ChatAgentStore } from "../../../packages/gateway/src/chat/agent-store.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { runConnectionReconciliationPass, startBots } from "../../../packages/gateway/src/startup/bots.js";
import { BOT, OWNER, createBotStateDatabase, insertChat } from "./bot-state-support.js";

let db: Kysely<OwnerBotDatabase>;
let destroy: () => Promise<void>;
let home: string;
let agents: ChatAgentStore;
let repository: ChatRepository;

beforeEach(async () => {
  ({ db, destroy } = await createBotStateDatabase());
  home = await mkdtemp(join(tmpdir(), "matrix-bot-startup-"));
  repository = new ChatRepository(db as unknown as Kysely<ChatDatabase>);
  agents = new ChatAgentStore({ homePath: home, db: repository.kysely });
  await agents.bootstrap();
});
afterEach(async () => {
  await agents.close();
  await destroy();
  await rm(home, { recursive: true, force: true });
});

function host(available = true) {
  const unregister = vi.fn();
  return {
    unregister,
    host: {
      available,
      client: { runBot: vi.fn(), stopRuntime: vi.fn(), createRuntime: vi.fn() },
      registerAuthorizer: vi.fn(() => unregister),
      close: vi.fn(),
    },
  };
}

const base = () => ({
  homePath: home,
  repository,
  agents,
  executionRoots: { resolve: vi.fn() },
  providers: { getSnapshot: vi.fn() },
});

describe("bot services at gateway start", () => {
  it("rejects a mismatched funded owner before starting any background job", async () => {
    const intervals = vi.spyOn(globalThis, 'setInterval');
    try {
      await expect(startBots({ ...base(), runtimeOwnerId: OWNER, googlePilot: { enabled: true, ownerId: OWNER },
        googleCopies: {} as never, host: host().host as never, executionAdmissionFence: createExecutionAdmissionFence(),
        pendingExecutionCount: () => 0, integrations: vi.fn() as never,
        qualifiedFundedConfig: { identity: { ownerId: 'foreign-owner' } } as never })).rejects.toThrow('Google pilot unavailable');
      expect(intervals).not.toHaveBeenCalled();
    } finally { intervals.mockRestore(); }
  });

  it("drains acquired background jobs when later pilot construction fails", async () => {
    const intervals = vi.spyOn(globalThis, 'setInterval');
    const cleared = vi.spyOn(globalThis, 'clearInterval');
    const factory = vi.spyOn(googleRuntime, 'createGoogleBrokerRuntime').mockRejectedValue(new Error('Synthetic unavailable'));
    let release!: () => void;
    const saves = vi.spyOn(workspaceSaves, 'sweepBotWorkspaceSaves').mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    try {
      let settled = false;
      const starting = startBots({ ...base(), runtimeOwnerId: OWNER, googlePilot: { enabled: true, ownerId: OWNER },
        googleCopies: {} as never, host: host().host as never, executionAdmissionFence: createExecutionAdmissionFence(),
        pendingExecutionCount: () => 0, integrations: vi.fn() as never });
      const rejection = expect(starting.finally(() => { settled = true; })).rejects.toThrow();
      await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());
      expect(settled).toBe(false);
      release();
      await rejection;
      expect(intervals.mock.results.length).toBeGreaterThan(0);
      for (const result of intervals.mock.results) expect(cleared).toHaveBeenCalledWith(result.value);
    } finally {
      // Bound RED even when startup leaked its own timers.
      for (const result of intervals.mock.results) clearInterval(result.value);
      release?.(); saves.mockRestore(); factory.mockRestore(); intervals.mockRestore(); cleared.mockRestore();
    }
  });

  it("continues managed Chat checkpoint recovery beyond its bounded startup batch", async () => {
    let remaining = 250;
    const reconcile = vi.fn(async () => {
      const changed = Math.min(remaining, 200);
      remaining -= changed;
      return changed;
    });
    const repository = managedPiCheckpoints.createManagedPiCheckpointsRepository(db);
    const factory = vi.spyOn(managedPiCheckpoints, "createManagedPiCheckpointsRepository")
      .mockReturnValue({ ...repository, reconcileDispatched: reconcile });
    const { host: runtimeHost } = host();
    const services = await startBots({ ...base(), host: runtimeHost as never,
      now: () => new Date("2026-09-28T09:00:00.000Z"), checkpointReconcile: { passes: 1, intervalMs: 10 } });
    try {
      await vi.waitFor(() => expect(remaining).toBe(0));
      expect(reconcile.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      await services!.close();
      factory.mockRestore();
    }
  });

  it("continues later owners when one inventory fails, and retries failed admission", async () => {
    const continuation = { chatId: "chat_restart1", clientRequestId: "req_answer_in_0123456789abcdef01234567", text: "Connected." };
    const reconcile = vi.fn(async (ownerId: string) => {
      if (ownerId === "bad") throw new Error("inventory unavailable");
      return [];
    });
    const pendingContinuations = vi.fn(async () => [continuation]);
    const ackContinuation = vi.fn(async () => undefined);
    const deferContinuation = vi.fn(async () => undefined);
    const deferOwner = vi.fn(async () => undefined);
    let fail = true;
    const admit = vi.fn(async () => { if (fail) throw new Error("temporarily busy"); });
    const connections = { ownersWithPending: async () => ["bad", "good"], reconcile, pendingContinuations, ackContinuation, deferContinuation, deferOwner };
    await runConnectionReconciliationPass(connections, admit);
    expect(reconcile).toHaveBeenCalledWith("good");
    expect(deferOwner).toHaveBeenCalledWith("bad");
    expect(pendingContinuations).toHaveBeenCalledWith("bad");
    expect(deferContinuation).toHaveBeenCalledWith("good", continuation.clientRequestId);
    fail = false;
    await runConnectionReconciliationPass(connections, admit);
    expect(ackContinuation).toHaveBeenCalledWith("good", continuation.clientRequestId);
  });
  it("marks tool calls the previous process left dispatched as effect unknown, before any run", async () => {
    await insertChat(db, "chat_restart1");
    const task = await createBotTasksRepository(db).create({ ownerId: OWNER, botId: BOT, chatId: "chat_restart1", now: "2026-09-27T12:00:00.000Z" });
    const checkpoints = createBotCheckpointsRepository(db);
    const prepared = await checkpoints.prepare({
      ownerId: OWNER, taskId: task.taskId, runId: "run_lost1", toolCallId: "call_1", action: { capability: "artifact.write" },
      effectClass: "write", now: "2026-09-27T12:00:00.000Z",
    });
    await checkpoints.markDispatched({ ownerId: OWNER, checkpointId: prepared.checkpoint.checkpointId, now: "2026-09-27T12:00:01.000Z" });
    const { host: runtimeHost, unregister } = host();

    const services = await startBots({ ...base(), host: runtimeHost as never, now: () => new Date("2026-09-28T09:00:00.000Z") });
    expect(services?.adapter?.driverKind).toBe("matrix_bot");
    await expect(checkpoints.listForRun({ ownerId: OWNER, runId: "run_lost1" }))
      .resolves.toEqual([expect.objectContaining({ phase: "effect_unknown" })]);
    expect(runtimeHost.registerAuthorizer).toHaveBeenCalledWith(expect.objectContaining({ id: "bots" }));
    // Nothing was replayed.
    expect(runtimeHost.client.runBot).not.toHaveBeenCalled();
    await services!.close();
    expect(unregister).toHaveBeenCalledTimes(1);
  });

  it("finishes closing old checkpoints in the background when there are more than startup takes", async () => {
    await insertChat(db, "chat_restart2");
    const task = await createBotTasksRepository(db).create({ ownerId: OWNER, botId: BOT, chatId: "chat_restart2", now: "2026-09-27T12:00:00.000Z" });
    const checkpoints = createBotCheckpointsRepository(db);
    for (let index = 0; index < 250; index += 1) {
      const prepared = await checkpoints.prepare({
        ownerId: OWNER, taskId: task.taskId, runId: "run_lost2", toolCallId: `call_${index}`, action: { capability: "artifact.write", index },
        effectClass: "write", now: "2026-09-27T12:00:00.000Z",
      });
      await checkpoints.markDispatched({ ownerId: OWNER, checkpointId: prepared.checkpoint.checkpointId, now: "2026-09-27T12:00:01.000Z" });
    }
    const { host: runtimeHost } = host();
    const services = await startBots({
      ...base(), host: runtimeHost as never, now: () => new Date("2026-09-28T09:00:00.000Z"),
      checkpointReconcile: { passes: 1, intervalMs: 10 },
    });
    const dispatched = async () => Number((await db.selectFrom("bot_tool_checkpoints").select((eb) => eb.fn.countAll<number>().as("count"))
      .where("phase", "=", "dispatched").executeTakeFirstOrThrow()).count);
    // One pass (200) at start; the rest in the background.
    await vi.waitFor(async () => expect(await dispatched()).toBe(0));
    await services!.close();
  });

  it("resolves only live recipe-bot Chats belonging to the requesting owner", async () => {
    const services = await startBots(base());
    try {
      const created = await services!.instantiation.instantiate(OWNER, {
        clientRequestId: "req_sidebar_0123456789abcdef",
        recipe: { recipeId: "writing-bot", version: "2026-09-27.1" },
      });
      const owner = { type: "personal" as const, ownerId: OWNER };
      await expect(services!.botChats.directChat!(owner, created.agent.id)).resolves.toBe(created.chatId);
      await expect(services!.botChats.directChat!({ type: "personal", ownerId: "other_owner" }, created.agent.id)).resolves.toBeNull();
      await expect(services!.botChats.directChat!({ type: "org", ownerId: OWNER }, created.agent.id)).resolves.toBeNull();
      await agents.update(owner, created.agent.id, { baseRevision: created.agent.revision, archived: true });
      await expect(services!.botChats.directChat!(owner, created.agent.id)).resolves.toBeNull();
    } finally { await services!.close(); }
  });

  it("offers creation but no bot runtime when the scope runtime is unavailable", async () => {
    const { host: down } = host(false);
    const services = await startBots({ ...base(), host: down as never });
    expect(services?.instantiation).toBeDefined();
    expect(services?.adapter).toBeUndefined();
    expect(down.registerAuthorizer).not.toHaveBeenCalled();
    await expect(services!.botChats.directBot({ type: "personal", ownerId: OWNER }, "chat_none")).resolves.toBeNull();
    await services!.close();
  });

  it("starts exact-owner pilot purge delivery and drains actual transport before local services close", async () => {
    const history=createOwnerChatHistoryRepository(repository.kysely,{pilot:{enabled:true,ownerId:OWNER}}); await history.bootstrap();
    const {host:runtimeHost}=host(); let release!:(response:Response)=>void;
    const integrations=vi.fn(async (_owner:string,request:{path:string;signal?:AbortSignal})=>{
      expect(_owner).toBe(OWNER); expect(request.path).toBe('/gmail/processing/purge-commands');
      return new Promise<Response>(resolve=>{release=resolve;});
    });
    const services=await startBots({...base(),repository:history.repository,runtimeOwnerId:OWNER,host:runtimeHost as never,
      googlePilot:{enabled:true,ownerId:OWNER},googleCopies:history.googleCopies,
      executionAdmissionFence:createExecutionAdmissionFence(),pendingExecutionCount:()=>0,integrations});
    expect(services?.purgeGoogleAccount).toBeTypeOf('function');
    await vi.waitFor(()=>expect(integrations).toHaveBeenCalledOnce());
    let closed=false;const closing=services!.close().then(()=>{closed=true;}); await new Promise(resolve=>setTimeout(resolve,10));expect(closed).toBe(false);
    release(Response.json({commands:[]}));await closing;expect(closed).toBe(true);
    expect(await repository.kysely.selectFrom('chat_runs').select('id').execute()).toEqual([]);
  });

  it("refuses enabled pilot startup when required transport or bot state is unavailable", async () => {
    const closed = await createBotStateDatabase({ migrate: false }); await closed.destroy();
    const { host: runtimeHost } = host();
    const options = { ...base(), runtimeOwnerId: OWNER, googlePilot: { enabled: true as const, ownerId: OWNER },
      googleCopies: {} as never, host: runtimeHost as never, executionAdmissionFence: createExecutionAdmissionFence(),
      pendingExecutionCount: () => 0, repository: { kysely: closed.db, withTransaction: vi.fn() } as never };
    await expect(startBots(options)).rejects.toThrow('Google pilot unavailable');
    await expect(startBots({ ...options, integrations: vi.fn(async () => new Response()) as never })).rejects.toThrow('Google pilot unavailable');
  });

  it("leaves bots unavailable, without failing the gateway, when bot state cannot be prepared", async () => {
    const closed = await createBotStateDatabase({ migrate: false });
    await closed.destroy();
    await expect(startBots({ ...base(), repository: { kysely: closed.db, withTransaction: vi.fn() } as never })).resolves.toBeUndefined();
  });
});
