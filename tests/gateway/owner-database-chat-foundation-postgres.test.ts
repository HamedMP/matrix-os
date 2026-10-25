import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatCredentialRepository } from "../../packages/gateway/src/chat/credential-repository.js";
import {
  initializeOwnerDatabaseServices,
  type InitializeOwnerDatabaseOptions,
  type OwnerDatabaseServices,
} from "../../packages/gateway/src/startup/owner-database.js";
import { teardownOwnerDatabaseServices } from "../../packages/gateway/src/startup/owner-database-fallback.js";

const realDescribe = process.env.MATRIX_TEST_POSTGRES_URL ? describe : describe.skip;
const owner = { type: "personal" as const, ownerId: "owner_disabled_collaboration_test" };
const chatId = "chat_disabled_collaboration_test";

realDescribe("owner Chat foundation with collaboration disabled (PostgreSQL)", () => {
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
  });

  afterEach(async () => {
    if (services) await teardownOwnerDatabaseServices(services);
    services = null;
    if (admin) {
      if (databaseName) await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
      await admin.end();
    }
    if (homePath) await rm(homePath, { recursive: true, force: true });
  });

  async function boot() {
    const unused = {} as never;
    const options: InitializeOwnerDatabaseOptions = {
      databaseUrl, homePath,
      collaborationConfig: null,
      initialFailureReason: null,
      providerSnapshotReader: unused,
      codingAgentProjectManager: unused,
      codingAgentWorktreeManager: unused,
      terminalWorkspaceRuntime: unused,
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
    expect(result.failClosedReason).toBeNull();
    if (!services?.chatRepository || !services.chatCollaborationGuard) {
      throw new Error("Owner Chat startup failed");
    }
    expect(services.collaboration).toBeNull();
    return { repository: services.chatRepository, guard: services.chatCollaborationGuard };
  }

  it("supports private credential checks on a fresh owner database without creating sharing authority", async () => {
    const { repository, guard } = await boot();
    await repository.create(owner, { id: chatId, clientRequestId: "req_private_first", title: "Private first Chat" });
    await expect(guard.assertPersonalExecutionAllowed(owner, chatId)).resolves.toBeUndefined();
    const credentials = new ChatCredentialRepository(repository.kysely, Buffer.alloc(32, 1), [owner.ownerId]);
    // This real private-owner query failed with PostgreSQL 42P01 before the fix.
    await expect(credentials.list(owner, chatId, ["msg_private_first"])).resolves.toEqual([]);
    await expect(credentials.list({ ...owner, ownerId: "unrelated_owner" }, chatId, ["msg_private_first"]))
      .rejects.toThrow("Credential unavailable");
    await expect(guard.assertPersonalExecutionAllowed({ ...owner, ownerId: "unrelated_owner" }, chatId))
      .rejects.toMatchObject({ code: "not_found" });
    for (const table of ["collaboration_scopes", "collaboration_members", "collaboration_grants", "collaboration_grant_activations"]) {
      expect(await services!.kyselyInstance!.selectFrom(table).selectAll().execute()).toEqual([]);
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
