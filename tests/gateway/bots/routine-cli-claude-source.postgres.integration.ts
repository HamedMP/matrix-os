import { afterEach, expect, it, vi } from "vitest";
import { claudeFixture, nativeProtocol, proposal } from "./routine-cli-claude-support.js";
import { insertRoutine } from "./routine-cli-request-support.js";
let f: Awaited<ReturnType<typeof claudeFixture>>;
afterEach(async () => { await f?.close(); vi.unstubAllGlobals(); });
it("admitted Claude controls an existing routine through the published CLI and keeps the source live until process exit", async () => {
  f = await claudeFixture();
  const chatId = "chat_claude_actual", uuid = "de000000-0000-4000-8000-000000000501";
  const routineId = await insertRoutine(f.data.db, 501);
  const native = nativeProtocol(`matrix routines pause ${routineId} --revision 1 --request-id ${uuid}`);
  f.adapter(native.spawn); const admitted = await f.start(chatId);
  const input = { owner: { ownerId: "user_owner_1" }, chatId, runId: admitted.run.id };
  for (let i = 0; i < 300 && !f.sourceEvents.some(event => event.type === "approval.requested"); i++) await new Promise(resolve => setTimeout(resolve, 10));
  const approval = f.sourceEvents.find(event => event.type === "approval.requested"); expect(approval?.type).toBe("approval.requested");
  await f.approve(approval as Extract<typeof approval, { type: "approval.requested" }>, chatId, input.runId);
  for (let i = 0; i < 1000 && !native.display(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  expect(native.promptCount()).toBe(1);
  expect(native.display()).toMatchObject({ ok: true, data: { receipt: { requestId: uuid, disposition: "applied", routine: { routineId, status: "paused", revision: 2 } } } });
  expect(f.httpCalls()).toBe(1);
  expect(await f.data.db.selectFrom("routine_cli_sources").select("revoked_at").where("source_context", "is not", null).execute()).toEqual(expect.arrayContaining([{ revoked_at: null }]));
  const source = await f.data.db.selectFrom("routine_cli_sources").selectAll().where("generation", "like", "native_%").executeTakeFirstOrThrow();
  expect(source.source_context).toMatchObject({ identity: { kind: "chat_run", chatId: input.chatId, runId: input.runId }, ownerId: input.owner.ownerId, harness: "claude" });
  expect(JSON.stringify(native.frames)).not.toMatch(/rcli_|RoutineCapability|fixture-owner-credential|platform-claude-consent/);
  native.end(); await f.f.canonical.drain();
  expect((await f.data.db.selectFrom("routine_cli_sources").select("revoked_at").where("source_id", "=", source.source_id).executeTakeFirstOrThrow()).revoked_at).not.toBeNull();
  expect(await f.data.db.selectFrom("bot_approvals").selectAll().execute()).toEqual([]);
  expect(await f.data.db.selectFrom("bot_routines").select(["routine_id", "status"]).execute()).toEqual([{ routine_id: routineId, status: "paused" }]);
});
it.each(["unknown-version", "review", "cancel"])('fails closed for %s without owner credential/source fallback', async condition => {
  f = await claudeFixture(); const chatId = "chat_claude_negative";
  const routineId = await insertRoutine(f.data.db, 502);
  const native = nativeProtocol(`matrix routines pause ${routineId} --revision 1 --request-id de000000-0000-4000-8000-000000000502`, condition === "unknown-version" ? "0.0.0" : undefined);
  const adapter = f.adapter(native.spawn); const admitted = await f.start(chatId, condition === "review" ? { permission: "full_access", interaction: "review" } : undefined);
  if (condition === "cancel") {
    for (let i = 0; i < 200 && !f.sourceEvents.some(event => event.type === "approval.requested"); i++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(f.sourceEvents.some(event => event.type === "approval.requested")).toBe(true);
    await adapter.cancel!({ owner: { type: "personal", ownerId: "user_owner_1" }, chatId, runId: admitted.run.id });
  }
  await f.f.canonical.drain(); expect(f.httpCalls()).toBe(0); expect(await f.data.db.selectFrom("routine_cli_requests").selectAll().execute()).toEqual([]);
  expect(await f.data.db.selectFrom("bot_approvals").selectAll().execute()).toEqual([]);
  expect(await f.data.db.selectFrom("bot_routines").select("status").execute()).toEqual([{ status: "active" }]);
});
it("admitted Claude refuses a new Matrix proposal before requesting owner approval or contacting the backend", async () => {
  f = await claudeFixture(); const requestId = "de000000-0000-4000-8000-000000000503", chatId = "chat_claude_native_creation";
  const native = nativeProtocol(`matrix routines propose --input - --request-id ${requestId} <<'MATRIX_ROUTINE_JSON'\n${JSON.stringify(proposal)}\nMATRIX_ROUTINE_JSON`);
  f.adapter(native.spawn); await f.start(chatId);
  await f.f.canonical.drain();
  expect(native.promptCount()).toBe(1);
  expect(native.display()).toMatchObject({ v: 1, error: { code: "permission_denied" } });
  expect(f.sourceEvents.some(event => event.type === "approval.requested")).toBe(false);
  expect(f.httpCalls()).toBe(0);
  expect(await f.data.db.selectFrom("bot_tasks").selectAll().execute()).toEqual([]); expect(await f.data.db.selectFrom("bot_approvals").selectAll().execute()).toEqual([]);
  expect(await f.data.db.selectFrom("routine_cli_requests").selectAll().execute()).toEqual([]);
});
