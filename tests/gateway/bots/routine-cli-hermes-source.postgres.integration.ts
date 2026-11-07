import { afterEach, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
// Named native pin/API/bootstrap fixture. It does not mock source admission, registry, CLI or canonical backend.
vi.mock("../../../packages/gateway/src/chat/hermes-routine-bootstrap.js", () => ({ hermesRoutineBootstrap: async (_root: string, args: string[]) => args }));
import { hermesFixture } from "./routine-cli-hermes-support.js";
import { insertRoutine, proposal, routineId, TARGET_A } from "./routine-cli-request-support.js";
let f: Awaited<ReturnType<typeof hermesFixture>> | undefined;
afterEach(async () => { await f?.close(); f = undefined; vi.unstubAllGlobals(); });

async function pauseFixture(requestId: string, options: { hold?: boolean; duplicate?: boolean } = {}) {
  f = await hermesFixture({ ...options, intent: { args: ["pause", routineId(700), "--revision", "1", "--request-id", requestId] } });
  await insertRoutine(f.data.db, 700);
  return f;
}

it("admitted Hermes controls an existing routine through the published CLI with exact owner decision and original UUID", async () => {
  const requestId = "de000000-0000-4000-8000-000000000701", chatId = "chat_hermes_actual";
  f = await pauseFixture(requestId);
  const admitted = await f.start(chatId);
  await expect.poll(() => f!.sourceEvents.find(event => event.type === "approval.requested"), { timeout: 5000 }).toMatchObject({ type: "approval.requested" });
  const event = f.sourceEvents.find(event => event.type === "approval.requested")!;
  if (event.type !== "approval.requested") throw new Error("Missing exact owner operation decision");
  await f.approve(event, chatId, admitted.run.id); await f.f.canonical.drain();
  const frames = await f.frames(), result = frames.find(frame => frame.privateResult?.type === "result").privateResult;
  expect(JSON.parse(result.result)).toMatchObject({ v: 1, ok: true, data: {
    receipt: { requestId, disposition: "applied", routine: { routineId: routineId(700), status: "paused", revision: 2 } },
  } });
  expect(result.context).toMatchObject({ session_id: "native_durable", tool_call_id: "native_call" });
  expect(f.httpCalls()).toBe(1);
  expect(await f.data.db.selectFrom("routine_cli_requests").select("client_request_id").execute()).toEqual([{ client_request_id: requestId }]);
  expect(await f.data.db.selectFrom("bot_interactions").select("chat_id").execute()).toEqual([]);
  expect(await f.data.db.selectFrom("bot_routines").select("status").execute()).toEqual([{ status: "paused" }]);
  const source = await f.data.db.selectFrom("routine_cli_sources").select(["source_context", "revoked_at"]).where("generation", "like", "native_%").executeTakeFirstOrThrow();
  expect(source.source_context).toMatchObject({ harness: "hermes", identity: { chatId, runId: admitted.run.id, kind: "chat_run" } });
  expect(source.revoked_at).not.toBeNull();
  expect(JSON.stringify(frames)).not.toMatch(/RoutineCapability|rcli_|fixture-owner-credential|platform-claude-consent|native_[a-f0-9]{48}/);
}, 20_000);

it("declines a new Hermes proposal while the owner catalog's native scheduling capability is unverified", async () => {
  const requestId = "de000000-0000-4000-8000-000000000707";
  f = await hermesFixture({ intent: { args: ["propose", "--input", "-", "--request-id", requestId], stdin: JSON.stringify(proposal) } });
  await f.start("chat_hermes_creation"); await f.f.canonical.drain();
  const result = (await f.frames()).find(frame => frame.privateResult?.type === "result").privateResult;
  expect(JSON.parse(result.result)).toMatchObject({ v: 1, error: { code: "permission_denied" } });
  expect(f.sourceEvents.some(event => event.type === "approval.requested")).toBe(false);
  expect(f.httpCalls()).toBe(0);
  expect(await f.data.db.selectFrom("routine_cli_requests").selectAll().execute()).toEqual([]);
  expect(await f.data.db.selectFrom("bot_tasks").selectAll().execute()).toEqual([]);
}, 15_000);

it.each(["owner", "Chat", "run", "provider"])("rejects mismatched canonical %s without relabeling source", async mismatch => {
  f = await hermesFixture({ intent: { args: ["list"] } });
  const register = f.runtime.registerChat;
  f.runtime.registerChat = options => register({ ...options, ...(mismatch === "provider" ? { provider: "codex" } : {}), input: { ...options.input,
    ...(mismatch === "owner" ? { owner: { type: "personal", ownerId: "user_foreign" } as const } : {}),
    ...(mismatch === "Chat" ? { chatId: TARGET_A.chatId } : {}), ...(mismatch === "run" ? { runId: "run_foreign" } : {}) } });
  await f.start("chat_hermes_mismatch"); await f.f.canonical.drain();
  expect(f.httpCalls()).toBe(0);
  expect(await f.data.db.selectFrom("routine_cli_sources").select("source_id").where("generation", "like", "native_%").execute()).toEqual([]);
}, 15_000);

it.each(["missing catalog", "identity argument", "raw RPC context", "invalid context"])("denies %s with no fabricated source or receipt", async denial => {
  const context = { task_id: "task", session_id: "session", turn_id: "turn", tool_call_id: "call", api_request_id: "api" };
  f = await hermesFixture({ intent: { args: ["list"] }, missingCatalog: denial === "missing catalog", ...(denial === "missing catalog" ? {} : { frame: {
    type: "call", id: "de000000-0000-4000-8000-000000000704", context: denial === "invalid context" ? { ...context, turn_id: "" } : context,
    intent: denial === "identity argument" ? { args: ["list"], ownerId: "user_owner_1" } : { args: ["list"] },
    ...(denial === "raw RPC context" ? { runId: "run_fake" } : {}),
  } }) });
  await f.start("chat_hermes_denied"); await f.f.canonical.drain();
  expect(f.httpCalls()).toBe(0);
  expect(await f.data.db.selectFrom("routine_cli_sources").select("source_id").where("generation", "like", "native_%").execute()).toEqual([]);
  expect(await f.data.db.selectFrom("routine_cli_requests").selectAll().execute()).toEqual([]);
}, 15_000);

it.each(["end", "eof"])("native %s fences authorized HTTP consume before real child exit/pipe drainage", async ending => {
  const requestId = "de000000-0000-4000-8000-000000000702", chatId = "chat_hermes_consume_end";
  f = await pauseFixture(requestId, { hold: true });
  const register = f.runtime.registerChat; let revokedBeforeExit = false;
  f.runtime.registerChat = async input => { const source = await register(input); return { ...source, async revoke() {
    revokedBeforeExit = f!.children.every(child => child.exitCode === null && child.signalCode === null);
    await source.revoke();
  } }; };
  const execute = f.runtime.execute; let rejected: string | undefined;
  f.runtime.execute = async input => {
    await writeFile(f!.control, ending);
    await expect.poll(async () => (await f!.data.db.selectFrom("routine_cli_sources").select("revoked_at").where("generation", "like", "native_%").executeTakeFirst())?.revoked_at, { timeout: 2000 }).not.toBeNull();
    try { return await execute(input); } catch (error) { rejected = (error as { code?: string }).code; throw error; }
  };
  const admitted = await f.start(chatId);
  await expect.poll(() => f!.sourceEvents.find(event => event.type === "approval.requested"), { timeout: 5000 }).toMatchObject({ type: "approval.requested" });
  const event = f.sourceEvents.find(event => event.type === "approval.requested")!;
  if (event.type !== "approval.requested") throw new Error("Missing exact decision");
  await f.approve(event, chatId, admitted.run.id);
  await expect.poll(() => rejected, { timeout: 3000 }).toBe("permission_denied");
  expect(revokedBeforeExit).toBe(true);
  expect(await f.data.db.selectFrom("routine_cli_requests").selectAll().execute()).toEqual([]);
  expect(await f.data.db.selectFrom("bot_approvals").selectAll().execute()).toEqual([]);
  expect(await f.data.db.selectFrom("bot_routines").select("status").execute()).toEqual([{ status: "active" }]);
}, 20_000);

it("private cancellation aborts only the exact action, preserves original UUID as unknown and keeps source live", async () => {
  const requestId = "de000000-0000-4000-8000-000000000703";
  f = await pauseFixture(requestId, { hold: true });
  await f.start("chat_hermes_cancel");
  await expect.poll(() => f!.sourceEvents.some(event => event.type === "approval.requested"), { timeout: 5000 }).toBe(true);
  await writeFile(f.control, "cancel");
  await expect.poll(async () => (await f!.frames()).find(frame => frame.privateResult?.type === "result"), { timeout: 3000 }).toBeDefined();
  const result = (await f.frames()).find(frame => frame.privateResult?.type === "result").privateResult;
  expect(JSON.parse(result.result)).toMatchObject({ data: { kind: "unknown", requestId, reconcile: true } });
  expect(await f.data.db.selectFrom("routine_cli_sources").select("revoked_at").where("generation", "like", "native_%").execute()).toEqual([{ revoked_at: null }]);
  expect(f.httpCalls()).toBe(0);
  expect(await f.data.db.selectFrom("routine_cli_requests").selectAll().execute()).toEqual([]);
}, 15_000);

it("retains native review-mode rejection before a new source or process can be installed", async () => {
  f = await hermesFixture({ intent: { args: ["list"] } });
  await f.start("chat_hermes_review", { permission: "full_access", interaction: "review" });
  await f.f.canonical.drain();
  expect(f.children).toHaveLength(0); expect(f.httpCalls()).toBe(0);
  expect(await f.data.db.selectFrom("routine_cli_sources").select("source_id").where("generation", "like", "native_%").execute()).toEqual([]);
}, 10_000);

it("duplicate native callback identity cannot create a second CLI process, approval or control", async () => {
  const requestId = "de000000-0000-4000-8000-000000000706", chatId = "chat_hermes_duplicate";
  f = await pauseFixture(requestId, { duplicate: true, hold: true });
  const admitted = await f.start(chatId);
  await expect.poll(() => f!.sourceEvents.find(event => event.type === "approval.requested"), { timeout: 5000 }).toMatchObject({ type: "approval.requested" });
  const event = f.sourceEvents.find(event => event.type === "approval.requested")!;
  if (event.type !== "approval.requested") throw new Error("Missing exact decision");
  await f.approve(event, chatId, admitted.run.id);
  await expect.poll(async () => (await f!.frames()).some(frame => frame.privateResult?.type === "result" && JSON.parse(frame.privateResult.result).data?.receipt), { timeout: 5000 }).toBe(true);
  await writeFile(f.control, "end"); await f.f.canonical.drain();
  expect(f.httpCalls()).toBe(1);
  expect(f.sourceEvents.filter(event => event.type === "approval.requested")).toHaveLength(1);
  expect(await f.data.db.selectFrom("routine_cli_requests").select("client_request_id").execute()).toEqual([{ client_request_id: requestId }]);
  expect(await f.data.db.selectFrom("bot_routines").select("status").execute()).toEqual([{ status: "paused" }]);
  expect(await f.data.db.selectFrom("bot_tasks").selectAll().execute()).toEqual([]);
}, 15_000);

it("lost private enable ACK disables routine issuance without replaying or replacing the ordinary native prompt", async () => {
  f = await hermesFixture({ intent: { args: ["list"] }, loseEnableAck: true });
  await f.start("chat_hermes_lost_enable"); await f.f.canonical.drain();
  expect((await f.frames()).filter(frame => frame.rpc?.method === "prompt.submit")).toHaveLength(1);
  expect(f.httpCalls()).toBe(0);
  expect(await f.data.db.selectFrom("routine_cli_sources").select("source_id").where("generation", "like", "native_%").execute()).toEqual([]);
}, 10_000);
