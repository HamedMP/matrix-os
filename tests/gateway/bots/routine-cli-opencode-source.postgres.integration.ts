import { afterEach, expect, it, vi } from "vitest";
let bootstrap: Record<string, string> | undefined;
// Named native discovery/bootstrap qualification fixture, never production qualification.
vi.mock("../../../packages/gateway/src/coding-agents/opencode-routine-bootstrap.js", async importOriginal => ({
  ...await importOriginal<object>(), prepareOpenCodeRoutineBootstrap: async () => bootstrap ? ({ environment: bootstrap, close: async () => {} }) : undefined,
}));
import { opencodeFixture } from "./routine-cli-opencode-support.js";
import { proposal, TARGET_A } from "./routine-cli-request-support.js";
let f: Awaited<ReturnType<typeof opencodeFixture>> | undefined;
afterEach(async () => { await f?.close(); f = undefined; bootstrap = undefined; vi.unstubAllGlobals(); });
async function fixture(native: Parameters<typeof opencodeFixture>[0]) { f = await opencodeFixture(native); bootstrap = native.noBootstrap ? undefined : f.candidate.environment; return f; }
it.each(["sse-first", "fd-first"] as const)("%s actual admitted OpenCode source invokes the published CLI/private IPC/HTTP/PG after exact owner decision with original UUID", async order => {
  const requestId = "de000000-0000-4000-8000-000000000801", chatId = "chat_opencode_actual_" + order;
  f = await fixture({ order, intent: { args: ["propose", "--input", "-", "--request-id", requestId], stdin: JSON.stringify(proposal) } });
  const admitted = await f.start(chatId);
  await expect.poll(() => f!.sourceEvents.find(event => event.type === "approval.requested"), { timeout: 5000 }).toMatchObject({ type: "approval.requested" });
  const decision = f.sourceEvents.find(event => event.type === "approval.requested")!;
  if (decision.type !== "approval.requested") throw new Error("Missing exact owner operation decision");
  await f.approve(decision, chatId, admitted.run.id); await f.f.canonical.drain();
  const frames = await f.frames(); expect(JSON.parse(frames.find(frame => frame.result).result)).toMatchObject({ v: 1, ok: true, data: { receipt: { requestId, disposition: "queued" } } });
  expect(f.httpCalls()).toBe(1); expect(f.promptCount()).toBe(1);
  expect(f.orderTrace.slice(0, 2)).toEqual(order === "fd-first" ? ["fd-callback", "observed-running"] : ["observed-running", "fd-callback"]);
  expect(await f.data.db.selectFrom("routine_cli_requests").select("client_request_id").execute()).toEqual([{ client_request_id: requestId }]);
  expect(await f.data.db.selectFrom("bot_interactions").select("chat_id").execute()).toEqual([{ chat_id: TARGET_A.chatId }]);
  expect(await f.data.db.selectFrom("bot_routines").selectAll().execute()).toEqual([]);
  const source = await f.data.db.selectFrom("routine_cli_sources").select(["source_context", "revoked_at"]).where("generation", "like", "native_%").executeTakeFirstOrThrow();
  expect(source.source_context).toMatchObject({ harness: "opencode", identity: { chatId, runId: admitted.run.id, kind: "chat_run" } }); expect(source.revoked_at).not.toBeNull();
  expect(JSON.stringify(frames)).not.toMatch(/rcli_|fixture-owner-credential|native_[a-f0-9]{48}/);
}, 15000);

it.each(["session", "message", "call", "agent", "directory", "worktree", "unobserved event", "changed intent"])("rejects a callback with %s mismatch before source issuance", async mismatch => {
  const context = mismatch === "session" ? { sessionID: "ses_foreign" } : mismatch === "message" ? { messageID: "msg_foreign" }
    : mismatch === "call" ? { callID: "call_foreign" } : mismatch === "agent" ? { agent: "plan" }
    : mismatch === "directory" ? { directory: "/foreign" } : mismatch === "worktree" ? { worktree: "/foreign" } : {};
  f = await fixture({ intent: { args: ["list"] }, context, noNativeEvent: mismatch === "unobserved event",
    ...(mismatch === "changed intent" ? { event: { state: { status: "running", input: { intent: { args: ["show", "rt_000000000000000000000001"] } } } } } : {}) });
  await f.start("chat_opencode_mismatch"); await f.f.canonical.drain();
  expect(f.httpCalls()).toBe(0);
  expect(await f.data.db.selectFrom("routine_cli_sources").select("source_id").where("generation", "like", "native_%").execute()).toEqual([]);
  expect(await f.data.db.selectFrom("routine_cli_requests").selectAll().execute()).toEqual([]);
}, 10000);

