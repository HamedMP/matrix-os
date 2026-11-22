import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KyselyPGlite } from "kysely-pglite";
import type { ProjectSetupAction, ProjectSetupResponse } from "@matrix-os/contracts";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { ProjectSetupService } from "../../packages/gateway/src/chat/project-setup-service.js";
import type { ChatExecutionRootResolver } from "../../packages/gateway/src/chat/execution-root.js";
import type { ProjectSetupWorkspace } from "../../packages/gateway/src/chat/project-setup-workspace.js";

const owner = { type: "personal" as const, ownerId: "user_a" };
const principal = { userId: owner.ownerId, source: "configured-container" as const };
const manifest = '---\nname: release-check\ndescription: Review the release\n---\n\nCheck the release notes and relevant tests.\n';
describe("project setup service integration", () => {
  let pg: InstanceType<typeof KyselyPGlite>;
  let repository: ChatRepository;
  let service: ProjectSetupService;
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
    service = new ProjectSetupService({ repository, homePath: "/tmp/project-setup-tests", executionRoots: {} as ChatExecutionRootResolver,
      openWorkspace: async (scope, projectId): Promise<ProjectSetupWorkspace> => {
        if (scope.ownerId !== owner.ownerId) throw new Error("Unrelated owner");
        return { fingerprint: String(generation).repeat(64), projectSlug: projectId,
          read: async path => files.get(`${projectId}/${path}`) ?? null,
          create: (path, content) => create(projectId, path, content), revalidate: async () => {}, close: async () => {} };
      } });
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
  it("rejects a stale checkout confirmation before any file write", async () => {
    let current = await service.start(owner, "project_a", { clientRequestId: "req_start", answer: "Project A" });
    current = await next(current, { type: "answer", text: "Use concise instructions" });
    current = await next(current, { type: "choose_skill", choice: "skip" });
    current = await next(current, { type: "choose_mcp", choice: "skip" });
    generation = 2;
    await expect(next(current, { type: "save" })).rejects.toThrow(); expect(create).not.toHaveBeenCalled();
    expect((await service.getProject(owner, "project_b")).draft).toBeNull();
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
