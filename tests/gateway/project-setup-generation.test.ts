import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KyselyPGlite } from "kysely-pglite";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";
import { adapter, catalog, owner, principal } from "./chat-orchestrator-test-support.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { CanonicalChatOrchestrator } from "../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry } from "../../packages/gateway/src/chat/provider-adapter.js";
import { initialProjectSetup } from "../../packages/gateway/src/chat/project-setup-state.js";
import { generateProjectSetup, syncProjectSetupGeneration } from "../../packages/gateway/src/chat/project-setup-generation.js";

const selection = { instanceId: "codex_default", model: "gpt-5.6-sol" };
const executionRootFingerprint = "a".repeat(64);
describe("admitted project setup generation", () => {
  let pg: InstanceType<typeof KyselyPGlite>;
  let repository: ChatRepository;
  beforeEach(async () => { pg = await createTestPGlite(); repository = new ChatRepository(pg.dialect); await repository.bootstrap(); });
  afterEach(async () => { await repository.kysely.destroy(); });
  it("starts a fresh restricted run instead of resuming a broader native session and binds its result", async () => {
    await repository.create(owner, { id: "chat_setup", clientRequestId: "req_create", title: "Project setup", projectId: "project_a" });
    const start = vi.fn(async function* () {
      yield { type: "state.updated" as const, state: { sessionId: "native_session" } };
      yield { type: "assistant.delta" as const, messageId: "process", delta: "I will draft your project guidance for review." };
      yield { type: "assistant.delta" as const, messageId: "result", delta: JSON.stringify({ guidance: "# Project guidance\n\nRun the relevant checks." }) };
      yield { type: "run.completed" as const, outcome: "completed" as const };
    });
    const resume = vi.fn(async function* () { yield { type: "run.completed" as const, outcome: "completed" as const }; });
    const provider = { ...adapter(start), resume };
    const available = catalog(); available.instances[0]!.supports.interactionModes.push("review");
    const catalogs = { getCatalog: async () => available };
    const roots = { resolve: async () => ({ ref: { kind: "project" as const, projectId: "project_a" }, fingerprint: executionRootFingerprint, primaryWorkspaceRoot: "/safe/project", projectSlug: "project-a" }),
      revalidate: async () => ({ ref: { kind: "project" as const, projectId: "project_a" }, fingerprint: executionRootFingerprint, primaryWorkspaceRoot: "/safe/project", projectSlug: "project-a" }) };
    const orchestrator = new CanonicalChatOrchestrator({ repository, catalog: catalogs, adapters: new CanonicalChatProviderRegistry([provider]), executionRoots: roots });
    try {
      await orchestrator.admitTurn(principal, owner, "chat_setup", { clientRequestId: "req_ordinary", baseRevision: 0,
        parts: [{ type: "text", text: "An ordinary earlier turn" }], selection, interactionMode: "default", permissionMode: "supervised" });
      await orchestrator.drain();
      const latestCheckpoint = vi.spyOn(repository, "getLatestAdapterStateForChat");
      const draft = { ...initialProjectSetup("chat_setup", "project_a", "Portfolio", "msg_question"), revision: 7 };
      const generation = await generateProjectSetup({ repository, orchestrator, catalog: catalogs }, principal, owner, draft, selection, "req_generate", executionRootFingerprint);
      await orchestrator.drain();
      expect(latestCheckpoint).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled(); expect(start).toHaveBeenCalledTimes(2);
      const run = await repository.kysely.selectFrom("chat_runs").selectAll().where("id", "=", generation.runId!).executeTakeFirstOrThrow();
      expect(run.permission_mode).toBe("supervised"); expect(run.interaction_mode).toBe("review");
      expect(run.context_snapshot).toMatchObject({ projectSetupDraft: { revision: 7 } });
      const result = await syncProjectSetupGeneration(repository, owner, { ...draft, generation }, executionRootFingerprint);
      expect(result.generation?.status).toBe("completed"); expect(result.proposals[0]?.content).toContain("relevant checks");
      await expect(syncProjectSetupGeneration(repository, owner, { ...draft, generation: { ...generation, sourceRevision: 8 } }, executionRootFingerprint)).rejects.toMatchObject({ kind: "conflict" });
      const pending = { ...draft, generation: { status: "pending" as const } };
      await expect(syncProjectSetupGeneration(repository, owner, pending, "b".repeat(64), "req_generate")).rejects.toMatchObject({ kind: "conflict" });
      await expect(syncProjectSetupGeneration(repository, { ...owner, ownerId: "other_user" }, pending, executionRootFingerprint, "req_generate")).resolves.toBe(pending);
    } finally { await orchestrator.close(); }
  });
  it("retries a failed draft through Project Setup without admitting a detached Chat retry", async () => {
    const chatId = "chat_setup_retry";
    const projectId = "project_a";
    await repository.create(owner, { id: chatId, clientRequestId: "req_create_retry", title: "Project setup", projectId });
    const start = vi.fn<Parameters<typeof adapter>[0]>(async function* () {
      yield { type: "assistant.delta" as const, messageId: "result", delta: JSON.stringify({ guidance: "# Project guidance\n\nVerify the change." }) };
      yield { type: "run.completed" as const, outcome: "completed" as const };
    }).mockImplementationOnce(async function* () {
      yield { type: "run.completed" as const, outcome: "failed" as const };
    });
    const available = catalog(); available.instances[0]!.supports.interactionModes.push("review");
    const catalogs = { getCatalog: vi.fn(async () => available) };
    const root = { ref: { kind: "project" as const, projectId }, fingerprint: executionRootFingerprint, primaryWorkspaceRoot: "/safe/project", projectSlug: "project-a" };
    const orchestrator = new CanonicalChatOrchestrator({ repository, catalog: catalogs,
      adapters: new CanonicalChatProviderRegistry([adapter(start)]), executionRoots: { resolve: async () => root, revalidate: async () => root } });
    try {
      const draft = { ...initialProjectSetup(chatId, projectId, "Portfolio", "msg_question"), step: "review" as const };
      const deps = { repository, orchestrator, catalog: catalogs };
      const generation = await generateProjectSetup(deps, principal, owner, draft, selection, "req_first_draft", executionRootFingerprint);
      await orchestrator.drain();
      const failed = await syncProjectSetupGeneration(repository, owner, { ...draft, generation }, executionRootFingerprint);
      expect(failed.generation?.status).toBe("failed");
      const turn = await repository.kysely.selectFrom("chat_runs").select("turn_id").where("id", "=", generation.runId!).executeTakeFirstOrThrow();
      const record = (await repository.get(owner, chatId))!;
      catalogs.getCatalog.mockClear();
      await expect(orchestrator.retryTurn(principal, owner, chatId, turn.turn_id, {
        clientRequestId: "req_canonical_retry", baseRevision: record.chat.revision,
      })).rejects.toMatchObject({ status: 409, safeError: { code: "run_unavailable", retryable: false, recoveryActions: [] } });
      expect(catalogs.getCatalog).not.toHaveBeenCalled();
      expect(start).toHaveBeenCalledTimes(1);
      const regenerated = await generateProjectSetup(deps, principal, owner, failed, selection, "req_retry_draft", executionRootFingerprint);
      await orchestrator.drain();
      expect(regenerated.runId).not.toBe(generation.runId);
      const result = await syncProjectSetupGeneration(repository, owner, { ...failed, generation: regenerated }, executionRootFingerprint);
      expect(result.generation?.status).toBe("completed");
      expect(result.answers).toEqual(draft.answers);
      expect(result.proposals[0]?.content).toContain("Verify the change.");
    } finally { await orchestrator.close(); }
  });
  it("declines unqualified drafting modes before admission", async () => {
    const admitTurn = vi.fn();
    const generation = await generateProjectSetup({ repository, orchestrator: { admitTurn }, catalog: { getCatalog: async () => catalog() } }, principal, owner,
      initialProjectSetup("chat_setup", "project_a", "Portfolio", "msg_question"), selection, "req_generate", executionRootFingerprint);
    expect(generation.status).toBe("unavailable"); expect(admitTurn).not.toHaveBeenCalled();
  });
});
