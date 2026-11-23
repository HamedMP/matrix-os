import { randomUUID } from "node:crypto";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CanonicalCreateChatTurnRequest } from "@matrix-os/contracts";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { createCanonicalChatRoutes } from "../../packages/gateway/src/chat/routes.js";
import { createCanonicalChatService } from "../../packages/gateway/src/chat/service.js";
import { admitCanonicalTurn, type TurnAdmissionOptions } from "../../packages/gateway/src/chat/turn-admission.js";
import { enqueueCanonicalQueuedTurn } from "../../packages/gateway/src/chat/queue-admission.js";
import { CanonicalChatProviderRegistry } from "../../packages/gateway/src/chat/provider-adapter.js";
import { SlackPersonalService } from "../../packages/gateway/src/slack/personal-service.js";
import { bootstrapSlackPersonalDatabase, SlackPersonalRepository, type SlackPersonalDatabase } from "../../packages/gateway/src/slack/personal-database.js";
import type { RequestPrincipal } from "../../packages/gateway/src/request-principal.js";
import { ownerHttpInputProvenance } from "../../packages/gateway/src/chat/owner-http-input.js";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat.js";

const owner = { type: "personal" as const, ownerId: "user_http_origin" };
const principal = { userId: owner.ownerId, source: "jwt" as const };
const chatId = "chat_http_origin";
const now = new Date("2026-11-20T08:00:00.000Z");
const { providerCatalog } = createCanonicalChatFixture("accepted");
const instance = providerCatalog.instances.find(i => i.availability === "available")!;
instance.supports.steering = "same_run";
const selection = { instanceId: instance.id, model: instance.models[0]!.id };
function body(clientRequestId: string, baseRevision = 0): CanonicalCreateChatTurnRequest {
  return { clientRequestId, baseRevision, parts: [{ type: "text", text: "Summarize new discussions immediately." }],
    selection, interactionMode: "default", permissionMode: "supervised" };
}

