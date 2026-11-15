import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { matrixPiSelection, resolveVoiceChat } from "../../../packages/gateway/src/live-companion/voice-chat.js";

const owner = { type: "personal" as const, ownerId: "alice" };
const principal = { userId: "alice", source: "jwt" as const };
const pi = { instanceId: "matrix_pi_default", model: "glm-flash" };
const claude = { instanceId: "claude_default", model: "claude-sonnet-4-6" };
let repository: ChatRepository;

beforeEach(async () => {
  const db = await KyselyPGlite.create();
  repository = new ChatRepository(db.dialect);
  await repository.bootstrap();
});
afterEach(async () => { await repository.release(); await repository.kysely.destroy(); });

async function chat(id: string, selection: typeof pi, extra: { projectId?: string } = {}) {
  await repository.create(owner, { id, clientRequestId: `req_${id}`, title: id, currentSelection: selection, ...extra });
  await new Promise(resolve => setTimeout(resolve, 5));
}

describe("resolveVoiceChat", () => {
  it("joins the most recent generic Matrix Pi Chat, skipping project, other-harness and live-task Chats", async () => {
    await chat("chat_old_pi", pi);
    await chat("chat_recent_pi", pi);
    await chat("chat_project_pi", pi, { projectId: "demo" });
    await chat("chat_claude", claude);
    await chat("chat_live_task_abc", pi);
    await expect(resolveVoiceChat({ repository, principal, piSelection: async () => pi }))
      .resolves.toEqual({ chatId: "chat_recent_pi", selection: pi, created: false });
  });

  it("creates a generic Matrix Pi Chat when none exists", async () => {
    await chat("chat_claude", claude);
    const result = await resolveVoiceChat({ repository, principal, piSelection: async () => pi });
    expect(result.created).toBe(true);
    const record = await repository.get(owner, result.chatId);
    expect(record?.chat.currentSelection).toEqual(pi);
    expect(record?.projectId).toBeUndefined();
  });

  it("uses an explicitly requested owned Chat with its saved selection", async () => {
    await chat("chat_recent_pi", pi);
    await chat("chat_claude", claude);
    await expect(resolveVoiceChat({ repository, principal, piSelection: async () => pi, chatId: "chat_claude" }))
      .resolves.toEqual({ chatId: "chat_claude", selection: claude, created: false });
  });

  it("rejects a requested Chat the owner does not have", async () => {
    await expect(resolveVoiceChat({ repository, principal, piSelection: async () => pi, chatId: "chat_missing" }))
      .rejects.toMatchObject({ name: "ChatNotFoundError" });
  });

  it("fails closed when no Matrix Pi route is available and no generic Chat exists", async () => {
    await expect(resolveVoiceChat({ repository, principal, piSelection: async () => undefined }))
      .rejects.toMatchObject({ code: "provider_unavailable" });
  });
});

describe("matrixPiSelection", () => {
  const instance = { id: "matrix_pi_default", driverKind: "matrix_pi", availability: "available", defaultSelection: pi };
  it("returns the available Matrix Pi default selection", () => {
    expect(matrixPiSelection({ instances: [instance] } as never)).toEqual(pi);
  });
  it("ignores unavailable or foreign instances", () => {
    expect(matrixPiSelection({ instances: [{ ...instance, availability: "unavailable" }, { ...instance, id: "other" }] } as never)).toBeUndefined();
  });
});
