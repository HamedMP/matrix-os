import { describe, expect, it, vi } from "vitest";
import { createCanonicalChatClient } from "@desktop/renderer/src/lib/canonical-chat-client";
import { createCanonicalShellChatClient } from "@/lib/canonical-chat-client";
import { AppError } from "@desktop/shared/app-error";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";

function fixture() {
  const { snapshot } = createCanonicalChatFixture("running");
  const { activeRun, providerBinding, project, ...chat } = snapshot.chat;
  return {
    record: { chat, activeRun, providerBinding, projectId: project.projectId },
    messages: snapshot.messages, turns: snapshot.turns, runs: snapshot.runs, activities: snapshot.activities,
  };
}
const detail = fixture();
const chatId = detail.record.chat.id;
const input = { clientRequestId: "req_fixture_running", baseRevision: 0,
  parts: detail.messages[0].parts, selection: detail.runs[0].selection,
  interactionMode: "default", permissionMode: "supervised" };

describe.each(["Electron", "Web"])("%s lost admission acknowledgement", (surface) => {
  function setup(readResult: unknown = detail, status?: number, readFails = false) {
    const post = vi.fn(async () => {
      if (surface === "Electron") throw new AppError(status ? "server" : "timeout", { httpStatus: status });
      if (status) return new Response("{}", { status });
      throw new TypeError("Connection lost");
    });
    const get = vi.fn(async () => {
      if (readFails) throw new TypeError("Still offline");
      return readResult;
    });
    const client = surface === "Electron" ? createCanonicalChatClient({
      get, post, patch: vi.fn(), delete: vi.fn(),
    }) : createCanonicalShellChatClient({ gatewayUrl: "https://matrix.test", fetchFn: vi.fn(async (_url, init) => {
      if (init?.method === "POST") return post() as Promise<Response>;
      return Response.json(await get());
    }) });
    return { client, post, get };
  }

  it("recovers the exact accepted turn by request ID without sending it twice", async () => {
    const { client, post, get } = setup();
    const accepted = await client.admitTurn(chatId, input);
    expect(accepted.admission).toBe("already_accepted");
    expect(accepted.turn.id).toBe("cturn_fixture_running");
    expect(accepted.run.id).toBe("run_fixture_running");
    expect(accepted).toHaveProperty("recoveredDetail.messages", detail.messages);
    expect(post).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledOnce();
  });

  it.each(["different request", "different text", "different model", "different permissions", "wrong chat", "missing message", "missing run", "read failure"])(
    "preserves uncertainty instead of accepting an unrelated result: %s", async (reason) => {
      const read = structuredClone(detail);
      if (reason === "different request") read.turns[0].clientRequestId = "req_other";
      if (reason === "different text") read.messages[0].parts = [{ type: "text", text: "Another message" }];
      if (reason === "different model") read.runs[0].selection.model = "another-model";
      if (reason === "different permissions") read.runs[0].permissionMode = "full_access";
      if (reason === "wrong chat") read.record.chat.id = "chat_other";
      if (reason === "missing message") read.messages = [];
      if (reason === "missing run") read.runs = [];
      const { client, post } = setup(read, undefined, reason === "read failure");
      await expect(client.admitTurn(chatId, input)).rejects.toThrow();
      expect(post).toHaveBeenCalledOnce();
    },
  );

  it.each([400, 401, 403, 409, 429])("does not override a definitive HTTP %s rejection", async (status) => {
    const { client, post, get } = setup(detail, status);
    await expect(client.admitTurn(chatId, input)).rejects.toThrow();
    expect(post).toHaveBeenCalledOnce();
    expect(get).not.toHaveBeenCalled();
  });
});