it.each(["owner", "Chat", "run", "provider"])("checks the real canonical %s admission rather than trusting native labels", async mismatch => {
  f = await fixture({ intent: { args: ["list"] } });
  const register = f.runtime.registerChat;
  f.runtime.registerChat = input => register({ ...input, ...(mismatch === "provider" ? { provider: "codex" } : {}), input: { ...input.input,
    ...(mismatch === "owner" ? { owner: { type: "personal", ownerId: "user_foreign" } as const } : {}),
    ...(mismatch === "Chat" ? { chatId: TARGET_A.chatId } : {}), ...(mismatch === "run" ? { runId: "run_foreign" } : {}) } });
  await f.start("chat_opencode_identity"); await f.f.canonical.drain();
  expect(f.httpCalls()).toBe(0);
  expect(await f.data.db.selectFrom("routine_cli_sources").select("source_id").where("generation", "like", "native_%").execute()).toEqual([]);
}, 10000);

it.each(["native result", "event EOF", "stdout EOF"])("%s synchronously fences source before actual native exit/output drainage", async ending => {
  const requestId = "de000000-0000-4000-8000-000000000802", chatId = "chat_opencode_source_end";
  f = await fixture({ intent: { args: ["propose", "--input", "-", "--request-id", requestId], stdin: JSON.stringify(proposal) }, hold: true });
  let sourceSignal: AbortSignal | undefined, rejected: string | undefined;
  const register = f.runtime.registerChat;
  f.runtime.registerChat = input => { sourceSignal = input.signal; return register(input); };
  const execute = f.runtime.execute;
  f.runtime.execute = async input => {
    if (ending === "native result") { await f!.holdSubmission(); f!.finish(); } else if (ending === "event EOF") f!.eof(); else {
      const { writeFile } = await import("node:fs/promises"); await writeFile(f!.control, JSON.stringify({ type: "eof" }));
    }
    await expect.poll(() => sourceSignal?.aborted, { timeout: 2000 }).toBe(true);
    expect(f!.children.every(child => child.exitCode === null && child.signalCode === null)).toBe(true);
    try { return await execute(input); } catch (error) { rejected = (error as { code: string }).code; throw error; }
  };
  const admitted = await f.start(chatId);
  await expect.poll(() => f!.sourceEvents.find(event => event.type === "approval.requested"), { timeout: 5000 }).toMatchObject({ type: "approval.requested" });
  const decision = f.sourceEvents.find(event => event.type === "approval.requested")!;
  if (decision.type !== "approval.requested") throw new Error("Missing owner operation decision");
  await f.approve(decision, chatId, admitted.run.id);
  await expect.poll(() => sourceSignal?.aborted, { timeout: 2000 }).toBe(true);
  await expect.poll(() => rejected, { timeout: 3000 }).toBe("permission_denied");
  expect(await f.data.db.selectFrom("routine_cli_requests").selectAll().execute()).toEqual([]);
  expect(await f.data.db.selectFrom("bot_interactions").selectAll().execute()).toEqual([]);
}, 15000);

it("native cancellation preserves original UUID as unknown and the finite source remains live", async () => {
  const requestId = "de000000-0000-4000-8000-000000000803";
  f = await fixture({ intent: { args: ["propose", "--input", "-", "--request-id", requestId], stdin: JSON.stringify(proposal) }, hold: true });
  await f.start("chat_opencode_cancel");
  await expect.poll(() => f!.sourceEvents.some(event => event.type === "approval.requested"), { timeout: 5000 }).toBe(true);
  const { writeFile } = await import("node:fs/promises"); await writeFile(f.control, JSON.stringify({ type: "cancel" }));
  await expect.poll(async () => (await f!.frames()).find(frame => frame.result), { timeout: 3000 }).toBeDefined();
  expect(JSON.parse((await f.frames()).find(frame => frame.result).result)).toMatchObject({ data: { kind: "unknown", requestId, reconcile: true } });
  expect(await f.data.db.selectFrom("routine_cli_sources").select("revoked_at").where("generation", "like", "native_%").execute()).toEqual([{ revoked_at: null }]);
  expect(f.httpCalls()).toBe(0);
}, 15000);

