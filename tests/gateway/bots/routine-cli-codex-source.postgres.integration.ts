import { afterEach, expect, it, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { codexFixture } from "./routine-cli-codex-support.js";
import { proposal, TARGET_A } from "./routine-cli-request-support.js";
let f: Awaited<ReturnType<typeof codexFixture>> | undefined;
afterEach(async () => { await f?.close(); f = undefined; vi.unstubAllGlobals(); });
it("actual admitted Codex Chat executes the published fixed CLI through private wrapper/shim IPC, HTTP and canonical PostgreSQL receipt", async () => {
  const requestId = "de000000-0000-4000-8000-000000000601", chatId = "chat_codex_actual";
  f = await codexFixture({ intent: { args: ["propose", "--input", "-", "--request-id", requestId], stdin: JSON.stringify(proposal) } });
  const admitted = await f.start(chatId);
  await expect.poll(() => f!.sourceEvents.find(event => event.type === "approval.requested"), { timeout: 8000 }).toMatchObject({ type: "approval.requested" });
  const approval = f.sourceEvents.find(event => event.type === "approval.requested")!;
  if (approval.type !== "approval.requested") throw new Error("Missing exact approval");
  await f.approve(approval, chatId, admitted.run.id);
  await expect.poll(async () => (await f!.frames()).find(frame => frame.id === 107), { timeout: 8000 }).toMatchObject({ result: { success: true } });
  await f.f.canonical.drain();
  expect(f.httpCalls()).toBe(1);
  const frames = await f.frames(), response = frames.find(frame => frame.id === 107);
  expect(JSON.parse(response.result.contentItems[0].text)).toMatchObject({ v: 1, ok: true, data: { receipt: { requestId, disposition: "queued" } } });
  expect(frames.find(frame => frame.method === "thread/start").params.dynamicTools).toEqual([expect.objectContaining({ type: "function", name: "matrix_routines" })]);
  expect(frames.find(frame => frame.method === "initialize").params.capabilities.experimentalApi).toBe(true);
  expect(await f.data.db.selectFrom("routine_cli_requests").select("client_request_id").execute()).toEqual([{ client_request_id: requestId }]);
  expect(await f.data.db.selectFrom("bot_interactions").select("chat_id").execute()).toEqual([{ chat_id: TARGET_A.chatId }]);
  expect(await f.data.db.selectFrom("bot_routines").selectAll().execute()).toEqual([]);
  const source = await f.data.db.selectFrom("routine_cli_sources").select(["source_context", "revoked_at"]).where("generation", "like", "native_%").executeTakeFirstOrThrow();
  expect(source.source_context).toMatchObject({ harness: "codex", identity: { kind: "chat_run", chatId, runId: admitted.run.id } });
  expect(source.revoked_at).not.toBeNull();
  const serialized = JSON.stringify(frames) + await readFile(f.launched[0].descriptor, "utf8");
  expect(serialized).not.toMatch(/RoutineCapability|rcli_|fixture-owner-credential|platform-claude-consent|admissionId|shim\.bound|host\.turn/);
}, 25_000);

it.each([false, true])("a second canonical turn keeps native history and requires its own source; fresh adapter=%s", async freshAdapter => {
  f = await codexFixture({ intent: { args: ["list"] }, turns: 3 });
  const chatId = "chat_codex_queued", first = await f.start(chatId), owner = { type: "personal" as const, ownerId: "user_owner_1" };
  await f.f.canonical.drain();
  expect((await f.frames()).find(frame => frame.id === 107).result.success).toBe(true);
  if (freshAdapter) {
    const { createCanonicalCodingChatProviderAdapter } = await import("../../../packages/gateway/src/chat/coding-provider-adapter.js");
    const restored = createCanonicalCodingChatProviderAdapter({ providerId: "codex", threads: f.threads, homePath: f.home, routineCli: { runtime: f.runtime, ...f.transport } });
    f.setSourceAdapter(restored);
  }
  const detail = await f.f.chats.get(owner, chatId);
  const second = await f.f.canonical.admitTurn(f.f.principal, owner, chatId, { baseRevision: detail!.chat.revision, clientRequestId: "req_second_codex", parts: [{ type: "text", text: "Second native turn" }], selection: { instanceId: "codex_default", model: "fixture-model" }, interactionMode: "default", permissionMode: "full_access" });
  await f.f.canonical.drain();
  const frames = await f.frames();
  expect(frames.filter(frame => frame.method === "thread/start")).toHaveLength(1);
  expect(frames.filter(frame => frame.method === "thread/resume")).toHaveLength(0);
  expect(frames.filter(frame => frame.method === "turn/start")).toHaveLength(2);
  expect(frames.find(frame => frame.id === 207).result.success).toBe(!freshAdapter);
  const state = f.sourceEvents.filter(event => event.type === "state.updated").at(-1)!;
  if (state.type !== "state.updated") throw new Error("Missing backing thread");
  const threadId = (state.state as { conversationId: string }).conversationId;
  const snapshot = await f.threads.getThread(f.f.principal, threadId), turn = snapshot.events.items.filter(event => event.type === "turn.accepted").at(-1)!;
  if (turn.type !== "turn.accepted") throw new Error("Missing actual admitted legacy turn");
  const { createCodexControlClient } = await import("../../../packages/gateway/src/coding-agents/codex-control-client.js");
  expect(await createCodexControlClient({ homePath: f.home }).isExecutionIdle!({ sessionId: "sess_" + threadId.slice("thread_".length), providerThreadId: "fixture_native_thread", requestId: "req_" + turn.turnId.slice("turn_".length) })).toBe(true);

  expect(f.httpCalls()).toBe(freshAdapter ? 1 : 2);
  const rows = await f.data.db.selectFrom("routine_cli_sources").select(["source_context", "generation", "revoked_at"]).where("generation", "like", "native_%").execute();
  expect(rows).toHaveLength(freshAdapter ? 1 : 2); expect(rows.every(row => row.revoked_at !== null)).toBe(true);
  if (!freshAdapter) expect(rows.map(row => (row.source_context as { identity: { runId: string } }).identity.runId).sort()).toEqual([first.run.id, second.run.id].sort());
}, 25_000);

it.each(["review", "cancel"])("denies %s without owner/source fallback or a canonical receipt", async condition => {
  f = await codexFixture({ intent: { args: ["propose", "--input", "-", "--request-id", "de000000-0000-4000-8000-000000000602"], stdin: JSON.stringify(proposal) } });
  const chatId = "chat_codex_denied", admitted = await f.start(chatId, condition === "review" ? { permission: "full_access", interaction: "review" } : undefined);
  if (condition === "cancel") {
    await expect.poll(() => f!.sourceEvents.some(event => event.type === "approval.requested"), { timeout: 5000 }).toBe(true);
    await f.f.canonical.cancelRun({ type: "personal", ownerId: "user_owner_1" }, chatId, admitted.run.id);
  }
  await f.f.canonical.drain();
  expect(f.httpCalls()).toBe(0);
  expect(await f.data.db.selectFrom("routine_cli_requests").selectAll().execute()).toEqual([]);
  expect(await f.data.db.selectFrom("bot_approvals").selectAll().execute()).toEqual([]);
}, 20_000);


it.each(["turn completion", "private pipe EOF", "receiver EOF", "wrapper overflow"])("%s fences an authorized in-flight HTTP consume before native pipes close", async ending => {
  const requestId = "de000000-0000-4000-8000-000000000603", chatId = "chat_codex_consume_end";
  f = await codexFixture({ intent: { args: ["propose", "--input", "-", "--request-id", requestId], stdin: JSON.stringify(proposal) }, holdAfterResult: true, receiverHalfClose: ending === "receiver EOF", wrapperOverflow: ending === "wrapper overflow" });
  let sourceEnded = false;
  let end!: () => void, httpDone!: () => void;
  const ended = new Promise<void>(resolve => { end = resolve; }), finished = new Promise<void>(resolve => { httpDone = resolve; });
  const register = f.runtime.registerChat;
  f.runtime.registerChat = async input => { const source = await register(input); return { ...source, async revoke() { await source.revoke(); sourceEnded = true; end(); } }; };
  const execute = f.runtime.execute; let errorCode: string | undefined;
  f.runtime.execute = async input => {
    if (ending === "wrapper overflow") await f!.overflowWrapper(); else if (ending === "receiver EOF") f!.halfCloseReceiver(); else if (ending === "private pipe EOF") [...f!.services.values()][0].child.stdin.end(); else await writeFile(f!.controlFile, "complete");
    await ended;
    try { return await execute(input); } catch (error) { errorCode = (error as { code?: string }).code; throw error; } finally { httpDone(); }
  };
  const admitted = await f.start(chatId);
  await expect.poll(() => f!.sourceEvents.find(event => event.type === "approval.requested"), { timeout: 5000 }).toMatchObject({ type: "approval.requested" });
  const event = f.sourceEvents.find(event => event.type === "approval.requested")!;
  if (event.type !== "approval.requested") throw new Error("Missing exact approval");
  await f.approve(event, chatId, admitted.run.id);
  await expect.poll(() => sourceEnded, { timeout: 2000 }).toBe(true);
  await finished;
  expect(errorCode).toBe("permission_denied");
  expect([...f.services.values()].every(service => service.child.exitCode === null && service.child.signalCode === null)).toBe(true);
  expect(await f.data.db.selectFrom("routine_cli_requests").selectAll().execute()).toEqual([]);
  expect(await f.data.db.selectFrom("bot_approvals").selectAll().execute()).toEqual([]);
  expect(f.httpCalls()).toBe(1);
  if (ending === "wrapper overflow") {
    expect([...f.services.values()].every(service => service.child.stdout.readableEnded || service.child.stdout.destroyed)).toBe(true);
    await writeFile(f.controlFile, "after-overflow");
    await expect.poll(async () => (await f!.frames()).find(frame => frame.id === 109), { timeout: 2000 }).toMatchObject({ result: { success: false } });
    expect(f.httpCalls()).toBe(1); // Native I/O still responds; lost proof cannot start another CLI invocation.
  }
  if (ending === "private pipe EOF" || ending === "receiver EOF" || ending === "wrapper overflow") {
    await expect.poll(async () => (await f!.frames()).find(frame => frame.id === 107), { timeout: 2000 }).toMatchObject({ result: { success: false } });
    const response = (await f.frames()).find(frame => frame.id === 107);
    expect(JSON.parse(response.result.contentItems[0].text)).toMatchObject({ data: { kind: "unknown", requestId, reconcile: true } });
  }
}, 20_000);

it("two native request IDs for one call execute the actual CLI once and retain the explicit business UUID", async () => {
  const requestId = "de000000-0000-4000-8000-000000000604", chatId = "chat_codex_duplicate";
  f = await codexFixture({ intent: { args: ["propose", "--input", "-", "--request-id", requestId], stdin: JSON.stringify(proposal) }, calls: [{ callId: "same_native_call" }, { callId: "same_native_call" }] });
  const admitted = await f.start(chatId);
  await expect.poll(() => f!.sourceEvents.find(event => event.type === "approval.requested"), { timeout: 5000 }).toMatchObject({ type: "approval.requested" });
  const event = f.sourceEvents.find(event => event.type === "approval.requested")!;
  if (event.type !== "approval.requested") throw new Error("Missing exact approval");
  await f.approve(event, chatId, admitted.run.id); await f.f.canonical.drain();
  const results = (await f.frames()).filter(frame => [107, 108].includes(frame.id));
  expect(results).toHaveLength(2); expect(results.every(frame => frame.result.success)).toBe(true);
  expect(f.httpCalls()).toBe(1); expect(f.sourceEvents.filter(event => event.type === "approval.requested")).toHaveLength(1);
  expect(await f.data.db.selectFrom("routine_cli_requests").select("client_request_id").execute()).toEqual([{ client_request_id: requestId }]);
  expect(await f.data.db.selectFrom("bot_tasks").selectAll().execute()).toHaveLength(1);
}, 20_000);

it.each(["owner", "Chat", "run", "provider"])("actual canonical source registration rejects a mismatched %s", async mismatch => {
  f = await codexFixture({ intent: { args: ["list"] } });
  const register = f.runtime.registerChat;
  f.runtime.registerChat = options => register({ ...options,
    ...(mismatch === "provider" ? { provider: "claude" } : {}),
    input: { ...options.input,
      ...(mismatch === "owner" ? { owner: { type: "personal", ownerId: "user_foreign" } as const } : {}),
      ...(mismatch === "Chat" ? { chatId: TARGET_A.chatId } : {}),
      ...(mismatch === "run" ? { runId: "run_foreign" } : {}),
    },
  });
  await f.start("chat_codex_mismatch"); await f.f.canonical.drain();
  expect((await f.frames()).find(frame => frame.id === 107).result.success).toBe(false);
  expect(f.httpCalls()).toBe(0);
  expect(await f.data.db.selectFrom("routine_cli_sources").select("source_id").where("generation", "like", "native_%").execute()).toEqual([]);
}, 15_000);


it("named private transport cancels only the exact pending CLI action and keeps the real source alive", async () => {
  const requestId = "de000000-0000-4000-8000-000000000605", chatId = "chat_codex_action_cancel";
  f = await codexFixture({ intent: { args: ["propose", "--input", "-", "--request-id", requestId], stdin: JSON.stringify(proposal) }, holdAfterResult: true });
  const register = f.runtime.registerChat; let reason: string | undefined, revoked = false;
  f.runtime.registerChat = async input => { const source = await register(input); return { ...source,
    async cancel(call) { reason = call.reason; return source.cancel(call); }, async revoke() { revoked = true; return source.revoke(); },
  }; };
  await f.start(chatId);
  await expect.poll(() => f!.sourceEvents.some(event => event.type === "approval.requested"), { timeout: 5000 }).toBe(true);
  const call = f.privateFrames.find(frame => frame.type === "shim.call")!;
  if (call.type !== "shim.call") throw new Error("Missing exact private action");
  // Named systemd transport fixture delivers the exact cancellation that the separate native deadline test produces.
  [...f.services.values()][0].child.stdout.emit("data", Buffer.from(JSON.stringify({ type: "shim.cancel", admissionId: call.admissionId, actionId: call.actionId }) + "\n"));
  await expect.poll(() => reason, { timeout: 3000 }).toBe("aborted");
  await expect.poll(async () => (await f!.frames()).find(frame => frame.id === 107), { timeout: 3000 }).toMatchObject({ result: { success: false } });
  const response = (await f.frames()).find(frame => frame.id === 107);
  expect(JSON.parse(response.result.contentItems[0].text)).toMatchObject({ data: { kind: "unknown", requestId, reconcile: true } });
  expect(revoked).toBe(false);
  expect(await f.data.db.selectFrom("routine_cli_sources").select("revoked_at").where("generation", "like", "native_%").execute()).toEqual([{ revoked_at: null }]);
  expect(f.httpCalls()).toBe(0); expect(await f.data.db.selectFrom("routine_cli_requests").selectAll().execute()).toEqual([]);
}, 15_000);


it("a lost private queued ACK never falls back or resubmits a prompt/mutation and retains the original business UUID", async () => {
  const requestId = "de000000-0000-4000-8000-000000000606", chatId = "chat_codex_lost_ack", owner = { type: "personal" as const, ownerId: "user_owner_1" };
  f = await codexFixture({ intents: [{ args: ["list"] }, { args: ["propose", "--input", "-", "--request-id", requestId], stdin: JSON.stringify(proposal) }], turns: 3, loseQueuedAck: true });
  const submit = vi.spyOn(f.control, "submitTurn");
  await f.start(chatId); await f.f.canonical.drain();
  const detail = await f.f.chats.get(owner, chatId);
  const second = await f.f.canonical.admitTurn(f.f.principal, owner, chatId, { baseRevision: detail!.chat.revision, clientRequestId: "req_codex_lost_ack", parts: [{ type: "text", text: "Propose exactly once" }], selection: { instanceId: "codex_default", model: "fixture-model" }, interactionMode: "default", permissionMode: "full_access" });
  await expect.poll(() => f!.sourceEvents.find(event => event.type === "approval.requested"), { timeout: 5000 }).toMatchObject({ type: "approval.requested" });
  const event = f.sourceEvents.find(event => event.type === "approval.requested")!;
  if (event.type !== "approval.requested") throw new Error("Missing exact owner decision");
  await f.approve(event, chatId, second.run.id); await f.f.canonical.drain();
  const frames = await f.frames();
  expect(frames.filter(frame => frame.method === "thread/start")).toHaveLength(1);
  expect(frames.filter(frame => frame.method === "thread/resume")).toHaveLength(0);
  expect(frames.filter(frame => frame.method === "turn/start")).toHaveLength(2);
  expect(submit).not.toHaveBeenCalled(); expect(f.services.size).toBe(1);
  expect(await f.data.db.selectFrom("routine_cli_requests").select("client_request_id").execute()).toEqual([{ client_request_id: requestId }]);
  expect(await f.data.db.selectFrom("bot_tasks").selectAll().execute()).toHaveLength(1);
}, 20_000);
