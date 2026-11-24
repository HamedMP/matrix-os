import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KyselyPGlite } from "kysely-pglite";
import type { ProjectSetupAction, ProjectSetupResponse, ProjectSetupUpdateRequest } from "@matrix-os/contracts";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { ProjectSetupService, type ProjectSetupServiceOptions } from "../../packages/gateway/src/chat/project-setup-service.js";
import type { ChatExecutionRootResolver } from "../../packages/gateway/src/chat/execution-root.js";
import type { ProjectSetupWorkspace } from "../../packages/gateway/src/chat/project-setup-workspace.js";
import { ProjectSetupRepository } from "../../packages/gateway/src/chat/project-setup-repository.js";
import { CanonicalChatOrchestrator } from "../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry } from "../../packages/gateway/src/chat/provider-adapter.js";
import { adapter, catalog } from "./chat-orchestrator-test-support.js";

const owner = { type: "personal" as const, ownerId: "user_a" };
const principal = { userId: owner.ownerId, source: "configured-container" as const };
const manifest = '---\nname: release-check\ndescription: Review the release\n---\n\nCheck the release notes and relevant tests.\n';
describe("project setup service integration", () => {
  let pg: InstanceType<typeof KyselyPGlite>;
  let repository: ChatRepository;
  let service: ProjectSetupService;
  let options: ProjectSetupServiceOptions;
  let files: Map<string, string>;
  let generation = 1;
  let request = 0;
  let create: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    pg = await createTestPGlite(); repository = new ChatRepository(pg.dialect); await repository.bootstrap();
    files = new Map(); generation = 1; request = 0;
    create = vi.fn(async (projectId: string, path: string, content: string) => {
      const key = `${projectId}/${path}`;
      if (files.has(key)) throw Object.assign(new Error("Exists"), { code: "EEXIST" });
      files.set(key, content);
    });
    options = { repository, homePath: "/tmp/project-setup-tests", executionRoots: {} as ChatExecutionRootResolver,
      openWorkspace: async (scope, projectId): Promise<ProjectSetupWorkspace> => {
        if (scope.ownerId !== owner.ownerId) throw new Error("Unrelated owner");
        return { fingerprint: String(generation).repeat(64), executionRootFingerprint: "a".repeat(64), projectSlug: projectId,
          read: async path => files.get(`${projectId}/${path}`) ?? null,
          create: (path, content) => create(projectId, path, content), revalidate: async () => {}, close: async () => {} };
      } };
    service = new ProjectSetupService(options);
  });
  afterEach(async () => { await repository.kysely.destroy(); });
  const next = (current: ProjectSetupResponse, action: ProjectSetupAction) => service.update(principal, owner, current.draft!.chatId,
    { baseRevision: current.draft!.revision, clientRequestId: `req_action_${++request}`, action });

  it("completes the staged manifest flow through canonical Chat and explicit save", async () => {
    expect((await service.getProject(owner, "project_a")).draft).toBeNull();
    expect(await repository.kysely.selectFrom("chats").select("id").execute()).toHaveLength(0);
    let current = await service.start(owner, "project_a", { clientRequestId: "req_start", answer: "A portfolio website" });
    current = await next(current, { type: "answer", text: "Keep changes small and run checks" });
    current = await next(current, { type: "stage_skill", content: manifest });
    current = await next(current, { type: "choose_mcp", choice: "skip" });
    expect(current.draft?.step).toBe("review"); expect(create).not.toHaveBeenCalled();
    current = await next(current, { type: "save" });
    expect(current.draft?.step).toBe("saved");
    expect([...files.keys()]).toEqual(["project_a/AGENTS.md", "project_a/CLAUDE.md", "project_a/.agents/skills/release-check/SKILL.md"]);
    expect(files.get("project_a/.agents/skills/release-check/SKILL.md")).toBe(manifest);
    const resumed = await service.getProject(owner, "project_a"); expect(resumed.draft?.chatId).toBe(current.draft?.chatId);
    expect(resumed.draft?.step).toBe("saved");
    const transcript = await repository.getDetailPage(owner, current.draft!.chatId, { limit: 100 });
    expect(transcript?.turns.length).toBe(5); expect(transcript?.runs).toHaveLength(0);
    expect(transcript?.messages.every(message => Boolean(message.turnId))).toBe(true);
  });
  it.each(["AGENTS.md", "CLAUDE.md"])("preserves an existing empty %s when rebuilding Review and saving", async path => {
    files.set(`project_a/${path}`, "");
    let current = await service.start(owner, "project_a", { clientRequestId: "req_start", answer: "A portfolio website" });
    current = await next(current, { type: "answer", text: "Run checks" });
    current = await next(current, { type: "choose_skill", choice: "skip" });
    current = await next(current, { type: "choose_mcp", choice: "skip" });
    const original = current.draft?.proposals.find(file => file.path === path);
    expect(original).toMatchObject({ content: "", status: "already_present", expectedHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" });
    current = await next(current, { type: "prepare_review" });
    expect(current.draft?.proposals.find(file => file.path === path)).toEqual(original);
    current = await next(current, { type: "save" });
    expect(current.draft?.step).toBe("saved");
    expect(files.get(`project_a/${path}`)).toBe("");
    expect(create.mock.calls.map(call => call[1])).not.toContain(path);
  });
  it("rejects a stale checkout confirmation before any file write", async () => {
    let current = await service.start(owner, "project_a", { clientRequestId: "req_start", answer: "Project A" });
    current = await next(current, { type: "answer", text: "Use concise instructions" });
    current = await next(current, { type: "choose_skill", choice: "skip" });
    current = await next(current, { type: "choose_mcp", choice: "skip" });
    generation = 2;
    await expect(next(current, { type: "save" })).rejects.toThrow(); expect(create).not.toHaveBeenCalled();
    expect((await service.getProject(owner, "project_b")).draft).toBeNull();
  });
  it.each(["retry", "sync"])("recovers the accepted generation after a lost link through %s", async recovery => {
    const release = Promise.withResolvers<void>();
    const start = vi.fn(async function* () {
      await release.promise;
      yield { type: "assistant.delta" as const, messageId: "result", delta: JSON.stringify({ guidance: "# Guidance\n\nRun the release checks." }) };
      yield { type: "run.completed" as const, outcome: "completed" as const };
    });
    const available = catalog();
    available.instances[0]!.supports.interactionModes.push("review");
    const catalogs = { getCatalog: vi.fn(async () => available) };
    const root = { ref: { kind: "project" as const, projectId: "project_a" }, fingerprint: "a".repeat(64),
      primaryWorkspaceRoot: "/safe/project-a", projectSlug: "project_a" };
    const roots = { resolve: async () => root, revalidate: async () => root };
    const orchestrator = new CanonicalChatOrchestrator({ repository, catalog: catalogs,
      adapters: new CanonicalChatProviderRegistry([adapter(start)]), executionRoots: roots });
    let pendingBeforeAdmission: ProjectSetupResponse | undefined;
    let pendingPoll: ProjectSetupResponse | undefined;
    const admitTurn = vi.fn(async (...args: Parameters<typeof orchestrator.admitTurn>) => {
      pendingBeforeAdmission = await service.getChat(owner, args[2]);
      pendingPoll = await next(pendingBeforeAdmission, { type: "sync_generation" });
      return orchestrator.admitTurn(...args);
    });
    service = new ProjectSetupService({ ...options, generation: { repository, orchestrator: { admitTurn }, catalog: catalogs } });
    const link = vi.spyOn(ProjectSetupRepository.prototype, "linkGeneration").mockRejectedValueOnce(new Error("Interrupted before linking"));
    try {
      let current = await service.start(owner, "project_a", { clientRequestId: "req_start", answer: "A portfolio" });
      current = await next(current, { type: "answer", text: "Keep edits small" });
      current = await next(current, { type: "choose_skill", choice: "skip" });
      current = await next(current, { type: "choose_mcp", choice: "skip" });
      const chatId = current.draft!.chatId;
      const request: ProjectSetupUpdateRequest = { clientRequestId: "req_generate", baseRevision: current.draft!.revision,
        action: { type: "generate", selection: { instanceId: "codex_default", model: "gpt-5.6-sol" } } };
      await expect(service.update(principal, owner, chatId, request)).rejects.toThrow("Interrupted before linking");
      current = await service.getChat(owner, chatId);
      expect(current.draft?.generation?.status).toBe("pending");
      const { id: runId } = await repository.kysely.selectFrom("chat_runs").select("id").where("chat_id", "=", chatId).executeTakeFirstOrThrow();
      catalogs.getCatalog.mockClear();

      current = recovery === "retry" ? await service.update(principal, owner, chatId, request) : await next(current, { type: "sync_generation" });
      expect(current.draft?.generation).toEqual({ status: "running", runId, sourceRevision: request.baseRevision + 1 });
      expect(pendingPoll?.draft).toEqual(pendingBeforeAdmission?.draft);
      expect(catalogs.getCatalog).not.toHaveBeenCalled();
      expect(admitTurn).toHaveBeenCalledTimes(1);
      release.resolve();
      await orchestrator.drain();
      current = await next(current, { type: "sync_generation" });
      expect(current.draft?.generation).toMatchObject({ runId, status: "completed" });
      expect(current.draft?.proposals[0]?.content).toContain("Run the release checks.");
      expect(await repository.kysely.selectFrom("chat_runs").select("id").where("chat_id", "=", chatId).execute()).toEqual([{ id: runId }]);
      expect(start).toHaveBeenCalledTimes(1);
    } finally {
      link.mockRestore();
      release.resolve();
      await orchestrator.close();
    }
  });
  it("records unavailable generation without pretending that a model run occurred", async () => {
    let current = await service.start(owner, "project_a", { clientRequestId: "req_start", answer: "A portfolio" });
    current = await next(current, { type: "answer", text: "Keep edits small" });
    current = await next(current, { type: "choose_skill", choice: "skip" });
    current = await next(current, { type: "choose_mcp", choice: "connect", service: "Linear" });
    current = await next(current, { type: "generate", selection: { instanceId: "codex_default", model: "gpt-6.1-sol" } });
    expect(current.draft?.generation?.status).toBe("unavailable"); expect(current.draft?.mcp.state).toBe("pending");
    expect(await repository.kysely.selectFrom("chat_runs").select("id").execute()).toHaveLength(0); expect(create).not.toHaveBeenCalled();
  });
});