it("a repeated observed native call cannot invoke the CLI or owner operation twice", async () => {
  f = await fixture({ intent: { args: ["list"] }, duplicate: true, hold: true });
  await f.start("chat_opencode_duplicate");
  await expect.poll(async () => (await f!.frames()).find(frame => frame.duplicate), { timeout: 5000 }).toBeDefined();
  const frames = await f.frames(); expect(JSON.parse(frames.find(frame => frame.result).result)).toMatchObject({ ok: true });
  expect(JSON.parse(frames.find(frame => frame.duplicate).duplicate)).toMatchObject({ error: { code: "unavailable" } });
  expect(f.httpCalls()).toBe(1);
}, 10000);

it("keeps unqualified bootstrap from issuing a routine source or upgrading ordinary Chat permissions", async () => {
  f = await fixture({ intent: { args: ["list"] }, noBootstrap: true });
  await f.start("chat_opencode_unqualified", { permission: "supervised", interaction: "default" }); await f.f.canonical.drain();
  expect(f.httpCalls()).toBe(0);
  expect(await f.data.db.selectFrom("routine_cli_sources").selectAll().where("generation", "like", "native_%").execute()).toEqual([]);
  expect(f.promptCount()).toBe(1);
}, 10000);

it("a changed default cannot silently retarget an already displayed OpenCode operation", async () => {
  const requestId = "de000000-0000-4000-8000-000000000804", chatId = "chat_opencode_default_switch";
  f = await fixture({ intent: { args: ["propose", "--input", "-", "--request-id", requestId], stdin: JSON.stringify(proposal) } });
  const admitted = await f.start(chatId);
  await expect.poll(() => f!.sourceEvents.find(event => event.type === "approval.requested"), { timeout: 5000 }).toMatchObject({ type: "approval.requested" });
  const decision = f.sourceEvents.find(event => event.type === "approval.requested")!;
  if (decision.type !== "approval.requested") throw new Error("Missing original decision");
  await f.f.switchDefault();
  await expect(f.approve(decision, chatId, admitted.run.id)).rejects.toMatchObject({ code: "revision_conflict" });
  await f.f.canonical.cancelRun({ type: "personal", ownerId: "user_owner_1" }, chatId, admitted.run.id);
  await f.f.canonical.drain();
  expect(await f.data.db.selectFrom("bot_interactions").select("chat_id").execute()).toEqual([]);
  expect(await f.data.db.selectFrom("routine_cli_requests").selectAll().execute()).toEqual([]);
}, 10000);

it.each(["--computer", "--owner", "--chat", "--executable"])("rejects forbidden identity/execution flag %s without an HTTP call", async flag => {
  f = await fixture({ intent: { args: ["list", flag, "foreign"] } });
  await f.start("chat_opencode_override"); await f.f.canonical.drain();
  expect(f.httpCalls()).toBe(0);
  expect(await f.data.db.selectFrom("routine_cli_sources").selectAll().execute()).toEqual([]);
}, 10000);

it("review mode cannot obtain a remote mutation decision from native read-only permission", async () => {
  const requestId = "de000000-0000-4000-8000-000000000805";
  f = await fixture({ intent: { args: ["propose", "--input", "-", "--request-id", requestId], stdin: JSON.stringify(proposal) } });
  await f.start("chat_opencode_review", { permission: "supervised", interaction: "review" }); await f.f.canonical.drain();
  expect(f.promptCount()).toBe(1);
  expect(f.sourceEvents.some(event => event.type === "approval.requested")).toBe(false);
  expect(f.httpCalls()).toBe(0);
  expect(await f.data.db.selectFrom("routine_cli_requests").selectAll().execute()).toEqual([]);
  expect(await f.data.db.selectFrom("bot_interactions").selectAll().execute()).toEqual([]);
}, 10000);


it.each(["completed", "error"] as const)("terminal %s before the first FD callback cannot register a source or capability", async status => {
  f = await fixture({ intent: { args: ["list"] }, terminalBeforeCallback: status, order: "sse-first" });
  await f.start("chat_opencode_terminal_first"); await f.f.canonical.drain();
  expect(f.httpCalls()).toBe(0);
  expect(await f.data.db.selectFrom("routine_cli_sources").selectAll().execute()).toEqual([]);
  expect(await f.data.db.selectFrom("routine_cli_capabilities").selectAll().execute()).toEqual([]);
}, 10000);