describe("durable authenticated owner HTTP Chat input", () => {
  let repository: ChatRepository;
  let admin: Kysely<Record<string, never>>;
  let schema: string;
  let deps: TurnAdmissionOptions;
  let service: ReturnType<typeof createCanonicalChatService>;
  beforeEach(async () => {
    const connectionString = process.env.MATRIX_TEST_POSTGRES_URL;
    if (!connectionString || !new URL(connectionString).pathname.includes("test")) throw new Error("Dedicated MATRIX_TEST_POSTGRES_URL required");
    schema = `chat_origin_${randomUUID().replaceAll("-", "")}`;
    admin = new Kysely({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 1 }) }) });
    await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
    repository = new ChatRepository(new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 3,
      options: `-c search_path=${schema} -c statement_timeout=10000` }) }));
    await repository.bootstrap();
    await repository.create(owner, { id: chatId, clientRequestId: "req_create", title: "Owner instruction" });
    const adapters = new CanonicalChatProviderRegistry([{ driverKind: instance.driverKind, stateSchemaVersion: 1,
      parseState: value => value, serializeState: value => value,
      async *start() { throw new Error("No provider invocation authorized"); } }]);
    deps = { repository, catalog: { getCatalog: async () => providerCatalog }, adapters,
      now: () => now, assertOpen() {}, assertPersonalExecutionAllowed: async () => {},
      reconcileActiveRuns: async () => {}, reservePendingDispatch() {}, releasePendingDispatch() {},
      atCapacity: () => false, hasStoppingExecution: () => false, startDispatch: async () => {} };
    // Keep all ingress parsing and admission/storage real; intercept only provider dispatch.
    service = { ...createCanonicalChatService(repository),
      admitTurn: (p, o, id, input, provenance) => admitCanonicalTurn(deps, p, o, id, input, provenance),
      enqueueQueuedTurn: (p, o, id, input, provenance) => enqueueCanonicalQueuedTurn({
        ...deps, principal: p, owner: o, chatId: id, input, provenance, now: () => now }) };
  });
  afterEach(async () => {
    await repository?.kysely.destroy();
    if (admin) { await sql`DROP SCHEMA IF EXISTS ${sql.id(schema)} CASCADE`.execute(admin); await admin.destroy(); }
  });
  function routes(p: RequestPrincipal = principal) {
    return createCanonicalChatRoutes({ service, getPrincipal: () => p });
  }
  function post(input: unknown, path = "turns", p: RequestPrincipal = principal) {
    return routes(p).request(`/api/chats/${chatId}/${path}`, { method: "POST",
      headers: { "content-type": "application/json", "x-matrix-owner-http-input": "true" }, body: JSON.stringify(input) });
  }
  async function origin(table: "chat_turns" | "chat_queued_turns", requestId: string) {
    return (await sql<{ owner_http_input: boolean }>`SELECT owner_http_input FROM ${sql.table(table)} WHERE client_request_id = ${requestId}`
      .execute(repository.kysely)).rows[0]?.owner_http_input;
  }
  async function internal(requestId = "req_internal") {
    return service.admitTurn({ ...principal, source: "platform-verified" }, owner, chatId, body(requestId));
  }
  async function finish(runId: string) {
    await repository.finishRun(owner, { chatId, runId, outcome: "failed", completedAt: now.toISOString() });
  }
  it.each(["jwt", "platform-verified"] as const)("persists positive %s HTTP origin before dispatch without exposing it in the response", async source => {
    let observed: boolean | undefined;
    deps.startDispatch = async () => { observed = await origin("chat_turns", "req_owner"); };
    const response = await post(body("req_owner"), "turns", { ...principal, source });
    expect(response.status).toBe(202);
    expect(await origin("chat_turns", "req_owner")).toBe(true);
    await expect.poll(() => observed).toBe(true);
    expect(await response.text()).not.toMatch(/owner_http_input|ownerHttpInput/);
  });
  it.each(["dev-default", "configured-container"] as const)("allows ordinary %s Chat without granting rule authority even with a forged header", async source => {
    expect((await post(body("req_fallback"), "turns", { ...principal, source })).status).toBe(202);
    expect(await origin("chat_turns", "req_fallback")).toBe(false);
  });
  it("keeps internally admitted Slack/automation input unknown with no receipt dependency and cannot upgrade it on HTTP replay", async () => {
    const accepted = await internal();
    expect(await origin("chat_turns", "req_internal")).toBe(false);
    // No Slack accepted pointer exists yet, and deleting/expiring Slack receipts cannot change canonical origin.
    expect((await post(body("req_internal"))).status).toBe(202);
    expect(await origin("chat_turns", "req_internal")).toBe(false);
    await finish(accepted.run.id);
    expect(await origin("chat_turns", "req_internal")).toBe(false);
  });
  it("keeps actual Slack DM input unknown before its accepted pointer and after receipt expiry", async () => {
    const slackDb = repository.kysely as unknown as Kysely<SlackPersonalDatabase>;
    await bootstrapSlackPersonalDatabase(slackDb);
    let requestId: string | undefined;
    let observedBeforePointer: boolean | undefined;
    const slack = new SlackPersonalService({ db: slackDb, ownerId: owner.ownerId, now: () => now,
      resolvePersonalChat: async () => ({ chatId, botId: "bot_aaaaaaaa" }),
      submitPersonal: async record => {
        requestId = record.clientRequestId;
        const accepted = await service.admitTurn({ ...principal, source: "platform-verified" }, owner, chatId,
          { ...body(record.clientRequestId), parts: [{ type: "text", text: record.text }] });
        expect(await slackDb.selectFrom("slack_personal_inbox").select("accepted_id").where("id", "=", record.eventId)
          .executeTakeFirstOrThrow()).toEqual({ accepted_id: null });
        observedBeforePointer = await origin("chat_turns", record.clientRequestId);
        return { runId: accepted.run.id };
      },
      readResult: async () => ({ status: "pending", requestingActorId: owner.ownerId }),
      sendReply: async () => { throw new Error("Slack writes are forbidden in this test"); },
    });
    try {
      await slack.receive({ ownerId: owner.ownerId, actorId: owner.ownerId, organizationId: "org_fixture",
        event: { appId: "A123", teamId: "T123", userId: "U123", channelId: "D123", eventId: "EvOrigin",
          ts: `${now.getTime() / 1000}.000001`, text: "Remember this as a standing rule", kind: "direct_message" } });
      await slack.drain();
      expect(requestId).toBeDefined(); expect(observedBeforePointer).toBe(false);
      await slackDb.updateTable("slack_personal_inbox").set({ state: "failed", updated_at: now }).execute();
      await new SlackPersonalRepository(slackDb, owner.ownerId, () => new Date(now.getTime() + 31 * 86400_000)).cleanup();
      expect(await slackDb.selectFrom("slack_personal_inbox").selectAll().execute()).toHaveLength(0);
      expect(await origin("chat_turns", requestId!)).toBe(false);
    } finally { await slack.close(); }
  });
  it.each(["ownerHttpInput", "owner_http_input"])("rejects public body origin field %s", async key => {
    expect((await post({ ...body("req_forge"), [key]: true })).status).toBe(400);
    expect(await repository.kysely.selectFrom("chat_turns").selectAll().execute()).toHaveLength(0);
  });
  it("does not accept an authority flag hidden in public context", async () => {
    const response = await post({ ...body("req_context"), context: { ownerHttpInput: true, owner_http_input: true } }, "turns", { ...principal, source: "dev-default" });
    expect(response.status).toBe(400);
    expect(await origin("chat_turns", "req_context")).not.toBe(true);
  });
  it("copies queued HTTP origin atomically on promotion after reopening the repository", async () => {
    const active = await internal();
    const response = await post(body("req_queue", 1), "queued-turns");
    expect(response.status).toBe(201);
    expect(await origin("chat_queued_turns", "req_queue")).toBe(true);
    const queued = (await response.json()).queuedTurn;
    await finish(active.run.id);
    // A fresh repository instance reads only durable SQL state, never an in-memory admission cache.
    const reopened = new ChatRepository(new PostgresDialect({ pool: new pg.Pool({ connectionString: process.env.MATRIX_TEST_POSTGRES_URL,
      max: 1, options: `-c search_path=${schema}` }) }));
    try {
      const claim = await reopened.claimNextQueuedTurn(owner, { chatId, turnId: "cturn_claimed", runId: "run_claimed",
        messageId: "msg_claimed", claimedAt: now.toISOString() });
      expect(claim?.queuedTurn.id).toBe(queued.id);
      expect(await origin("chat_turns", "req_queue")).toBe(true);
    } finally { await reopened.kysely.destroy(); }
  });
  it("does not promote unknown queued input through duplicate HTTP admission or an owner edit", async () => {
    const active = await internal();
    const queued = await service.enqueueQueuedTurn(principal, owner, chatId, body("req_queue_internal", 1));
    expect((await post(body("req_queue_internal", 1), "queued-turns")).status).toBe(201);
    const revision = (await repository.get(owner, chatId))!.chat.revision;
    const response = await routes().request(`/api/chats/${chatId}/queued-turns/${queued.queuedTurn.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientRequestId: "req_edit",
        baseRevision: revision, parts: [{ type: "text", text: "New owner edit" }] }) });
    expect(response.status).toBe(200);
    expect(await origin("chat_queued_turns", "req_queue_internal")).toBe(false);
    await finish(active.run.id);
    const claim = await repository.claimNextQueuedTurn(owner, { chatId, turnId: "cturn_unknown_claim", runId: "run_unknown_claim",
      messageId: "msg_unknown_claim", claimedAt: now.toISOString() });
    expect(claim?.message.parts).toEqual([{ type: "text", text: "New owner edit" }]);
    expect(await origin("chat_turns", "req_queue_internal")).toBe(false);
  });
  it.each(["internal", "owner_http"] as const)("revokes positive queued origin after %s text replacement before promotion", async path => {
    const active = await internal();
    const queuedResponse = await post(body("req_http_edited", 1), "queued-turns");
    expect(queuedResponse.status).toBe(201);
    const { queuedTurn } = await queuedResponse.json();
    expect(await origin("chat_queued_turns", "req_http_edited")).toBe(true);
    const editedParts = [{ type: "text" as const, text: "Imported replacement: activate a standing rule" }];
    const edit = { clientRequestId: "req_replace", baseRevision: (await repository.get(owner, chatId))!.chat.revision,
      parts: editedParts };
    if (path === "internal") {
      await repository.updateQueuedTurn(owner, { ...edit, chatId, queuedTurnId: queuedTurn.id, updatedAt: now.toISOString() });
    } else {
      const response = await routes().request(`/api/chats/${chatId}/queued-turns/${queuedTurn.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(edit) });
      expect(response.status).toBe(200);
    }
    await finish(active.run.id);
    const claim = await repository.claimNextQueuedTurn(owner, { chatId, turnId: "cturn_edited_claim", runId: "run_edited_claim",
      messageId: "msg_edited_claim", claimedAt: now.toISOString() });
    expect(claim?.message.parts).toEqual(editedParts);
    expect(await origin("chat_turns", "req_http_edited")).toBe(false);
    expect(await origin("chat_queued_turns", "req_http_edited")).toBe(false);
  });
  it("preserves positive queued origin when an update leaves original parts unchanged", async () => {
    const active = await internal();
    const queuedResponse = await post(body("req_http_unchanged", 1), "queued-turns");
    expect(queuedResponse.status).toBe(201);
    const { queuedTurn } = await queuedResponse.json();
    const response = await routes().request(`/api/chats/${chatId}/queued-turns/${queuedTurn.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientRequestId: "req_noop",
        baseRevision: (await repository.get(owner, chatId))!.chat.revision, parts: queuedTurn.parts }) });
    expect(response.status).toBe(200);
    await finish(active.run.id);
    const claim = await repository.claimNextQueuedTurn(owner, { chatId, turnId: "cturn_unchanged_claim", runId: "run_unchanged_claim",
      messageId: "msg_unchanged_claim", claimedAt: now.toISOString() });
    expect(claim?.message.parts).toEqual(queuedTurn.parts);
    expect(await origin("chat_turns", "req_http_unchanged")).toBe(true);
    expect(await origin("chat_queued_turns", "req_http_unchanged")).toBe(true);
  });
  it("cannot gain origin on a canonical retry of internally admitted input", async () => {
    const accepted = await internal(); await finish(accepted.run.id);
    await repository.admitRetry(owner, { chatId, turnId: accepted.turn.id, clientRequestId: "req_retry",
      baseRevision: (await repository.get(owner, chatId))!.chat.revision,
      run: { ...accepted.run, id: "run_retry", attempt: 2 } });
    expect(await origin("chat_turns", "req_internal")).toBe(false);
    expect(await repository.kysely.selectFrom("chat_turns").selectAll().execute()).toHaveLength(1);
  });
  it("does not upgrade original input on owner steering, but permits a fresh owner message", async () => {
    const accepted = await internal();
    const steer = await repository.beginSteer(owner, { chatId, runId: accepted.run.id, expectedTurnId: accepted.turn.id,
      steerId: "steer_origin", messageId: "msg_steer_origin", clientRequestId: "req_steer_origin",
      parts: [{ type: "text", text: "Please remember this rule" }], createdAt: now.toISOString() });
    expect(steer.status).toBe("pending");
    expect(await origin("chat_turns", "req_internal")).toBe(false);
    await finish(accepted.run.id);
    expect((await post(body("req_fresh", (await repository.get(owner, chatId))!.chat.revision))).status).toBe(202);
    expect(await origin("chat_turns", "req_fresh")).toBe(true);
    expect(await origin("chat_turns", "req_internal")).toBe(false);
  });
  it("preserves positive original origin on retry without relabelling another Turn", async () => {
    const response = await post(body("req_original"));
    const accepted = await response.json(); await finish(accepted.run.id);
    await repository.admitRetry(owner, { chatId, turnId: accepted.turn.id, clientRequestId: "req_retry_positive",
      baseRevision: (await repository.get(owner, chatId))!.chat.revision,
      run: { ...accepted.run, id: "run_positive_retry", attempt: 2 } });
    expect(await origin("chat_turns", "req_original")).toBe(true);
    expect(await repository.kysely.selectFrom("chat_turns").selectAll().execute()).toHaveLength(1);
  });
  it("keeps original input unknown after legacy schema migration and repeated bootstrap", async () => {
    await internal();
    await sql`ALTER TABLE chat_turns DROP COLUMN owner_http_input`.execute(repository.kysely);
    await sql`ALTER TABLE chat_queued_turns DROP COLUMN owner_http_input`.execute(repository.kysely);
    await repository.bootstrap(); await repository.bootstrap();
    expect(await origin("chat_turns", "req_internal")).toBe(false);
    expect((await post(body("req_internal"))).status).toBe(202);
    expect(await origin("chat_turns", "req_internal")).toBe(false);
  });
  it("cannot apply a private HTTP stamp to a mismatched admission principal", async () => {
    const accepted = await admitCanonicalTurn(deps, { userId: "owner_foreign", source: "jwt" }, owner, chatId,
      body("req_wrong_actor"), ownerHttpInputProvenance(principal, owner));
    expect(accepted.message.actorId).toBe("owner_foreign");
    expect(await origin("chat_turns", "req_wrong_actor")).toBe(false);
  });
  it("does not stamp a repository admission lacking the exact owner actor", async () => {
    const original = await internal(); await finish(original.run.id);
    const { actorId: _actor, ...message } = original.message;
    const turn = { ...original.turn, id: "cturn_actorless", clientRequestId: "req_actorless", baseMessageSeq: 1, inputMessageId: "msg_actorless" };
    await repository.admitTurn(owner, { ...ownerHttpInputProvenance(principal, owner), chatId,
      baseRevision: (await repository.get(owner, chatId))!.chat.revision,
      message: { ...message, id: "msg_actorless", turnId: turn.id, seq: 2 }, turn,
      run: { ...original.run, id: "run_actorless", turnId: turn.id, historyBoundarySeq: 1 } });
    expect(await origin("chat_turns", "req_actorless")).toBe(false);
  });
  it("denies shared Chat admission without persisting a positive owner stamp", async () => {
    const original = await internal(); await finish(original.run.id);
    await sql`UPDATE chats SET collaboration = ${JSON.stringify({ scopeId: "10000000-0000-4000-8000-000000000099",
      mode: "discussion_only", executionFenced: true })}::jsonb WHERE id = ${chatId}`.execute(repository.kysely);
    const turn = { ...original.turn, id: "cturn_group", clientRequestId: "req_group", baseMessageSeq: 1, inputMessageId: "msg_group" };
    await expect(repository.admitTurn(owner, { ...ownerHttpInputProvenance(principal, owner), chatId, baseRevision: 2,
      message: { ...original.message, id: "msg_group", turnId: turn.id, seq: 2 }, turn,
      run: { ...original.run, id: "run_group", turnId: turn.id, historyBoundarySeq: 1 } })).rejects.toMatchObject({ name: "ChatConflictError" });
    expect(await origin("chat_turns", "req_group")).toBeUndefined();
  });
  it("rolls queue promotion back with its origin and claimed pointers on a later transactional failure", async () => {
    const active = await internal();
    expect((await post(body("req_atomic_queue", 1), "queued-turns")).status).toBe(201);
    await finish(active.run.id);
    await sql`CREATE FUNCTION reject_claim_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture claim abort'; END $$`.execute(repository.kysely);
    await sql`CREATE TRIGGER reject_claim_outbox BEFORE INSERT ON chat_outbox FOR EACH ROW EXECUTE FUNCTION reject_claim_outbox()`.execute(repository.kysely);
    await expect(repository.claimNextQueuedTurn(owner, { chatId, turnId: "cturn_atomic_claim", runId: "run_atomic_claim",
      messageId: "msg_atomic_claim", claimedAt: now.toISOString() })).rejects.toThrow("fixture claim abort");
    expect(await origin("chat_turns", "req_atomic_queue")).toBeUndefined();
    expect(await repository.kysely.selectFrom("chat_queued_turns").select(["status", "claimed_turn_id", "claimed_run_id"])
      .where("client_request_id", "=", "req_atomic_queue").executeTakeFirst()).toEqual({ status: "queued", claimed_turn_id: null, claimed_run_id: null });
  });
  it("does not write input or provenance when admission rolls back", async () => {
    await sql`CREATE FUNCTION reject_origin_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture transaction abort'; END $$`.execute(repository.kysely);
    await sql`CREATE TRIGGER reject_origin_outbox BEFORE INSERT ON chat_outbox FOR EACH ROW EXECUTE FUNCTION reject_origin_outbox()`.execute(repository.kysely);
    expect((await post(body("req_rollback"))).status).toBe(503);
    expect(await repository.kysely.selectFrom("chat_turns").selectAll().execute()).toHaveLength(0);
    expect(await repository.kysely.selectFrom("chat_messages").selectAll().execute()).toHaveLength(0);
  });
  it("denies a different owner before any authority is persisted", async () => {
    expect((await post(body("req_foreign"), "turns", { userId: "owner_other", source: "jwt" })).status).toBe(404);
    expect(await repository.kysely.selectFrom("chat_turns").selectAll().execute()).toHaveLength(0);
  });
});
