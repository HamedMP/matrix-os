import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Kysely } from "kysely";
import type { HostedBotsDatabase } from "../../packages/gateway/src/hosted-bots/database.js";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";
import { createHostedBotsRepository } from "../../packages/gateway/src/hosted-bots/repository.js";
import { hostedBotsCredentialPath } from "../../packages/gateway/src/hosted-bots/model-credentials.js";
import { startHostedBotsWorker } from "../../packages/gateway/src/hosted-bots/runtime.js";
import { createHostedBotsRoutes } from "../../packages/gateway/src/hosted-bots/routes.js";
import { createOpenMausPreviewModel } from "../../packages/gateway/src/hosted-bots/model.js";

describe("hosted Bots runtime", () => {
  let db: Kysely<HostedBotsDatabase>;
  let repository: Awaited<ReturnType<typeof createHostedBotsRepository>>;

  beforeEach(async () => {
    const postgres = await createTestPGlite();
    db = new Kysely<HostedBotsDatabase>({ dialect: postgres.dialect });
    repository = await createHostedBotsRepository(db);
  });
  afterEach(async () => { await db.destroy(); });

  it("binds model credentials to the declared systemd state directory outside owner home", () => {
    expect(hostedBotsCredentialPath("/var/lib/matrix-hosted-bots", "/home/matrix/home"))
      .toBe("/var/lib/matrix-hosted-bots/provider-key");
    expect(hostedBotsCredentialPath("/var/lib/other:/var/lib/matrix-hosted-bots", "/var/lib/matrix"))
      .toBe("/var/lib/matrix-hosted-bots/provider-key");
    expect(hostedBotsCredentialPath(undefined, "/home/matrix/home")).toBeNull();
    expect(hostedBotsCredentialPath("/home/matrix/home/.config/matrix-hosted-bots", "/home/matrix/home")).toBeNull();
    expect(hostedBotsCredentialPath("/var/lib/matrix-hosted-bots", "/var/lib")).toBeNull();
  });

  it("persists an accepted job, terminal result and versioned profile; refuses another owner", async () => {
    const bot = await repository.createBot("owner", "Field notes");
    const thread = await repository.createThread("owner", bot.id, "Setup");
    const enqueue = { requestId: crypto.randomUUID(), mode: "setup" as const, text: "Use short answers." };
    const queued = await repository.enqueue("owner", bot.id, thread.id, enqueue);
    expect(await repository.enqueue("owner", bot.id, thread.id, enqueue)).toEqual(queued);
    await expect(repository.enqueue("owner", bot.id, thread.id, { ...enqueue, text: "Change this." })).rejects.toMatchObject({ code: "conflict" });
    await expect(repository.readThread("different-owner", bot.id, thread.id)).rejects.toMatchObject({ code: "not_found" });

    const reopened = await createHostedBotsRepository(db);
    const claim = await reopened.claim("owner");
    expect(claim).toMatchObject({ id: queued.id, text: enqueue.text, revision: 0 });
    expect(await reopened.claim("owner")).toBeUndefined();
    await reopened.finish(claim!, { text: "Saved your preferences.", profile: { reason: "Set concise style", instructions: "Use short answers." } });

    const afterRestart = await createHostedBotsRepository(db);
    const snapshot = await afterRestart.readThread("owner", bot.id, thread.id);
    expect(snapshot.runs).toMatchObject([{ id: queued.id, status: "completed" }]);
    expect(snapshot.messages).toMatchObject([{ role: "user", text: enqueue.text }, { role: "assistant", text: "Saved your preferences." }]);
    expect((await afterRestart.readBot("owner", bot.id)).bot.instructions).toBe("Use short answers.");
    await afterRestart.undo("owner", bot.id, snapshot.profileChanges[0]!.id);
    expect((await afterRestart.readBot("owner", bot.id)).bot).toMatchObject({ revision: 2, instructions: "" });
    await expect(afterRestart.undo("owner", bot.id, snapshot.profileChanges[0]!.id)).rejects.toMatchObject({ code: "conflict" });
  });

  it("rejects malformed input, keeps the disabled route closed, and scopes admitted requests", async () => {
    const resolveOwner = vi.fn(() => "owner");
    const options = { repository, resolveOwner, model: { connected: async () => true, connect: async () => {} }, wake: () => {} };
    const disabled = createHostedBotsRoutes({ ...options, admitted: false });
    expect((await disabled.request("/")).status).toBe(404);
    expect(resolveOwner).not.toHaveBeenCalled();
    const denied = createHostedBotsRoutes({ ...options, admitted: true, resolveOwner: () => null });
    expect((await denied.request("/")).status).toBe(403);
    const admitted = createHostedBotsRoutes({ ...options, admitted: true });
    const malformed = await admitted.request("/", { method: "POST", body: JSON.stringify({ name: "" }), headers: { "Content-Type": "application/json" } });
    expect(malformed.status).toBe(400);
    const created = await admitted.request("/", { method: "POST", body: JSON.stringify({ name: "Notes" }), headers: { "Content-Type": "application/json" } });
    expect(created.status).toBe(201);
    expect(await admitted.request("/").then((r) => r.json())).toMatchObject({ bots: [{ name: "Notes" }] });
  });

  it("completes accepted work even after the request connection is aborted", async () => {
    const bot = await repository.createBot("owner", "Field notes");
    const thread = await repository.createThread("owner", bot.id, "Conversation");
    let release!: () => void;
    const waitForExit = new Promise<void>((resolve) => { release = resolve; });
    const model = vi.fn(async (_input, signal: AbortSignal) => {
      await waitForExit;
      expect(signal.aborted).toBe(false);
      return { text: "Completed after the client left." };
    });
    const worker = startHostedBotsWorker({ ownerId: "owner", repository, model });
    try {
      const routes = createHostedBotsRoutes({ admitted: true, resolveOwner: () => "owner", repository,
        model: { connected: async () => true, connect: async () => {} }, wake: worker.wake });
      const disconnect = new AbortController();
      const accepted = await routes.request("/" + bot.id + "/threads/" + thread.id + "/runs", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: disconnect.signal,
        body: JSON.stringify({ text: "Run independently.", mode: "chat", requestId: crypto.randomUUID() }),
      });
      expect(accepted.status).toBe(202);
      await vi.waitFor(() => expect(model).toHaveBeenCalledOnce(), { timeout: 3_500 });
      disconnect.abort();
      const clientDisconnectedAt = Date.now();
      await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(clientDisconnectedAt));
      release();
      await vi.waitFor(async () => {
        const snapshot = await repository.readThread("owner", bot.id, thread.id);
        expect(snapshot.messages.at(-1)?.text).toBe("Completed after the client left.");
        expect(Date.parse(snapshot.runs[0]!.completedAt!)).toBeGreaterThan(clientDisconnectedAt);
      });
    } finally {
      release();
      await worker.close();
    }
  });

  it("uses a real Responses contract with a bounded profile tool only in setup", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ status: "completed", output: [{ type: "function_call", call_id: "call_1", name: "propose_profile", arguments: JSON.stringify({ reason: "Style", instructions: "Use short answers." }) }] }))
      .mockResolvedValueOnce(Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Your profile is ready." }] }] }));
    const model = createOpenMausPreviewModel({ fetch: request, readKey: async () => "not-a-real-key" });
    const response = await model({ mode: "setup", instructions: "", messages: [{ role: "user", text: "Set up concise style." }] }, AbortSignal.timeout(5000));
    expect(response).toEqual({ text: "Your profile is ready.", profile: { reason: "Style", instructions: "Use short answers." } });
    const [url, first] = request.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(JSON.parse(String(first?.body))).toMatchObject({ store: false, tools: [{ name: "propose_profile" }] });
    expect(JSON.parse(String(request.mock.calls[1]![1]?.body)).input).toContainEqual({ type: "function_call_output", call_id: "call_1", output: expect.any(String) });
  });
});
