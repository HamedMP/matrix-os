import { afterEach, expect, it, vi } from "vitest";
import { piFixture } from "./routine-cli-pi-support.js";
import { proposal, TARGET_A } from "./routine-cli-request-support.js";
let f: Awaited<ReturnType<typeof piFixture>> | undefined;
afterEach(async () => { await f?.close(); f = undefined; vi.unstubAllGlobals(); });
it.each(["event-first", "fd-first"] as const)("%s actual Pi source/owned extension invokes published CLI and canonical target after exact owner decision", async order => {
  const requestId = "de000000-0000-4000-8000-000000000901", chatId = "chat_pi_actual_" + order;
  f = await piFixture({ operation: { operation: "propose", requestId, proposal }, order });
  const admitted = await f.start(chatId);
  await expect.poll(() => f!.sourceEvents.find(event => event.type === "approval.requested"), { timeout: 5000 }).toMatchObject({ type: "approval.requested" });
  const decision = f.sourceEvents.find(event => event.type === "approval.requested")!;
  if (decision.type !== "approval.requested") throw new Error("Missing exact owner decision");
  await f.approve(decision, chatId, admitted.run.id); await f.f.canonical.drain();
  expect(JSON.parse((await f.frames()).find(frame => frame.result).result)).toMatchObject({ ok: true, data: { receipt: { requestId, disposition: "queued" } } });
  expect(f.httpCalls()).toBe(1);
  expect(f.orderTrace.slice(0, 2)).toEqual(order === "fd-first" ? ["fd-callback", "observed-running"] : ["observed-running", "fd-callback"]);
  expect(await f.data.db.selectFrom("bot_interactions").select("chat_id").execute()).toEqual([{ chat_id: TARGET_A.chatId }]);
  expect(await f.data.db.selectFrom("bot_routines").selectAll().execute()).toEqual([]);
  const source = await f.data.db.selectFrom("routine_cli_sources").select(["source_context", "revoked_at"]).executeTakeFirstOrThrow();
  expect(source.source_context).toMatchObject({ harness: "pi", identity: { kind: "chat_run", chatId, runId: admitted.run.id, route: "native" } });
  expect(source.revoked_at).not.toBeNull();
  const frames = await f.frames(); expect(frames.filter(frame => frame.prompt)).toHaveLength(1);
  expect(frames.find(frame => frame.prompt).tools).toBe("read,ask_user,matrix_routines");
  expect(JSON.stringify(frames)).not.toMatch(/rcli_|fixture-owner-credential|native_[a-f0-9]{48}/);
}, 15000);

it.each(["session", "call", "intent", "unobserved", "nested"])("rejects %s callback provenance before capability issuance", async mismatch => {
  f = await piFixture({ operation: { operation: "list" },
    ...(mismatch === "session" ? { sessionId: "session_foreign" } : {}), ...(mismatch === "call" ? { callId: "call_foreign" } : {}),
    ...(mismatch === "intent" ? { event: { args: { operation: "request", requestId: "de000000-0000-4000-8000-000000000902" } } } : {}),
    ...(mismatch === "unobserved" ? { event: { toolName: "read" } } : {}), ...(mismatch === "nested" ? { event: { parentToolCallId: "parent_untrusted" } } : {}) });
  await f.start("chat_pi_mismatch"); await f.f.canonical.drain();
  expect(f.httpCalls()).toBe(0);
  expect(await f.data.db.selectFrom("routine_cli_sources").selectAll().execute()).toEqual([]);
  expect(await f.data.db.selectFrom("routine_cli_requests").selectAll().execute()).toEqual([]);
}, 10000);

it.each(["owner", "Chat", "run", "turn", "provider"])("validates canonical %s from retained admission rather than native context", async mismatch => {
  f = await piFixture({ operation: { operation: "list" } });
  const register = f.runtime.registerChat;
  f.runtime.registerChat = input => register({ ...input, ...(mismatch === "provider" ? { provider: "codex" } : {}), input: { ...input.input,
    ...(mismatch === "owner" ? { owner: { type: "personal", ownerId: "user_foreign" } as const } : {}), ...(mismatch === "Chat" ? { chatId: TARGET_A.chatId } : {}),
    ...(mismatch === "run" ? { runId: "run_foreign" } : {}), ...(mismatch === "turn" ? { turnId: "cturn_foreign" } : {}) } });
  await f.start("chat_pi_canonical"); await f.f.canonical.drain();
  expect(f.httpCalls()).toBe(0); expect(await f.data.db.selectFrom("routine_cli_sources").selectAll().execute()).toEqual([]);
}, 10000);

