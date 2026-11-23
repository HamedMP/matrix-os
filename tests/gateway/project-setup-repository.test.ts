import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KyselyPGlite } from "kysely-pglite";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { ProjectSetupRepository } from "../../packages/gateway/src/chat/project-setup-repository.js";
import { Kysely } from "kysely";
import type { ChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { jsonb } from "../../packages/gateway/src/chat/records.js";
import { PROJECT_SETUP_QUESTIONS, transitionProjectSetup } from "../../packages/gateway/src/chat/project-setup-state.js";
import type { CanonicalChatTransportFrame } from "@matrix-os/contracts";
import { createCanonicalChatEventStream } from "../../packages/gateway/src/chat/event-stream.js";
import { captureChatContent } from "../../packages/gateway/src/chat/content-projection.js";
import { applyCanonicalChatContent } from "../../packages/ui/src/canonical-chat-content.js";

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
  it("updates an open Chat with each committed setup answer and its matching assistant question", async () => {
    let response = await setup.start(owner, "project_a", root, { clientRequestId: "req_first", answer: "Portfolio" });
    const chatId = response.draft!.chatId;
    let visible = (await chats.getDetailPage(owner, chatId, { limit: 30 }))!;
    const stream = createCanonicalChatEventStream({ repository: chats });
    const frames: CanonicalChatTransportFrame[] = [];
    try {
      await stream.open({
        principal: { userId: owner.ownerId, source: "jwt" },
        content: true,
        sink: { send: frame => { frames.push(frame); return true; }, close: () => {} },
      });

      const actions = [
        { type: "answer", text: "Keep changes small and check them before release" },
        { type: "choose_skill", choice: "create" },
        { type: "answer", text: "Review the diff and summarize any skipped checks" },
        { type: "choose_mcp", choice: "connect", service: "Linear" },
      ] as const;
      for (const [index, action] of actions.entries()) {
        response = await setup.mutate(owner, chatId, root, {
          baseRevision: response.draft!.revision, clientRequestId: `req_action_${index}`, action,
        }, draft => transitionProjectSetup(draft, action));
        const frame = frames.at(-1);
        if (frame?.type !== "chat.content") throw new Error("Expected a committed Chat content frame");
        // Older gateways used the ordinary chat.updated projection for setup and
        // sent only metadata for a turn with no model Run.
        const legacyContent = await captureChatContent(
          chats.kysely, owner, chatId, "chat.updated", {}, (scope, id) => chats.get(scope, id),
        );
        expect(legacyContent?.messages).toEqual([]);
        expect(applyCanonicalChatContent(visible, { ...frame, content: legacyContent! })).toBeNull();
        const next = applyCanonicalChatContent(visible, frame);
        expect(next).not.toBeNull();
        visible = next!;
        expect(visible.messages.slice(-2).map(message => message.role)).toEqual(["user", "assistant"]);
        expect(visible.messages.at(-1)?.id).toBe(response.draft?.currentQuestionMessageId);
        expect(visible.turns.at(-1)?.inputMessageId).toBe(visible.messages.at(-2)?.id);
      }
      expect(visible.messages).toHaveLength(10);
      expect(visible.messages[6]?.parts).toEqual([{ type: "text", text: actions[2].text }]);
      expect(visible.messages[7]?.parts).toEqual([{ type: "text", text: "I’ll draft the skill from those steps when we review your setup.\n\n" + PROJECT_SETUP_QUESTIONS.mcp }]);
      expect(response.draft?.mcp).toEqual({ state: "pending", service: "Linear" });
      expect(visible.messages.at(-1)?.parts).toEqual([{
        type: "text", text: "Let’s connect Linear.\n\nOpen MCP Settings on this computer and return here after authorization.",
      }]);
      const reopened = await chats.getDetailPage(owner, chatId, { limit: 30 });
      expect(visible.messages).toEqual(reopened?.messages);
      expect(visible.turns).toEqual(reopened?.turns);
      expect(visible.runs).toEqual([]);
    } finally {
      stream.shutdown();
    }
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
