import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { ActionRepository } from "../../packages/gateway/src/chat/action-repository.js";
import { normalizedArgumentDigest } from "../../packages/gateway/src/chat/argument-digest.js";
import type { ChatDatabase } from "../../packages/gateway/src/chat/database.js";
// This suite NEVER reads DATABASE_URL. The URL must explicitly identify a disposable test DB.
const url = process.env.MATRIX_TEST_POSTGRES_URL;
const schema = `chat_actions_test_${randomUUID().replaceAll("-", "")}`;
const owner = { type: "personal" as const, ownerId: "owner_pg_actions" };
const policy = { revision: "actions_pg_v1", actionMode: "canonical_actions" as const, workspaceScope: "apps", tools: ["matrix_apply_app_files"], delegation: false };
let admin: Kysely<ChatDatabase>; let chat: ChatRepository; let actions: ActionRepository;
describe.skipIf(!url)("disposable Postgres canonical action claims (explicit authorization gate)", () => {
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (!/test|disposable/i.test(parsed.pathname)) throw new Error("MATRIX_TEST_POSTGRES_URL must name an isolated test database");
    admin = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5_000 }) }) });
    await sql`create schema ${sql.id(schema)}`.execute(admin);
    chat = new ChatRepository(new PostgresDialect({ pool: new Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 5_000, options: `-c search_path=${schema} -c statement_timeout=10000` }) }));
    await chat.bootstrap(); actions = new ActionRepository(chat.kysely);
    await chat.create(owner, { id: "chat_pg_actions", clientRequestId: "req_create_pg_actions", title: "Disposable action gate" });
    await chat.kysely.insertInto("chat_messages").values({ id: "msg_pg_actions", chat_id: "chat_pg_actions", seq: 1, role: "user", purpose: "ai_request", state: "committed", turn_id: null, run_id: null, actor_id: owner.ownerId, parts: JSON.stringify([{ type: "text", text: "apply" }]), byte_count: 5, search_text: "apply", created_at: new Date() }).execute();
    await chat.kysely.insertInto("chat_turns").values({ id: "cturn_pg_actions", chat_id: "chat_pg_actions", client_request_id: "req_turn_pg_actions", base_message_seq: 0, input_message_id: "msg_pg_actions", status: "running", created_at: new Date(), updated_at: new Date() }).execute();
    await chat.kysely.insertInto("chat_runs").values({ id: "run_pg_actions", chat_id: "chat_pg_actions", turn_id: "cturn_pg_actions", client_request_id: "req_run_pg_actions", attempt: 1, driver_kind: "codex", instance_id: "codex_default", selection: JSON.stringify({}), interaction_mode: "default", permission_mode: "supervised", execution_root: null, execution_root_fingerprint: null, status: "running", outcome: null, history_boundary_seq: 0, capability_snapshot: JSON.stringify({}), run_policy: JSON.stringify({ memoryMode: "ordinary", source: "typed", nativeCheckpointPolicy: "reusable", executionPolicy: policy }), created_at: new Date(), updated_at: new Date() }).execute();
  });
  afterAll(async () => { if (chat) await chat.kysely.destroy(); if (admin) { await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(admin); await admin.destroy(); } });
  it("one concurrent authorization consumer wins; reconstructed running identity cannot be claimed", async () => {
    const now = new Date().toISOString();
    const op = await actions.propose({ id: "action_pg_claim", owner, chatId: "chat_pg_actions", runId: "run_pg_actions", toolId: policy.tools[0]!, workspaceScope: "apps", schemaRevision: "files_v1", executionPolicy: policy, policyRevision: policy.revision, arguments: { app: "notes" }, argumentDigest: normalizedArgumentDigest({ app: "notes" }), state: "waiting_for_approval", revision: 0, cancellationRequested: false, createdAt: now, updatedAt: now });
    const ready = await actions.decide({ owner, chatId: op.chatId, runId: op.runId, actionId: op.id, argumentDigest: op.argumentDigest, decision: "approve", clientRequestId: "req_pg_approve" });
    const claims = await Promise.all(Array.from({ length: 4 }, () => actions.claim(ready)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    const recovered = new ActionRepository(chat.kysely);
    const persisted = await recovered.get({ owner, chatId: op.chatId, runId: op.runId, actionId: op.id });
    expect(persisted.state).toBe("running"); expect(await recovered.claim(persisted)).toBeNull();
  });
  // Process-kill-after-effect evidence remains a separate disposable runtime gate;
  // repository reconstruction alone is intentionally not labelled process-crash proof.
});