it.each(["0.99.2", "1.0.1", "latest"])("ordinary Pi %s continues without new routine authority", async version => {
  f = await piFixture({ operation: { operation: "list" }, version });
  await f.start("chat_pi_unsupported"); await f.f.canonical.drain();
  expect(f.httpCalls()).toBe(0); expect((await f.frames()).find(frame => frame.prompt).tools).toBe("read,ask_user");
  expect(await f.data.db.selectFrom("routine_cli_sources").selectAll().execute()).toEqual([]);
}, 10000);

it.each(["review", "identity override", "missing FD"])("%s cannot widen native read-only authority", async denial => {
  f = await piFixture({ operation: denial === "identity override" ? { operation: "list", ownerId: "user_foreign", executable: "sh" }
    : { operation: "propose", requestId: "de000000-0000-4000-8000-000000000903", proposal }, noFd: denial === "missing FD" });
  await f.start("chat_pi_denial", { permission: "supervised", interaction: denial === "review" ? "review" : "default" }); await f.f.canonical.drain();
  expect(f.httpCalls()).toBe(0); expect(f.sourceEvents.some(event => event.type === "approval.requested")).toBe(false);
  expect(await f.data.db.selectFrom("routine_cli_requests").selectAll().execute()).toEqual([]);
}, 10000);

it("terminal native call before callback is an irreversible tombstone", async () => {
  f = await piFixture({ operation: { operation: "list" }, terminalBefore: true });
  await f.start("chat_pi_terminal_first"); await f.f.canonical.drain();
  expect(f.httpCalls()).toBe(0); expect(await f.data.db.selectFrom("routine_cli_sources").selectAll().execute()).toEqual([]);
}, 10000);

it.each(["cancel", "terminal"])("%s during owner wait retires only that unconsumed action and retains original UUID", async ending => {
  const requestId = "de000000-0000-4000-8000-000000000904", chatId = "chat_pi_wait";
  f = await piFixture({ operation: { operation: "propose", requestId, proposal }, hold: true });
  const admitted = await f.start(chatId);
  await expect.poll(() => f!.sourceEvents.find(event => event.type === "approval.requested"), { timeout: 5000 }).toMatchObject({ type: "approval.requested" });
  const decision = f.sourceEvents.find(event => event.type === "approval.requested")!;
  if (decision.type !== "approval.requested") throw new Error("Missing exact owner decision");
  f.send({ type: ending === "cancel" ? "fixture_cancel" : "fixture_terminal" });
  await expect.poll(async () => (await f!.frames()).find(frame => frame.result), { timeout: 3000 }).toBeDefined();
  expect(JSON.parse((await f.frames()).find(frame => frame.result).result)).toMatchObject({ data: { kind: "unknown", requestId, reconcile: true } });
  await expect(f.approve(decision, chatId, admitted.run.id)).rejects.toThrow();
  expect(await f.data.db.selectFrom("routine_cli_sources").select("revoked_at").execute()).toEqual([{ revoked_at: null }]);
  expect(await f.data.db.selectFrom("routine_cli_capabilities").selectAll().execute()).toEqual([]);
  expect(f.httpCalls()).toBe(0);
}, 15000);

it.each(["agent_end", "native error", "stdout EOF", "steer", "exit"])("%s fences source immediately while output/publisher drainage remains separate", async ending => {
  f = await piFixture({ operation: { operation: "propose", requestId: "de000000-0000-4000-8000-000000000905", proposal }, hold: true, holdDrain: true });
  let sourceSignal: AbortSignal | undefined;
  const register = f.runtime.registerChat; f.runtime.registerChat = input => { sourceSignal = input.signal; return register(input); };
  await f.start("chat_pi_end");
  await expect.poll(() => f!.sourceEvents.some(event => event.type === "approval.requested"), { timeout: 5000 }).toBe(true);
  if (ending === "agent_end") f.send({ type: "fixture_end" });
  else if (ending === "native error") f.send({ type: "fixture_error" });
  else if (ending === "stdout EOF") f.send({ type: "fixture_eof" });
  else if (ending === "exit") f.children.at(-1)!.kill("SIGKILL");
  else await f.threads.steerTurn(f.f.principal, (await f.threads.listThreads(f.f.principal)).items[0].id, { message: "Steer fixture", clientRequestId: "req_pi_steer" });
  await expect.poll(() => sourceSignal?.aborted, { timeout: 2000 }).toBe(true);
  if (["agent_end", "stdout EOF"].includes(ending)) expect(f.children.at(-1)!.exitCode).toBeNull();
  expect(await f.data.db.selectFrom("routine_cli_requests").selectAll().execute()).toEqual([]);
}, 15000);

