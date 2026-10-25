import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppDb } from "../../packages/gateway/src/app-db.js";
import * as appDatabase from "../../packages/gateway/src/app-db.js";
import { ChatCredentialRepository } from "../../packages/gateway/src/chat/credential-repository.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { createDiscussionOnlyChatExecutionGuard } from "../../packages/gateway/src/collaboration/chat-scope.js";
import * as collaborationDatabase from "../../packages/gateway/src/collaboration/database.js";
import { createGatewayCollaboration, prepareGatewayCollaborationDatabase } from "../../packages/gateway/src/collaboration/wiring.js";
import {
  initializeOwnerDatabaseServices,
  type InitializeOwnerDatabaseOptions,
  type OwnerDatabaseServices,
} from "../../packages/gateway/src/startup/owner-database.js";
import { teardownOwnerDatabaseServices } from "../../packages/gateway/src/startup/owner-database-fallback.js";
import * as ownerCollaboration from "../../packages/gateway/src/startup/collaboration.js";

const realDescribe = process.env.MATRIX_TEST_POSTGRES_URL ? describe : describe.skip;
const owner = { type: "personal" as const, ownerId: "owner_disabled_collaboration_test" };
const chatId = "chat_disabled_collaboration_test";
const configuredCollaboration = {
  runtimeId: "runtime_owner_bootstrap_test",
  platformBaseUrl: "https://platform.invalid",
  serviceToken: "synthetic-collaboration-test-token-only",
  clientOrigins: [],
  ownerId: owner.ownerId,
};

