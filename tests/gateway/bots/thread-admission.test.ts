import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotAdmissionError, createPrivateBotAdmission, type PrivateBotRunRequest } from "../../../packages/gateway/src/bots/admission.js";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { BotRuntimeRegistry } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { createBotWorkspace } from "../../../packages/gateway/src/chat/bot-workspace-root.js";
import { createChatExecutionRootResolver } from "../../../packages/gateway/src/chat/execution-root.js";
import { createChatNavigationRepository } from "../../../packages/gateway/src/chat/navigation-repository.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import { BOT, NOW, OWNER, at, createBotStateDatabase, insertChat } from "./bot-state-support.js";

const RUNTIME = `runtime_${"a".repeat(32)}`;
const PROJECT = "proj_brain01";
let db: Kysely<OwnerBotDatabase>;
let destroy: () => Promise<void>;
let homePath: string;

beforeEach(async () => {
  ({ db, destroy } = await createBotStateDatabase());
  homePath = await mkdtemp(join(tmpdir(), "bot-thread-admission-"));
  for (const chatId of ["chat_direct1", "chat_thread1", "chat_plain1"]) await insertChat(db, chatId);
  const bindings = createBotBindingsRepository(db);
  await bindings.bindDirect({ ownerId: OWNER, botId: BOT, chatId: "chat_direct1", now: NOW });
  await bindings.bindThread({ ownerId: OWNER, botId: BOT, chatId: "chat_thread1", projectId: PROJECT, now: NOW });
  await createBotWorkspace({ homePath, botId: BOT });
});
afterEach(async () => {
  await destroy();
  await rm(homePath, { recursive: true, force: true });
});

function admission() {
  const registry = new BotRuntimeRegistry();
  const client = {
    createRuntime: vi.fn(async () => ({ runtimeHandle: RUNTIME, executionGeneration: "2", state: "running" as const })),
    stopRuntime: vi.fn(async () => ({ runtimeHandle: RUNTIME, executionGeneration: "2", state: "stopped" as const })),
  };
  const roots = createChatExecutionRootResolver({
    homePath, projects: { getProjectById: vi.fn(), resolveProjectWorkingDirectory: vi.fn() }, worktrees: { getWorktree: vi.fn() },
  });
  return { registry, client, admission: createPrivateBotAdmission({ db, host: { available: true, client: client as never }, roots, registry }) };
}

const request = (overrides: Partial<PrivateBotRunRequest> = {}): PrivateBotRunRequest => ({
  ownerId: OWNER, botId: BOT, chatId: "chat_thread1", taskId: "task_0123456789abcdef", runId: "run_thread1",
  route: { api: "anthropic-messages", modelId: "claude-sonnet-5", input: ["text"], contextWindow: 200_000, maxOutputTokens: 4_096 },
  accessSourceId: "matrix_included", capabilities: ["brain.read"], requestClass: "interactive", brainProjectId: PROJECT, ...overrides,
});

describe("thread admission", () => {
  it("admits a thread with its own project and binds the project into the run", async () => {
    const { admission: admit, registry } = admission();
    const admitted = await admit.admit(request());
    expect(registry.lookupRun({ ...admitted, runId: "run_thread1" })).toMatchObject({ chatId: "chat_thread1", brainProjectId: PROJECT });
  });

  it("refuses a thread run with another or no project, and a direct run that names a project", async () => {
    for (const refused of [
      request({ brainProjectId: "proj_other" }),
      request({ brainProjectId: undefined }),
      request({ chatId: "chat_direct1" }),
      request({ chatId: "chat_plain1" }),
    ]) {
      const { admission: admit, client } = admission();
      await expect(admit.admit(refused)).rejects.toEqual(new BotAdmissionError("not_found"));
      expect(client.createRuntime).not.toHaveBeenCalled();
    }
    const { admission: admit } = admission();
    await expect(admit.admit(request({ chatId: "chat_direct1", brainProjectId: undefined }))).resolves.toMatchObject({ runtimeHandle: RUNTIME });
  });

  it("refuses a removed thread", async () => {
    await createBotBindingsRepository(db).remove({ ownerId: OWNER, botId: BOT, chatId: "chat_thread1", now: at(1) });
    const { admission: admit } = admission();
    await expect(admit.admit(request())).rejects.toEqual(new BotAdmissionError("not_found"));
  });
});

describe("thread navigation", () => {
  it("classifies threads as Bot chats, so they stay out of ordinary lists", async () => {
    const navigation = createChatNavigationRepository(db as unknown as Kysely<ChatDatabase>);
    const snapshot = await navigation.list({ type: "personal", ownerId: OWNER }, { version: 1, limit: 100 });
    const kinds = Object.fromEntries(snapshot.items.map((item) => [item.chat.id, item.classification]));
    expect(kinds).toEqual({
      chat_direct1: { kind: "bot", agentId: BOT },
      chat_thread1: { kind: "bot", agentId: BOT },
      chat_plain1: { kind: "ordinary" },
    });
  });
});