it("native duplicate cannot invoke CLI twice", async () => {
  f = await piFixture({ operation: { operation: "list" }, duplicate: true, hold: true });
  await f.start("chat_pi_duplicate");
  await expect.poll(async () => (await f!.frames()).find(frame => frame.duplicate), { timeout: 5000 }).toBeDefined();
  expect(f.httpCalls()).toBe(1); expect(JSON.parse((await f.frames()).find(frame => frame.duplicate).duplicate)).toMatchObject({ error: { code: "unavailable" } });
}, 10000);

it.each(["tool completed", "parent ended"])("committed queued receipt survives %s only according to accepted claim semantics", async ending => {
  const requestId = "de000000-0000-4000-8000-000000000906", chatId = "chat_pi_committed";
  f = await piFixture({ operation: { operation: "propose", requestId, proposal }, hold: true, holdDrain: true });
  let release!: () => void, entered = false, accepted = false, sourceSignal: AbortSignal | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const begin = f.runtime.proposals.beginWithin; f.runtime.proposals.beginWithin = async (tx, input) => { entered = true; await gate; return begin(tx, input); };
  const register = f.runtime.registerChat; f.runtime.registerChat = input => { sourceSignal = input.signal; return register({ ...input, current(invocation) { if (invocation?.accepted) accepted = true; return input.current(invocation); } }); };
  try {
    const admitted = await f.start(chatId);
    await expect.poll(() => f!.sourceEvents.find(event => event.type === "approval.requested"), { timeout: 5000 }).toMatchObject({ type: "approval.requested" });
    const decision = f.sourceEvents.find(event => event.type === "approval.requested")!;
    if (decision.type !== "approval.requested") throw new Error("Missing exact owner decision");
    await f.approve(decision, chatId, admitted.run.id);
    await expect.poll(() => entered, { timeout: 5000 }).toBe(true);
    await expect.poll(async () => (await f!.frames()).find(frame => frame.result), { timeout: 5000 }).toBeDefined();
    const receipt = await f.data.db.selectFrom("routine_cli_requests").selectAll().executeTakeFirstOrThrow(); expect(receipt.source_invocation).not.toHaveProperty("accepted");
    expect(JSON.parse((await f.frames()).find(frame => frame.result).result)).toMatchObject({ data: { receipt: { disposition: "queued", requestId } } });
    await expect.poll(() => f!.observedTerminal(), { timeout: 2000 }).toBeGreaterThan(0);
    if (ending === "parent ended") f.send({ type: "fixture_end" });
    // Stdout source event has an explicit turn/read barrier below rather than elapsed-time waiting.
    if (ending === "parent ended") await expect.poll(() => sourceSignal?.aborted).toBe(true);
    release();
    if (ending === "tool completed") { await expect.poll(async () => await f!.data.db.selectFrom("bot_interactions").select("chat_id").execute(), { timeout: 5000 }).toEqual([{ chat_id: TARGET_A.chatId }]); expect(accepted).toBe(true); }
    else { f.send({ type: "fixture_settle" }); await f.f.canonical.drain(); expect(await f.data.db.selectFrom("bot_interactions").selectAll().execute()).toEqual([]); }
  } finally { release(); }
}, 20000);

