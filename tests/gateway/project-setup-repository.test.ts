import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KyselyPGlite } from "kysely-pglite";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { ProjectSetupRepository } from "../../packages/gateway/src/chat/project-setup-repository.js";
import { Kysely } from "kysely";
import type { ChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { jsonb } from "../../packages/gateway/src/chat/records.js";
import { transitionProjectSetup } from "../../packages/gateway/src/chat/project-setup-state.js";

const owner = { type: "personal" as const, ownerId: "user_a" };
const root = "a".repeat(64);
describe("Chat-owned project setup draft", () => {
  let pg: InstanceType<typeof KyselyPGlite>;
  let chats: ChatRepository;
  let setup: ProjectSetupRepository;
  let locks: string[];
  beforeEach(async () => {
    locks = [];
    pg = await createTestPGlite();
    const db = new Kysely<ChatDatabase>({ dialect: pg.dialect, log: event => {
      if (event.level === "query" && event.query.sql.endsWith("for update") && locks.length < 32) locks.push(event.query.sql);
    } });
    chats = new ChatRepository(db); await chats.bootstrap(); setup = new ProjectSetupRepository(chats);
  });
  afterEach(async () => { await chats.kysely.destroy(); });
  it("creates one scoped Chat and durable ordinary transcript on the first answer", async () => {
    const first = await setup.start(owner, "project_a", root, { clientRequestId: "req_first", answer: "A portfolio" });
    const repeat = await setup.start(owner, "project_a", root, { clientRequestId: "req_repeat", answer: "A portfolio" });
    expect(repeat.draft?.chatId).toBe(first.draft?.chatId);
    const page = await chats.getDetailPage(owner, first.draft!.chatId, { limit: 30 });
    expect(page?.messages.map(m => m.role)).toEqual(["user", "assistant"]);
    expect(page?.messages[0]?.parts).toEqual([{ type: "text", text: "A portfolio" }]);
    expect((await chats.kysely.selectFrom("chats").select("id").execute()).length).toBe(1);
  });
  it("links generation with the same Chat-before-draft lock order as mutations", async () => {
    let response = await setup.start(owner, "project_a", root, { clientRequestId: "req_first", answer: "Portfolio" });
    const actions = [
      { type: "answer", text: "Run checks" },
      { type: "choose_skill", choice: "skip" },
      { type: "choose_mcp", choice: "skip" },
      { type: "generate", selection: { instanceId: "codex_default", model: "test-model" } },
    ] as const;
    for (const [index, action] of actions.entries()) {
      const request = { baseRevision: response.draft!.revision, clientRequestId: `req_action_${index}`, action };
      response = await setup.mutate(owner, response.draft!.chatId, root, request, draft => transitionProjectSetup(draft, action));
    }
    locks.length = 0;
    await setup.linkGeneration(owner, response.draft!.chatId, root, "req_action_3", { status: "unavailable" });
    expect(locks[0]).toContain('from "chats"');
    expect(locks[1]).toContain('from "chat_project_setups"');
  });
  it("enforces owner/root authority and independent project draft state", async () => {
    const a = await setup.start(owner, "project_a", root, { clientRequestId: "req_a", answer: "Project A" });
    await setup.start(owner, "project_b", root, { clientRequestId: "req_b", answer: "Project B" });
    expect(await setup.getByProject({ ...owner, ownerId: "user_b" }, "project_a", root)).toBeNull();
    expect(await setup.getByProject(owner, "project_a", "b".repeat(64))).toBeNull();
    await expect(setup.getByChat({ ...owner, ownerId: "user_b" }, a.draft!.chatId, root)).rejects.toThrow();
    expect((await setup.getByProject(owner, "project_b", root))?.answers.purpose).toBe("Project B");
  });
  it("denies organization owners and collaboration-bound Chats", async () => {
    await expect(setup.start({ type: "organization", ownerId: owner.ownerId }, "project_a", root,
      { clientRequestId: "req_org", answer: "Organization" })).rejects.toThrow();
    const first = await setup.start(owner, "project_a", root, { clientRequestId: "req_first", answer: "Portfolio" });
    await chats.kysely.updateTable("chats").set({ collaboration: jsonb({ mode: "shared", membership: { role: "owner", memberCount: 2 } }) })
      .where("id", "=", first.draft!.chatId).execute();
    expect(await setup.getByProject(owner, "project_a", root)).toBeNull();
    await expect(setup.getByChat(owner, first.draft!.chatId, root)).rejects.toThrow();
  });

  it("does not resume a moved or archived setup Chat through the original project", async () => {
    const input = { clientRequestId: "req_first", answer: "Portfolio" };
    const first = await setup.start(owner, "project_a", root, input);
    await chats.kysely.updateTable("chats").set({ project_id: "project_b" }).where("id", "=", first.draft!.chatId).execute();
    expect(await setup.getByProject(owner, "project_a", root)).toBeNull();
    await expect(setup.getByChat(owner, first.draft!.chatId, root)).rejects.toThrow();
    await expect(setup.start(owner, "project_a", root, input)).rejects.toThrow();
    await chats.kysely.updateTable("chats").set({ project_id: "project_a", lifecycle: "archived" }).where("id", "=", first.draft!.chatId).execute();
    expect(await setup.getByProject(owner, "project_a", root)).toBeNull();
    await expect(setup.start(owner, "project_a", root, input)).rejects.toThrow();
  });

  it("CAS guards mutations and uncertain request retries do not duplicate messages", async () => {
    const first = await setup.start(owner, "project_a", root, { clientRequestId: "req_first", answer: "A portfolio" });
    const request = { baseRevision: 0, clientRequestId: "req_guidance", action: { type: "answer" as const, text: "Ask before publishing" } };
    const updated = await setup.mutate(owner, first.draft!.chatId, root, request, draft => transitionProjectSetup(draft, request.action));
    const retried = await setup.mutate(owner, first.draft!.chatId, root, request, draft => transitionProjectSetup(draft, request.action));
    expect(retried.draft?.revision).toBe(updated.draft?.revision);
    expect(retried.draft?.step).toBe("skill");
    await expect(setup.mutate(owner, first.draft!.chatId, root, { ...request, clientRequestId: "req_stale" }, draft => transitionProjectSetup(draft, request.action))).rejects.toThrow();
    const page = await chats.getDetailPage(owner, first.draft!.chatId, { limit: 30 });
    expect(page?.messages).toHaveLength(4);
  });
});
