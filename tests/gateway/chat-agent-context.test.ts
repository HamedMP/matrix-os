import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KyselyPGlite } from "kysely-pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { ChatAgentStore } from "../../packages/gateway/src/chat/agent-store.js";
import { ChatAgentContext, contextPrompt } from "../../packages/gateway/src/chat/agent-context.js";
import { jsonb } from "../../packages/gateway/src/chat/records.js";

const owner = { type: "personal" as const, ownerId: "owner_context" };
const request = {
  clientRequestId: "req_context", baseRevision: 0,
  selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
  interactionMode: "default", permissionMode: "full_access",
  parts: [{ type: "text" as const, text: "Prepare the next steps" }],
};
const mention = (kind: "agent" | "chat", id: string) => ({
  type: "resource_reference" as const, resource: { kind, id, label: "Forged label" },
});

describe("server-resolved Chat mention context", () => {
  let home: string;
  let repository: ChatRepository;
  let agents: ChatAgentStore;
  let context: ChatAgentContext;
  let enabled = true;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "matrix-chat-context-"));
    repository = new ChatRepository((await KyselyPGlite.create()).dialect);
    await repository.bootstrap();
    agents = new ChatAgentStore({ homePath: home, db: repository.kysely });
    await agents.bootstrap();
    enabled = true;
    context = new ChatAgentContext({ repository, agents, enabled: () => enabled });
    for (const id of ["chat_current", "chat_source"]) {
      await repository.create(owner, { id, clientRequestId: `req_${id}`, title: id === "chat_source" ? "Launch decisions" : "Current Chat" });
    }
    await repository.kysely.insertInto("chat_messages").values({
      id: "msg_source", chat_id: "chat_source", seq: 1, role: "user", state: "committed",
      turn_id: null, run_id: null, actor_id: null, purpose: "discussion",
      parts: jsonb([{ type: "text", text: "The partner review is on Thursday." },
        mention("chat", "chat_private")]), byte_count: 100,
      search_text: "The partner review is on Thursday.", created_at: new Date(),
    }).execute();
  });
  afterEach(async () => {
    await agents.close();
    await repository.kysely.destroy();
    await rm(home, { recursive: true, force: true });
  });

  it("resolves authorized transcript text and titles without expanding references recursively", async () => {
    const prepared = await context.prepare(owner, "chat_current", {
      ...request, parts: [...request.parts, mention("chat", "chat_source")],
    });
    expect(prepared.context?.chats).toEqual([{
      chatId: "chat_source", title: "Launch decisions", throughSeq: 1,
      text: "User: The partner review is on Thursday.", truncated: false,
    }]);
    const prompt = contextPrompt("Prepare the next steps", prepared.context);
    expect(prompt).toContain("The partner review is on Thursday.");
    expect(prompt).not.toContain("chat_private");
    expect(prompt).not.toContain("Forged label");
  });

  it("pins an Agent definition and execution route without mutating the request's default route", async () => {
    const agent = await agents.create(owner, {
      clientRequestId: "req_bot", name: "Meeting helper", description: "Prepare meeting briefs",
      instructions: "List decisions and owners.",
      selection: { instanceId: "hermes_default", model: "openai:gpt-5.6-sol" },
    });
    const input = { ...request, parts: [...request.parts, mention("agent", agent.id)] };
    const prepared = await context.prepare(owner, "chat_current", input);
    expect(prepared.selection).toEqual(agent.selection);
    expect(input.selection.instanceId).toBe("codex_default");
    expect(prepared.context?.agent).toMatchObject({ id: agent.id, name: "Meeting helper", revision: 1 });
    await agents.update(owner, agent.id, { baseRevision: 1, instructions: "New instructions" });
    expect(prepared.context?.agent?.instructions).toBe("List decisions and owners.");
    await context.revalidate(owner, "chat_current", prepared.context);
    await agents.update(owner, agent.id, { baseRevision: 2, archived: true });
    await expect(context.revalidate(owner, "chat_current", prepared.context)).rejects.toMatchObject({ code: "context_unavailable" });
  });

  it("fails closed for the disabled switch while ordinary Chat remains unchanged", async () => {
    enabled = false;
    await expect(context.prepare(owner, "chat_current", {
      ...request, parts: [...request.parts, mention("chat", "chat_source")],
    })).rejects.toMatchObject({ code: "feature_disabled" });
    const plain = await context.prepare(owner, "chat_current", request);
    expect(plain.context).toBeUndefined();
    expect(plain.selection).toEqual(request.selection);
    expect(contextPrompt("Ordinary prompt", plain.context)).toBe("Ordinary prompt");
  });

  it("rejects another owner, archived sources, self references and a revoked source at dispatch", async () => {
    await repository.create({ type: "personal", ownerId: "owner_other" }, {
      id: "chat_private", clientRequestId: "req_private", title: "Private",
    });
    for (const id of ["chat_private", "chat_current"]) {
      await expect(context.prepare(owner, "chat_current", { ...request, parts: [mention("chat", id)] }))
        .rejects.toMatchObject({ code: "context_unavailable" });
    }
    const prepared = await context.prepare(owner, "chat_current", { ...request, parts: [mention("chat", "chat_source")] });
    await repository.update(owner, "chat_source", { baseRevision: 0, lifecycle: "archived" });
    await expect(context.revalidate(owner, "chat_current", prepared.context)).rejects.toMatchObject({ code: "context_unavailable" });
    await expect(context.prepare(owner, "chat_current", { ...request, parts: [mention("chat", "chat_source")] }))
      .rejects.toMatchObject({ code: "context_unavailable" });
  });

  it("bounds source text, reports truncation, and never copies tool output", async () => {
    await repository.kysely.updateTable("chat_messages").set({
      parts: jsonb([{ type: "text", text: "x".repeat(20_000) }]),
    }).where("id", "=", "msg_source").execute();
    await repository.kysely.insertInto("chat_messages").values({
      id: "msg_tool", chat_id: "chat_source", seq: 2, role: "tool", state: "committed",
      turn_id: null, run_id: null, actor_id: null, purpose: "system",
      parts: jsonb([{ type: "text", text: "INTERNAL_TOOL_OUTPUT" }]), byte_count: 30,
      search_text: "", created_at: new Date(),
    }).execute();
    const prepared = await context.prepare(owner, "chat_current", { ...request, parts: [mention("chat", "chat_source")] });
    expect(prepared.context?.chats[0]?.text.length).toBeLessThanOrEqual(8_000);
    expect(prepared.context?.chats[0]?.truncated).toBe(true);
    expect(prepared.context?.chats[0]?.text).not.toContain("INTERNAL_TOOL_OUTPUT");
  });
});