it("an issued unconsumed capability cannot survive terminal native call even before asynchronous CLI abort", async () => {
  const requestId = "de000000-0000-4000-8000-000000000907", chatId = "chat_pi_issued";
  f = await piFixture({ operation: { operation: "propose", requestId, proposal }, hold: true });
  const execute = f.runtime.execute; let rejected: string | undefined;
  f.runtime.execute = async input => {
    expect(await f!.data.db.selectFrom("routine_cli_capabilities").select("consumed_at").execute()).toEqual([{ consumed_at: null }]);
    f!.send({ type: "fixture_terminal" }); await expect.poll(() => f!.observedTerminal()).toBeGreaterThan(0);
    try { return await execute(input); } catch (error) { rejected = (error as { code: string }).code; throw error; }
  };
  const admitted = await f.start(chatId);
  await expect.poll(() => f!.sourceEvents.find(event => event.type === "approval.requested"), { timeout: 5000 }).toMatchObject({ type: "approval.requested" });
  const decision = f.sourceEvents.find(event => event.type === "approval.requested")!;
  if (decision.type !== "approval.requested") throw new Error("Missing exact owner decision");
  await f.approve(decision, chatId, admitted.run.id);
  await expect.poll(() => rejected, { timeout: 3000 }).toBe("permission_denied");
  expect(await f.data.db.selectFrom("routine_cli_requests").selectAll().execute()).toEqual([]);
  expect(await f.data.db.selectFrom("bot_interactions").selectAll().execute()).toEqual([]);
}, 15000);

it("parent end after actual canonical claim leaves the accepted target intent independent", async () => {
  const chatId = "chat_pi_claimed", requestId = "de000000-0000-4000-8000-000000000908";
  f = await piFixture({ operation: { operation: "propose", requestId, proposal }, hold: true, holdDrain: true });
  let sourceSignal: AbortSignal | undefined;
  const register = f.runtime.registerChat; f.runtime.registerChat = input => { sourceSignal = input.signal; return register(input); };
  const consume = f.runtime.proposals.consume;
  f.runtime.proposals.consume = async (binding, signal) => {
    expect(await f!.data.db.selectFrom("routine_cli_proposals").select("stage").where("client_request_id", "=", requestId).executeTakeFirstOrThrow()).toMatchObject({ stage: "target_task_claimed" });
    f!.send({ type: "fixture_end" }); await expect.poll(() => sourceSignal?.aborted).toBe(true); return consume(binding, signal);
  };
  const admitted = await f.start(chatId);
  await expect.poll(() => f!.sourceEvents.find(event => event.type === "approval.requested"), { timeout: 5000 }).toMatchObject({ type: "approval.requested" });
  const decision = f.sourceEvents.find(event => event.type === "approval.requested")!;
  if (decision.type !== "approval.requested") throw new Error("Missing exact owner decision");
  await f.approve(decision, chatId, admitted.run.id);
  await expect.poll(async () => await f!.data.db.selectFrom("bot_interactions").select("chat_id").execute(), { timeout: 5000 }).toEqual([{ chat_id: TARGET_A.chatId }]);
}, 15000);

it("changing default invalidates a displayed Pi owner operation without a fallback target", async () => {
  const chatId = "chat_pi_switch", requestId = "de000000-0000-4000-8000-000000000909";
  f = await piFixture({ operation: { operation: "propose", requestId, proposal }, hold: true });
  const admitted = await f.start(chatId);
  await expect.poll(() => f!.sourceEvents.find(event => event.type === "approval.requested"), { timeout: 5000 }).toMatchObject({ type: "approval.requested" });
  const decision = f.sourceEvents.find(event => event.type === "approval.requested")!;
  if (decision.type !== "approval.requested") throw new Error("Missing exact owner decision");
  await f.f.switchDefault(); await expect(f.approve(decision, chatId, admitted.run.id)).rejects.toMatchObject({ code: "revision_conflict" });
  expect(await f.data.db.selectFrom("routine_cli_requests").selectAll().execute()).toEqual([]);
  expect(await f.data.db.selectFrom("bot_interactions").selectAll().execute()).toEqual([]);
}, 15000);

it("native read-only permissions cannot make an archived target eligible or select a fallback", async () => {
  f = await piFixture({ operation: { operation: "list" } });
  await f.data.db.updateTable("chats").set({ lifecycle: "archived" }).where("id", "=", TARGET_A.chatId).execute();
  await f.start("chat_pi_archived"); await f.f.canonical.drain();
  expect(f.httpCalls()).toBe(0); expect(await f.data.db.selectFrom("routine_cli_capabilities").selectAll().execute()).toEqual([]);
}, 10000);