realDescribe("owner Chat foundation bootstrap ownership (PostgreSQL)", () => {
  let admin: Pool;
  let databaseName: string;
  let databaseUrl: string;
  let homePath: string;
  let services: OwnerDatabaseServices | null = null;

  beforeEach(async () => {
    const url = new URL(process.env.MATRIX_TEST_POSTGRES_URL!);
    if (!url.pathname.toLowerCase().includes("test")) {
      throw new Error("MATRIX_TEST_POSTGRES_URL must name a dedicated test database");
    }
    admin = new Pool({ connectionString: url.href, max: 1 });
    databaseName = `test_owner_chat_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    url.pathname = `/${databaseName}`;
    databaseUrl = url.href;
    homePath = await mkdtemp(join(tmpdir(), "owner-chat-foundation-test-"));
    vi.spyOn(collaborationDatabase, "bootstrapCollaborationDatabase");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected external request in owner startup test"); }));
  });

  afterEach(async () => {
    if (services) await teardownOwnerDatabaseServices(services);
    services = null;
    if (admin) {
      if (databaseName) await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
      await admin.end();
    }
    if (homePath) await rm(homePath, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function initialize(
    collaborationConfig: InitializeOwnerDatabaseOptions["collaborationConfig"] = null,
  ) {
    const unused = {} as never;
    const options: InitializeOwnerDatabaseOptions = {
      databaseUrl, homePath,
      collaborationConfig,
      initialFailureReason: null,
      providerSnapshotReader: unused,
      codingAgentProjectManager: unused,
      codingAgentWorktreeManager: unused,
      terminalWorkspaceRuntime: { listWorkspaces: async () => [] } as never,
      terminalRuntimeOwnerIds: [owner.ownerId],
      projectOwnerToolOutput: unused,
      capture: () => undefined,
      runningVersion: "test",
      getCanonicalChatOrchestrator: () => null,
      rememberProvisionedAppSlug: () => undefined,
      logBestEffortFailure: (context, error) => { throw new Error(context, { cause: error }); },
    };
    const result = await initializeOwnerDatabaseServices(options);
    services = result.services;
    return result;
  }

  async function boot(
    collaborationConfig: InitializeOwnerDatabaseOptions["collaborationConfig"] = null,
    expectedFailure: InitializeOwnerDatabaseOptions["initialFailureReason"] = null,
  ) {
    const result = await initialize(collaborationConfig);
    expect(result.failClosedReason).toBe(expectedFailure);
    if (!services?.chatRepository || !services.chatCollaborationGuard) {
      throw new Error("Owner Chat startup failed");
    }
    if (!collaborationConfig || expectedFailure) expect(services.collaboration).toBeNull();
    return { repository: services.chatRepository, guard: services.chatCollaborationGuard };
  }

  it("supports private credential checks on a fresh owner database without creating sharing authority", async () => {
    const { repository, guard } = await boot();
    await repository.create(owner, { id: chatId, clientRequestId: "req_private_first", title: "Private first Chat" });
    await expect(guard.assertPersonalExecutionAllowed(owner, chatId)).resolves.toBeUndefined();
    const credentials = new ChatCredentialRepository(repository.kysely, Buffer.alloc(32, 1), [owner.ownerId]);
    // This real private-owner query failed with PostgreSQL 42P01 before the fix.
    await expect(credentials.list(owner, chatId, ["msg_private_first"])).resolves.toEqual([]);
    expect(collaborationDatabase.bootstrapCollaborationDatabase).toHaveBeenCalledTimes(1);
    await expect(credentials.list({ ...owner, ownerId: "unrelated_owner" }, chatId, ["msg_private_first"]))
      .rejects.toThrow("Credential unavailable");
    await expect(guard.assertPersonalExecutionAllowed({ ...owner, ownerId: "unrelated_owner" }, chatId))
      .rejects.toMatchObject({ code: "not_found" });
    for (const table of ["collaboration_scopes", "collaboration_members", "collaboration_grants", "collaboration_grant_activations"]) {
      expect(await services!.kyselyInstance!.selectFrom(table).selectAll().execute()).toEqual([]);
    }
  });

  it.each([
    { configured: false, table: "collaboration_schema_migrations" },
    { configured: true, table: "collaboration_schema_migrations" },
    { configured: false, table: "collaboration_cutover_journal" },
    { configured: true, table: "collaboration_cutover_journal" },
  ])("returns no owner services when DDL fails at $table (configured=$configured)", async ({ configured, table }) => {
    const setup = new Pool({ connectionString: databaseUrl, max: 1 });
    try {
      // A real PostgreSQL event trigger rejects the selected base/versioned DDL.
      // Names are fixed test cases, and the entire dedicated database is dropped.
      if (!["collaboration_schema_migrations", "collaboration_cutover_journal"].includes(table)) throw new Error("Invalid fixture table");
      await setup.query(`CREATE FUNCTION reject_test_collaboration_ddl() RETURNS event_trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF EXISTS (SELECT FROM pg_event_trigger_ddl_commands() WHERE object_identity = 'public.${table}') THEN
            RAISE EXCEPTION 'Synthetic collaboration migration failure';
          END IF;
        END $$;
        CREATE EVENT TRIGGER reject_test_collaboration_ddl ON ddl_command_end
        WHEN TAG IN ('CREATE TABLE') EXECUTE FUNCTION reject_test_collaboration_ddl()`);
    } finally {
      await setup.end();
    }
    const release = vi.spyOn(ChatRepository.prototype, "release");
    const poolEnd = vi.spyOn(Pool.prototype, "end");
    const construct = vi.spyOn(ownerCollaboration, "constructOwnerCollaboration");
    const result = await initialize(configured ? configuredCollaboration : null);
    expect(result.services).toBeNull();
    expect(result.failClosedReason).toBe(configured ? "owner_database_missing" : null);
    expect(collaborationDatabase.bootstrapCollaborationDatabase).toHaveBeenCalledTimes(1);
    expect(construct).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(poolEnd).toHaveBeenCalledTimes(1);
    const probe = new Pool({ connectionString: databaseUrl, max: 1 });
    try {
      const relation = await probe.query("SELECT to_regclass($1) AS relation", [`public.${table}`]);
      expect(relation.rows[0].relation).toBeNull();
      if (table === "collaboration_cutover_journal") {
        const migrated = await probe.query("SELECT max(version) AS version FROM collaboration_schema_migrations");
        expect(migrated.rows[0].version).toBe(13);
      }
    } finally {
      await probe.end();
    }
  });

  it("lets configured collaboration own the single schema bootstrap and keeps private checks ready", async () => {
    const { repository, guard } = await boot(configuredCollaboration);
    expect(services!.collaboration).not.toBeNull();
    expect(collaborationDatabase.bootstrapCollaborationDatabase).toHaveBeenCalledTimes(1);
    await repository.create(owner, { id: chatId, clientRequestId: "req_enabled_bootstrap", title: "Configured startup" });
    await expect(guard.assertPersonalExecutionAllowed(owner, chatId)).resolves.toBeUndefined();
    const credentials = new ChatCredentialRepository(repository.kysely, Buffer.alloc(32, 1), [owner.ownerId]);
    await expect(credentials.list(owner, chatId, ["msg_enabled_bootstrap"])).resolves.toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retains ready private metadata when configured runtime construction fails after its bootstrap", async () => {
    // A missing terminal owner fails onPartialRuntime after the runtime has migrated storage.
    const { ownerId: _ownerId, ...configWithoutTerminalOwner } = configuredCollaboration;
    const { repository, guard } = await boot(configWithoutTerminalOwner, "construction_failed");
    expect(collaborationDatabase.bootstrapCollaborationDatabase).toHaveBeenCalledTimes(1);
    await repository.create(owner, { id: chatId, clientRequestId: "req_enabled_fallback", title: "Private fallback" });
    await expect(guard.assertPersonalExecutionAllowed(owner, chatId)).resolves.toBeUndefined();
    const credentials = new ChatCredentialRepository(repository.kysely, Buffer.alloc(32, 1), [owner.ownerId]);
    await expect(credentials.list(owner, chatId, ["msg_enabled_fallback"])).resolves.toEqual([]);
  });

  it("keeps private storage ready when runtime construction fails after schema readiness", async () => {
    const originalCreateAppDb = appDatabase.createAppDb;
    vi.spyOn(appDatabase, "createAppDb").mockImplementationOnce((...args) => {
      const created = originalCreateAppDb(...args);
      return { ...created, kysely: created.kysely.withPlugin({
        transformQuery(input) {
          if (input.node.kind === "DeleteQueryNode" && JSON.stringify(input.node).includes("collaboration_exports")) {
            throw new Error("Synthetic runtime cleanup failure after schema readiness");
          }
          return input.node;
        },
        async transformResult(input) { return input.result; },
      }) };
    });
    const { repository, guard } = await boot(configuredCollaboration, "construction_failed");
    expect(collaborationDatabase.bootstrapCollaborationDatabase).toHaveBeenCalledTimes(1);
    await repository.create(owner, { id: chatId, clientRequestId: "req_runtime_build_failure", title: "Private storage remains ready" });
    await expect(guard.assertPersonalExecutionAllowed(owner, chatId)).resolves.toBeUndefined();
    const credentials = new ChatCredentialRepository(repository.kysely, Buffer.alloc(32, 1), [owner.ownerId]);
    await expect(credentials.list(owner, chatId, ["msg_runtime_build_failure"])).resolves.toEqual([]);
  });

  it("binds the prepared factory to its migrated pool even if call options supply another database", async () => {
    const { db, kysely } = createAppDb(databaseUrl);
    let runtime: Awaited<ReturnType<typeof createGatewayCollaboration>> | undefined;
    try {
      const repository = new ChatRepository(kysely);
      await repository.bootstrap();
      const create = await prepareGatewayCollaborationDatabase(kysely);
      runtime = await create({ db: {} as never, chatRepository: repository,
        config: configuredCollaboration, startTimers: false });
      expect(collaborationDatabase.bootstrapCollaborationDatabase).toHaveBeenCalledTimes(1);
      await repository.create(owner, { id: chatId, clientRequestId: "req_bound_factory", title: "Prepared pool" });
      const credentials = new ChatCredentialRepository(kysely, Buffer.alloc(32, 1), [owner.ownerId]);
      await expect(credentials.list(owner, chatId, ["msg_bound_factory"])).resolves.toEqual([]);
    } finally {
      await runtime?.shutdown();
      await db.destroy();
    }
  });

  it("still bootstraps storage for standalone collaboration callers", async () => {
    const { db, kysely } = createAppDb(databaseUrl);
    let runtime: Awaited<ReturnType<typeof createGatewayCollaboration>> | undefined;
    try {
      const repository = new ChatRepository(kysely);
      await repository.bootstrap();
      runtime = await createGatewayCollaboration({ db: kysely, chatRepository: repository,
        config: configuredCollaboration, startTimers: false });
      expect(collaborationDatabase.bootstrapCollaborationDatabase).toHaveBeenCalledTimes(1);
      await repository.create(owner, { id: chatId, clientRequestId: "req_standalone", title: "Standalone storage" });
      await expect(createDiscussionOnlyChatExecutionGuard(kysely).assertPersonalExecutionAllowed(owner, chatId))
        .resolves.toBeUndefined();
      const credentials = new ChatCredentialRepository(kysely, Buffer.alloc(32, 1), [owner.ownerId]);
      await expect(credentials.list(owner, chatId, ["msg_standalone"])).resolves.toEqual([]);
    } finally {
      await runtime?.shutdown();
      await db.destroy();
    }
  });

  it("rejects a standalone runtime before construction when its schema preparation fails", async () => {
    const { db, kysely } = createAppDb(databaseUrl);
    try {
      const repository = new ChatRepository(kysely);
      await repository.bootstrap();
      vi.mocked(collaborationDatabase.bootstrapCollaborationDatabase)
        .mockRejectedValueOnce(new Error("Synthetic standalone schema failure"));
      await expect(createGatewayCollaboration({ db: kysely, chatRepository: repository,
        config: configuredCollaboration, startTimers: false })).rejects.toThrow("Synthetic standalone schema failure");
      expect(collaborationDatabase.bootstrapCollaborationDatabase).toHaveBeenCalledTimes(1);
    } finally {
      await db.destroy();
    }
  });

  it("preserves private history across restart and keeps shared and foreign-owner execution fenced", async () => {
    let { repository } = await boot();
    await repository.create(owner, { id: chatId, clientRequestId: "req_private_restart", title: "Keep my history" });
    await teardownOwnerDatabaseServices(services!);
    services = null;
    const restarted = await boot();
    repository = restarted.repository;
    expect((await repository.get(owner, chatId))?.chat.title).toBe("Keep my history");
    const scopeId = "10000000-0000-4000-8000-000000000001";
    await services!.kyselyInstance!.insertInto("collaboration_scopes").values({
      id: scopeId, owner_type: owner.type, owner_id: owner.ownerId,
      kind: "chat", resource_id: chatId, membership_mode: "direct", lifecycle: "shared",
      authority_runtime_id: "synthetic_test_runtime",
    }).execute();
    // Inherited publication can leave chats.collaboration NULL: credential reads must still deny it.
    const credentials = new ChatCredentialRepository(repository.kysely, Buffer.alloc(32, 1), [owner.ownerId]);
    await expect(credentials.list(owner, chatId, ["msg_private_restart"])).rejects.toThrow("Credential unavailable");
    await repository.kysely.updateTable("chats").set({ collaboration: JSON.stringify({ scopeId }) }).where("id", "=", chatId).execute();
    await expect(restarted.guard.assertPersonalExecutionAllowed(owner, chatId))
      .rejects.toMatchObject({ code: "shared_execution_disabled" });
  });
});