it.each(["completed", "error"] as const)("terminal %s during real owner wait cancels only that unconsumed action", async status => {
  const requestId = "de000000-0000-4000-8000-000000000806", chatId = "chat_opencode_terminal_wait";
  f = await fixture({ intent: { args: ["propose", "--input", "-", "--request-id", requestId], stdin: JSON.stringify(proposal) }, hold: true });
  const admitted = await f.start(chatId);
  await expect.poll(() => f!.sourceEvents.find(event => event.type === "approval.requested"), { timeout: 5000 }).toMatchObject({ type: "approval.requested" });
  const decision = f.sourceEvents.find(event => event.type === "approval.requested")!;
  if (decision.type !== "approval.requested") throw new Error("Missing real owner decision");
  await f.terminal(status);
  await expect.poll(async () => (await f!.frames()).find(frame => frame.result), { timeout: 3000 }).toBeDefined();
  await expect(f.approve(decision, chatId, admitted.run.id)).rejects.toThrow();
  expect(f.httpCalls()).toBe(0);
  expect(await f.data.db.selectFrom("routine_cli_sources").select("revoked_at").execute()).toEqual([{ revoked_at: null }]);
  expect(await f.data.db.selectFrom("routine_cli_capabilities").selectAll().execute()).toEqual([]);
  expect(await f.data.db.selectFrom("routine_cli_requests").selectAll().execute()).toEqual([]);
  expect(await f.data.db.selectFrom("bot_interactions").selectAll().execute()).toEqual([]);
}, 15000);

it("an issued but unconsumed capability cannot survive its terminal native call", async () => {
  const requestId = "de000000-0000-4000-8000-000000000807", chatId = "chat_opencode_terminal_consume";
  f = await fixture({ intent: { args: ["propose", "--input", "-", "--request-id", requestId], stdin: JSON.stringify(proposal) }, hold: true });
  const execute = f.runtime.execute; let rejected: string | undefined;
  f.runtime.execute = async input => {
    expect(await f!.data.db.selectFrom("routine_cli_capabilities").select("consumed_at").execute()).toEqual([{ consumed_at: null }]);
    // Actual issued capability, no receipt/consume yet: the accepted-only entry cannot be used.
    const { createRoutineCliSourceService } = await import("../../../packages/gateway/src/bots/routine-cli-source.js");
    const { scope } = await import("./routine-cli-request-support.js");
    const cap = await f!.data.db.selectFrom("routine_cli_capabilities").selectAll().executeTakeFirstOrThrow();
    const source = await f!.data.db.selectFrom("routine_cli_sources").select("source_context").executeTakeFirstOrThrow();
    let acceptedWork = false, lifecycle = false;
    const guard = createRoutineCliSourceService({ db: f!.data.db, scope, validateLifecycle: async () => { lifecycle = true; return true; },
      authorizeOperation: async () => { throw new Error("Unconsumed capability reached acceptance authorization"); } });
    await expect(f!.data.db.transaction().execute(trx => guard.validateAcceptedWithin(trx, { source: source.source_context,
      invocation: { sourceId: cap.source_id, invocationId: cap.invocation_id, operationDigest: cap.operation_digest, accepted: true }, operation: input.operation },
    async () => { acceptedWork = true; }))).rejects.toMatchObject({ code: "permission_denied" });
    expect(acceptedWork).toBe(false); expect(lifecycle).toBe(false);
    await f!.terminal("completed");
    try { return await execute(input); } catch (error) { rejected = (error as { code: string }).code; throw error; }
  };
  const admitted = await f.start(chatId);
  await expect.poll(() => f!.sourceEvents.find(event => event.type === "approval.requested"), { timeout: 5000 }).toMatchObject({ type: "approval.requested" });
  const decision = f.sourceEvents.find(event => event.type === "approval.requested")!;
  if (decision.type !== "approval.requested") throw new Error("Missing real owner decision");
  await f.approve(decision, chatId, admitted.run.id);
  await expect.poll(() => rejected, { timeout: 3000 }).toBe("permission_denied");
  expect(await f.data.db.selectFrom("routine_cli_requests").selectAll().execute()).toEqual([]);
  expect(await f.data.db.selectFrom("routine_cli_capabilities").select("consumed_at").execute()).toEqual([{ consumed_at: null }]);
  expect(await f.data.db.selectFrom("bot_interactions").selectAll().execute()).toEqual([]);
}, 15000);


