import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
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
  function setup(readResult: unknown = detail, status?: number, readFails = false, readTranscript?: () => Promise<unknown>) {
    const post = vi.fn(async () => {
      if (surface === "Electron") throw new AppError(status ? "server" : "timeout", { httpStatus: status });
      if (status) return new Response("{}", { status });
      throw new TypeError("Connection lost");
    });
    const get = vi.fn(async (path: string) => {
      if (readFails) throw new TypeError("Still offline");
      if (path.includes("/turn-admissions/")) {
        // Model the server's saved original request, independently of effective run settings.
        const originalHash = createHash("sha256").update(JSON.stringify({ parts: input.parts,
          selection: input.selection, interactionMode: input.interactionMode,
          permissionMode: input.permissionMode, executionRoot: null })).digest("hex");
        if (new URL(path, "https://matrix.test").searchParams.get("requestHash") !== originalHash) throw new Error("RequestHashConflict");
        const saved = readResult as typeof detail;
        return { record: saved.record, message: saved.messages[0], turn: saved.turns[0], run: saved.runs[0], admission: "already_accepted" };
      }
      if (readTranscript) return readTranscript();
      return readResult;
    });
    const client = surface === "Electron" ? createCanonicalChatClient({
      get, post, patch: vi.fn(), delete: vi.fn(),
    }) : createCanonicalShellChatClient({ gatewayUrl: "https://matrix.test", fetchFn: vi.fn(async (url, init) => {
      if (init?.method === "POST") return post() as Promise<Response>;
      return Response.json(await get(String(url)));
    }) });
    return { client, post, get };
  }

  it("recovers the exact accepted turn by request ID without sending it twice", async () => {
    const { client, post, get } = setup();
    const accepted = await client.admitTurn(chatId, input);
    expect(accepted.admission).toBe("already_accepted");
    expect(accepted.turn.id).toBe("cturn_fixture_running");
    expect(accepted.run.id).toBe("run_fixture_running");
    expect(accepted).not.toHaveProperty("recoveredDetail");
    expect(post).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledOnce();
  });

  it.each(["Agent context", "Bot permissions"])("recovers original request authority after legitimate %s overrides", async (override) => {
    const read = structuredClone(detail);
    if (override === "Agent context") {
      read.runs[0].selection = { instanceId: "pi_context", model: "context-selected-model" };
      read.runs[0].instanceId = "pi_context";
      read.runs[0].interactionMode = "plan";
    } else read.runs[0].permissionMode = "full_access";
    const { client, post } = setup(read);
    const accepted = await client.admitTurn(chatId, input);
    expect(accepted.turn.clientRequestId).toBe(input.clientRequestId);
    expect(accepted.run).toMatchObject(read.runs[0]);
    expect(post).toHaveBeenCalledOnce();
  });

  it.each(["different request", "different text", "different model", "different permissions", "different interaction", "different root", "wrong chat", "missing message", "missing run", "read failure"])(
    "preserves uncertainty instead of accepting an unrelated result: %s", async (reason) => {
      const read = structuredClone(detail);
      if (reason === "different request") read.turns[0].clientRequestId = "req_other";
      if (reason === "different text") read.messages[0].parts = [{ type: "text", text: "Another message" }];
      const request = structuredClone(input);
      if (reason === "different model") request.selection.model = "another-model";
      if (reason === "different permissions") request.permissionMode = "full_access";
      if (reason === "different interaction") request.interactionMode = "plan";
      if (reason === "different root") Object.assign(request, { executionRoot: { kind: "project", projectId: "project_other" } });
      if (reason === "wrong chat") read.record.chat.id = "chat_other";
      if (reason === "missing message") read.messages = [];
      if (reason === "missing run") read.runs = [];
      const { client, post } = setup(read, undefined, reason === "read failure");
      await expect(client.admitTurn(chatId, request)).rejects.toThrow();
      expect(post).toHaveBeenCalledOnce();
    },
  );

  it("acknowledges a proven admission while optional transcript hydration remains pending", async () => {
    vi.useFakeTimers();
    let finishTranscript!: (value: unknown) => void;
    const transcript = new Promise<unknown>(resolve => { finishTranscript = resolve; });
    const readTranscript = vi.fn(() => transcript);
    const { client, post, get } = setup(detail, undefined, false, readTranscript);
    let acknowledged: Awaited<ReturnType<typeof client.admitTurn>> | undefined;
    const sending = client.admitTurn(chatId, input).then(result => { acknowledged = result; });
    try {
      await vi.waitFor(() => expect(get.mock.calls.some(([path]) => path.includes("/turn-admissions/"))).toBe(true));
      // Leave the optional full transcript unresolved: its transport deadline
      // must not keep an already attested submission in the sending state.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(acknowledged).toMatchObject({ admission: "already_accepted", turn: { clientRequestId: input.clientRequestId } });
      expect(acknowledged).not.toHaveProperty("recoveredDetail");
      expect(post).toHaveBeenCalledOnce();
      expect(readTranscript).not.toHaveBeenCalled();
      expect(get).toHaveBeenCalledOnce();
    } finally {
      finishTranscript(detail);
      await sending;
      vi.useRealTimers();
    }
    expect(post).toHaveBeenCalledOnce();
  });

  it("keeps an old host's missing lookup uncertain without retrying admission", async () => {
    const failure = surface === "Electron" ? new AppError("timeout") : new TypeError("Lost acknowledgement");
    const post = vi.fn(async () => { throw failure; });
    const get = vi.fn(async () => {
      if (surface === "Electron") throw new AppError("server", { httpStatus: 404 });
      return new Response("{}", { status: 404 });
    });
    const client = surface === "Electron" ? createCanonicalChatClient({ get, post, patch: vi.fn(), delete: vi.fn() })
      : createCanonicalShellChatClient({ gatewayUrl: "https://matrix.test", fetchFn: vi.fn(async (_url, init) => {
        if (init?.method === "POST") return post();
        return await get() as Response;
      }) });
    await expect(client.admitTurn(chatId, input)).rejects.toBe(failure);
    expect(post).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledOnce();
  });

  it.each([400, 401, 403, 409, 429])("does not override a definitive HTTP %s rejection", async (status) => {
    const { client, post, get } = setup(detail, status);
    await expect(client.admitTurn(chatId, input)).rejects.toThrow();
    expect(post).toHaveBeenCalledOnce();
    expect(get).not.toHaveBeenCalled();
  });
});
