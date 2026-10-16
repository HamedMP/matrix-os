import type { BotModelRoute, BotRunSpec } from "@matrix-os/contracts";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotBrainProjects } from "../../../packages/gateway/src/bots/brain-projects.js";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { createBotStateTransactions } from "../../../packages/gateway/src/bots/events.js";
import { createBotRecipeCatalog } from "../../../packages/gateway/src/bots/recipe-catalog.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { BotRuntimeRegistry } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { MATRIX_BOT_SELECTION } from "../../../packages/gateway/src/bots/selection.js";
import { createBotTaskOrchestrator } from "../../../packages/gateway/src/bots/task-orchestrator.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { BOT, NOW, OWNER, createBotStateDatabase, insertChat } from "./bot-state-support.js";

const THREAD = "chat_brainthread1";
const DIRECT = "chat_braindirect1";
const PROJECT = "proj_brain01";
const RUNTIME = `runtime_${"c".repeat(32)}`;
const ROUTE: BotModelRoute = { api: "anthropic-messages", modelId: "claude-sonnet-5", input: ["text"], contextWindow: 200_000, maxOutputTokens: 8_192 };
const brainRecipe = createBotRecipeCatalog().resolve({ recipeId: "company-brain", version: "2026-10-08.1" });
const AGENT = {
  id: BOT, name: "Company Brain", description: "", instructions: brainRecipe.instructions, archived: false, selection: MATRIX_BOT_SELECTION,
  recipeRef: { recipeId: brainRecipe.recipeId, version: brainRecipe.version }, revision: 1, createdAt: NOW, updatedAt: NOW,
};

let db: Kysely<OwnerBotDatabase>;
let destroy: () => Promise<void>;

beforeEach(async () => {
  ({ db, destroy } = await createBotStateDatabase());
  await insertChat(db, THREAD);
  await insertChat(db, DIRECT);
  const bindings = createBotBindingsRepository(db);
  await bindings.bindDirect({ ownerId: OWNER, botId: BOT, chatId: DIRECT, now: NOW });
  await bindings.bindThread({ ownerId: OWNER, botId: BOT, chatId: THREAD, projectId: PROJECT, now: NOW });
});
afterEach(async () => destroy());

function setup(options: { agent?: Record<string, unknown>; projects?: Partial<BotBrainProjects> } = {}) {
  const registry = new BotRuntimeRegistry();
  const admission = {
    admit: vi.fn(async (request: Parameters<typeof registry.bind>[0]) => {
      registry.bind({ ...request, runtimeHandle: RUNTIME, executionGeneration: "1", rootFingerprint: "f".repeat(64) });
      return { runtimeHandle: RUNTIME, executionGeneration: "1", rootFingerprint: "f".repeat(64) };
    }),
    release: vi.fn(async (handle: string) => registry.release(handle)),
  };
  const specs: BotRunSpec[] = [];
  const bound: unknown[] = [];
  const executorReady = vi.fn(async () => true);
  let orchestrator: ReturnType<typeof createBotTaskOrchestrator>;
  const runBot = vi.fn(async (input: { runtimeHandle: string; executionGeneration: string; command: { kind: string; runId: string } }) => {
    const binding = registry.lookupRun({ ...input, runId: input.command.runId });
    bound.push(binding);
    specs.push(await orchestrator.runSource.loadRunSpec(binding!));
    return { ok: true as const, reply: { runId: input.command.runId, status: "completed", toolActions: 0, sessionRevision: 1 } };
  });
  const projects: BotBrainProjects = {
    resolve: vi.fn(async () => ({ projectId: PROJECT, slug: "matrix-os", name: "Matrix OS" })),
    slugs: vi.fn(async () => ["matrix-os", "docs"]),
    ...options.projects,
  };
  orchestrator = createBotTaskOrchestrator({
    bindings: createBotBindingsRepository(db),
    transact: createBotStateTransactions(new ChatRepository(db as unknown as Kysely<ChatDatabase>)),
    memory: { admitted: vi.fn(async () => ["The owner likes long answers."]) },
    agents: { get: vi.fn(async () => (options.agent ?? AGENT) as never) },
    recipes: createBotRecipeCatalog(),
    resolveRoute: async () => ({ route: ROUTE, accessSourceId: "matrix_included" as const }),
    executorReady,
    admission,
    registry,
    client: { runBot: runBot as never },
    brainProjects: projects,
  });
  const run = (chatId: string) => orchestrator.start({ ownerId: OWNER, chatId, runId: `run_${chatId.slice(5)}`, text: "What changed this week?", signal: new AbortController().signal }).result;
  return { run, admission, specs, bound, executorReady, projects };
}

describe("company brain runs", () => {
  it("runs a thread with only brain.read, the recipe limits and the thread's project bound into admission", async () => {
    const { run, admission, specs, bound, executorReady } = setup();
    await expect(run(THREAD)).resolves.toMatchObject({ status: "completed" });
    expect(executorReady).not.toHaveBeenCalled();
    expect(specs[0]).toMatchObject({ capabilities: ["brain.read"], limits: { maxToolActions: 6, effort: "low" } });
    expect(specs[0]!.systemPrompt).toContain("Project: \"Matrix OS\" (proj_brain01). It is fixed for this chat; do not pass a project.");
    expect(specs[0]!.systemPrompt).not.toContain("long answers");
    expect(admission.admit).toHaveBeenCalledWith(expect.objectContaining({ chatId: THREAD, capabilities: ["brain.read"], brainProjectId: PROJECT }));
    expect(bound[0]).toMatchObject({ brainProjectId: PROJECT, capabilities: ["brain.read"] });
  });

  it("runs the bot's direct chat across projects, listing the owner's projects and binding none", async () => {
    const { run, admission, specs, projects } = setup();
    await expect(run(DIRECT)).resolves.toMatchObject({ status: "completed" });
    expect(specs[0]!.systemPrompt).toContain("Projects you can ask about (pass the slug as project): matrix-os, docs.");
    expect(projects.slugs).toHaveBeenCalledWith(OWNER, 20);
    expect(admission.admit.mock.calls[0]![0]).not.toHaveProperty("brainProjectId");
  });

  it("keeps running with only the project id when the project lookup fails", async () => {
    const { run, specs } = setup({ projects: { resolve: vi.fn(async () => { throw new Error("lookup down"); }) } });
    await expect(run(THREAD)).resolves.toMatchObject({ status: "completed" });
    expect(specs[0]!.systemPrompt).toContain("Project: proj_brain01. It is fixed for this chat; do not pass a project.");
  });

  it("never runs a thread for a recipe without threads", async () => {
    const writingBot = { ...AGENT, name: "Writing Bot", recipeRef: { recipeId: "writing-bot", version: "2026-09-27.1" } };
    const { run, admission } = setup({ agent: writingBot });
    await expect(run(THREAD)).resolves.toEqual({ status: "failed" });
    expect(admission.admit).not.toHaveBeenCalled();
    expect(await db.selectFrom("bot_tasks").select("task_id").execute()).toEqual([]);
  });
});