it.each(["tool completed", "parent ended"] as const)("a real queued receipt survives %s only according to its established claim boundary", async ending => {
  const requestId = "de000000-0000-4000-8000-000000000808", chatId = "chat_opencode_committed_claim";
  f = await fixture({ intent: { args: ["propose", "--input", "-", "--request-id", requestId], stdin: JSON.stringify(proposal) }, hold: true });
  let release!: () => void, claimEntered = false, sourceSignal: AbortSignal | undefined, acceptedObserved = false;
  const claimGate = new Promise<void>(resolve => { release = resolve; });
  const begin = f.runtime.proposals.beginWithin;
  f.runtime.proposals.beginWithin = async (tx, input) => { claimEntered = true; await claimGate; return begin(tx, input); };
  const register = f.runtime.registerChat;
  f.runtime.registerChat = input => { sourceSignal = input.signal; return register({ ...input, current(invocation) {
    if (invocation?.accepted) acceptedObserved = true;
    return input.current(invocation);
  } }); };
  try {
    const admitted = await f.start(chatId);
    await expect.poll(() => f!.sourceEvents.find(event => event.type === "approval.requested"), { timeout: 5000 }).toMatchObject({ type: "approval.requested" });
    const decision = f.sourceEvents.find(event => event.type === "approval.requested")!;
    if (decision.type !== "approval.requested") throw new Error("Missing real owner decision");
    await f.approve(decision, chatId, admitted.run.id);
    await expect.poll(() => claimEntered, { timeout: 5000 }).toBe(true);
    await expect.poll(async () => (await f!.frames()).find(frame => frame.result), { timeout: 5000 }).toBeDefined();
    expect(JSON.parse((await f.frames()).find(frame => frame.result).result)).toMatchObject({ ok: true, data: { receipt: { requestId, disposition: "queued" } } });
    const receipt = await f.data.db.selectFrom("routine_cli_requests").selectAll().executeTakeFirstOrThrow();
    expect(receipt.source_invocation).not.toHaveProperty("accepted"); // never stored from CLI/native/consume input
    expect(await f.data.db.selectFrom("routine_cli_capabilities").select("consumed_at").executeTakeFirstOrThrow()).not.toEqual({ consumed_at: null });
    expect(await f.data.db.selectFrom("bot_tasks").selectAll().execute()).toEqual([]);
    if (ending === "tool completed") await f.terminal("completed"); else { f.finish(); await expect.poll(() => sourceSignal?.aborted).toBe(true); }
    release();
    if (ending === "tool completed") {
      await expect.poll(async () => (await f!.data.db.selectFrom("bot_interactions").select("chat_id").execute()), { timeout: 5000 }).toEqual([{ chat_id: TARGET_A.chatId }]);
      expect(acceptedObserved).toBe(true); expect(sourceSignal?.aborted).toBe(false);
    } else {
      await f.f.canonical.drain();
      expect(await f.data.db.selectFrom("bot_interactions").selectAll().execute()).toEqual([]);
      expect(await f.data.db.selectFrom("bot_tasks").selectAll().execute()).toEqual([]);
    }
  } finally { release(); }
}, 20000);

it("whole parent end after actual canonical claim does not undo the accepted target intent", async () => {
  const requestId = "de000000-0000-4000-8000-000000000809", chatId = "chat_opencode_post_claim";
  f = await fixture({ intent: { args: ["propose", "--input", "-", "--request-id", requestId], stdin: JSON.stringify(proposal) }, hold: true });
  const consume = f.runtime.proposals.consume;
  let sourceSignal: AbortSignal | undefined;
  const register = f.runtime.registerChat;
  f.runtime.registerChat = input => { sourceSignal = input.signal; return register(input); };
  f.runtime.proposals.consume = async (binding, signal) => {
    expect(await f!.data.db.selectFrom("routine_cli_proposals").select("stage").where("client_request_id", "=", requestId).executeTakeFirstOrThrow()).toMatchObject({ stage: "target_task_claimed" });
    f!.finish(); await expect.poll(() => sourceSignal?.aborted).toBe(true); return consume(binding, signal);
  };
  const admitted = await f.start(chatId);
  await expect.poll(() => f!.sourceEvents.find(event => event.type === "approval.requested"), { timeout: 5000 }).toMatchObject({ type: "approval.requested" });
  const decision = f.sourceEvents.find(event => event.type === "approval.requested")!;
  if (decision.type !== "approval.requested") throw new Error("Missing real owner decision");
  await f.approve(decision, chatId, admitted.run.id);
  await expect.poll(async () => (await f!.data.db.selectFrom("bot_interactions").select("chat_id").execute()), { timeout: 5000 }).toEqual([{ chat_id: TARGET_A.chatId }]);
  expect(await f.data.db.selectFrom("bot_routines").selectAll().execute()).toEqual([]);
}, 15000);
