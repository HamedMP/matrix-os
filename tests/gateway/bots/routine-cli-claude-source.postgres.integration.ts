import { afterEach, expect, it, vi } from "vitest";
import * as routineDisplay from "../../../packages/gateway/src/chat/routine-result-artifacts.js";
import { insertRoutine } from "./routine-cli-request-support.js";
import { claudeFixture, nativeProtocol, proposal, TARGET_A } from "./routine-cli-claude-support.js";
let f: Awaited<ReturnType<typeof claudeFixture>>;
afterEach(async () => { await f?.close(); vi.unstubAllGlobals(); });

it.each(["setup", "cleanup"])("Claude completes the Chat when routine display %s fails", async failure => {
  const original = routineDisplay.createRoutineResultArtifacts;
  const createArtifacts = vi.spyOn(routineDisplay, "createRoutineResultArtifacts").mockImplementationOnce(async () => {
    if (failure === "setup") throw new Error("Fixture display setup failure");
    const artifacts = await original();
    return { ...artifacts, async close() {
      await artifacts.close();
      throw new Error("Fixture display cleanup failure");
    } };
  });
  try {
    f = await claudeFixture();
    const requestId = "de000000-0000-4000-8000-000000000504";
    const routineId = await insertRoutine(f.data.db, 504);
    const native = nativeProtocol(`matrix routines pause ${routineId} --revision 1 --request-id ${requestId}`);
    const adapter = f.adapter(native.spawn);
    let streamFailure: unknown;
    f.setSourceAdapter({ ...adapter, async *start(input) {
      try { yield* adapter.start(input); }
      catch (error: unknown) { streamFailure = error; throw error; }
    } });
    const chatId = "chat_claude_display_failure";
    const admitted = await f.start(chatId);
    const readApproval = () => f.sourceEvents.find(event => event.type === "approval.requested");
    await expect.poll(readApproval, { timeout: 5000 }).toBeDefined();
    const approval = readApproval()!;
    if (approval.type !== "approval.requested") throw new Error("Missing routine operation approval");
    await f.approve(approval, chatId, admitted.run.id);
    await expect.poll(() => !!native.display() || native.denied(), { timeout: 5000 }).toBe(true);
    if (native.display()) native.end();
    await f.f.canonical.drain();

    expect(createArtifacts).toHaveBeenCalledOnce();
    expect(streamFailure).toBeUndefined();
    expect(f.sourceEvents).toContainEqual({ type: "run.completed", outcome: "completed" });
    expect(f.httpCalls()).toBe(1);
    expect(await f.data.db.selectFrom("bot_routines").select("status").execute()).toEqual([{ status: "paused" }]);
  } finally {
    createArtifacts.mockRestore();
  }
});
it("real admitted Claude execute closure registers current source, runs published CLI and canonical backend; CLI return keeps source alive until actual process exit", async () => {
  f = await claudeFixture();
  const chatId = "chat_claude_actual", uuid = "de000000-0000-4000-8000-000000000501";
  const native = nativeProtocol(`matrix routines propose --input - --request-id ${uuid} <<'MATRIX_ROUTINE_JSON'\n${JSON.stringify(proposal)}\nMATRIX_ROUTINE_JSON`);
  f.adapter(native.spawn); const admitted = await f.start(chatId);
  const input = { owner: { ownerId: "user_owner_1" }, chatId, runId: admitted.run.id };
  for (let i = 0; i < 300 && !f.sourceEvents.some(event => event.type === "approval.requested"); i++) await new Promise(resolve => setTimeout(resolve, 10));
  const approval = f.sourceEvents.find(event => event.type === "approval.requested"); expect(approval?.type).toBe("approval.requested");
  await f.approve(approval as Extract<typeof approval, { type: "approval.requested" }>, chatId, input.runId);
  for (let i = 0; i < 1000 && !native.display(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  expect(native.promptCount()).toBe(1); expect(native.display()).toMatchObject({ ok: true, data: { receipt: { requestId: uuid, disposition: "queued" } } });
  expect(f.httpCalls()).toBe(1);
  for (let i = 0; i < 100; i++) { if ((await f.data.db.selectFrom("bot_tasks").select("status").execute())[0]?.status === "waiting_person") break; await new Promise(resolve => setTimeout(resolve, 10)); }
  expect(await f.data.db.selectFrom("bot_tasks").select("status").execute()).toEqual([{ status: "waiting_person" }]);
  expect(await f.data.db.selectFrom("bot_interactions").select("chat_id").execute()).toEqual([{ chat_id: TARGET_A.chatId }]);
  expect(await f.data.db.selectFrom("routine_cli_sources").select("revoked_at").where("source_context", "is not", null).execute()).toEqual(expect.arrayContaining([{ revoked_at: null }]));
  const source = await f.data.db.selectFrom("routine_cli_sources").selectAll().where("generation", "like", "native_%").executeTakeFirstOrThrow();
  expect(source.source_context).toMatchObject({ identity: { kind: "chat_run", chatId: input.chatId, runId: input.runId }, ownerId: input.owner.ownerId, harness: "claude" });
  expect(JSON.stringify(native.frames)).not.toMatch(/rcli_|RoutineCapability|fixture-owner-credential|platform-claude-consent/);
  native.end(); await f.f.canonical.drain();
  expect((await f.data.db.selectFrom("routine_cli_sources").select("revoked_at").where("source_id", "=", source.source_id).executeTakeFirstOrThrow()).revoked_at).not.toBeNull();
  expect(await f.data.db.selectFrom("bot_approvals").selectAll().execute()).toHaveLength(1);
  expect(await f.data.db.selectFrom("bot_routines").selectAll().execute()).toHaveLength(0);
});
it.each(["unknown-version", "review", "cancel"])('fails closed for %s without owner credential/source fallback', async condition => {
  f = await claudeFixture(); const chatId = "chat_claude_negative";
  const native = nativeProtocol(`matrix routines propose --input - --request-id de000000-0000-4000-8000-000000000502 <<'MATRIX_ROUTINE_JSON'\n${JSON.stringify(proposal)}\nMATRIX_ROUTINE_JSON`, condition === "unknown-version" ? "0.0.0" : undefined);
  const adapter = f.adapter(native.spawn); const admitted = await f.start(chatId, condition === "review" ? { permission: "full_access", interaction: "review" } : undefined);
  if (condition === "cancel") {
    for (let i = 0; i < 200 && !f.sourceEvents.some(event => event.type === "approval.requested"); i++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(f.sourceEvents.some(event => event.type === "approval.requested")).toBe(true);
    await adapter.cancel!({ owner: { type: "personal", ownerId: "user_owner_1" }, chatId, runId: admitted.run.id });
  }
  await f.f.canonical.drain(); expect(f.httpCalls()).toBe(0); expect(await f.data.db.selectFrom("routine_cli_requests").selectAll().execute()).toEqual([]);
  expect(await f.data.db.selectFrom("bot_approvals").selectAll().execute()).toEqual([]);
});
it("actual source end before real target claim rejects the claim while preserving the original immutable queued receipt", async () => {
  f = await claudeFixture(); const requestId = "de000000-0000-4000-8000-000000000503", chatId = "chat_claude_ended";
  const native = nativeProtocol(`matrix routines propose --input - --request-id ${requestId} <<'MATRIX_ROUTINE_JSON'\n${JSON.stringify(proposal)}\nMATRIX_ROUTINE_JSON`);
  const begin = f.runtime.proposals.beginWithin;
  f.runtime.proposals.beginWithin = async (...args) => { native.end(); await new Promise(resolve => setTimeout(resolve, 10)); return begin(...args); };
  f.adapter(native.spawn); const admitted = await f.start(chatId);
  for (let i = 0; i < 300 && !f.sourceEvents.some(event => event.type === "approval.requested"); i++) await new Promise(resolve => setTimeout(resolve, 10));
  const approval = f.sourceEvents.find(event => event.type === "approval.requested"); expect(approval?.type).toBe("approval.requested");
  await f.approve(approval as Extract<typeof approval, { type: "approval.requested" }>, chatId, admitted.run.id);
  await f.f.canonical.drain();
  expect(await f.data.db.selectFrom("bot_tasks").selectAll().execute()).toEqual([]); expect(await f.data.db.selectFrom("bot_approvals").selectAll().execute()).toEqual([]);
  const receipt = await f.data.db.selectFrom("routine_cli_requests").select(["client_request_id", "admission"]).executeTakeFirstOrThrow();
  expect(receipt).toEqual({ client_request_id: requestId, admission: { disposition: "queued" } }); expect(f.httpCalls()).toBe(1);
});
