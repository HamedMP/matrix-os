/**
 * S20 / T098: the organization is the only collaboration gate on the home
 * computer. No release flag or rollout cohort is consulted anywhere, wiring
 * with incomplete configuration fails closed with a logged generic denial
 * instead of skipping construction, and (later layers) every collaboration
 * request is denied while no membership projection is registered.
 */
import { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeGatewayCollaborationConfiguration,
  loadGatewayCollaborationConfig,
} from "../../packages/gateway/src/collaboration/config.js";
import { registerFailClosedCollaborationRoutes } from "../../packages/gateway/src/collaboration/fail-closed.js";
import { constructGatewayCollaborationOrFailClosed } from "../../packages/gateway/src/collaboration/construct.js";
import { COLLABORATION_HTTP_BODY_LIMIT } from "@matrix-os/contracts";
import { CollaborationAuthority } from "../../packages/gateway/src/collaboration/authority.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import {
  createOrganizationPrecondition,
  type OrganizationMembershipSource,
} from "../../packages/gateway/src/collaboration/organization-precondition.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import {
  collaborationActors,
  collaborationIds,
  createCollaborationTestDatabase,
  type CollaborationTestDatabase,
} from "./collaboration-test-support.js";

const completeEnvironment = {
  MATRIX_RUNTIME_ID: "vps:11111111-1111-4111-8111-111111111111",
  MATRIX_COLLABORATION_ACTIVE_KEY_ID: "key-1",
  MATRIX_COLLABORATION_PROOF_KEYS: JSON.stringify({ "key-1": "a".repeat(32) }),
  MATRIX_COLLABORATION_PREFLIGHT_SECRET: "b".repeat(32),
  PLATFORM_INTERNAL_URL: "https://platform.internal",
  UPGRADE_TOKEN: "c".repeat(32),
  DATABASE_URL: "postgres://owner@localhost/owner",
};

async function listSourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listSourceFiles(path));
    else if (/\.(ts|tsx|yaml|yml|sh)$/.test(entry.name)) files.push(path);
  }
  return files;
}

describe("S20 organization precondition: no release flag", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("consults no MATRIX_COLLABORATION_ENABLED flag anywhere in runtime, distro or workflow sources", async () => {
    const roots = ["packages", "distro", ".github/workflows"];
    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of await listSourceFiles(root)) {
        if ((await readFile(file, "utf8")).includes("MATRIX_COLLABORATION_ENABLED")) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("treats a legacy host.env flag value as inert", () => {
    expect(loadGatewayCollaborationConfig({ ...completeEnvironment, MATRIX_COLLABORATION_ENABLED: "false" }))
      .toMatchObject({ runtimeId: completeEnvironment.MATRIX_RUNTIME_ID });
    expect(describeGatewayCollaborationConfiguration({ MATRIX_COLLABORATION_ENABLED: "true" }))
      .toEqual({ configured: false, reason: "runtime_identity_missing" });
  });

  it("reports the exact missing configuration instead of a flag", () => {
    expect(describeGatewayCollaborationConfiguration(completeEnvironment)).toEqual({ configured: true });
    const { MATRIX_COLLABORATION_PROOF_KEYS: _keys, ...withoutSigning } = completeEnvironment;
    expect(describeGatewayCollaborationConfiguration(withoutSigning))
      .toEqual({ configured: false, reason: "signing_configuration_missing" });
    const { UPGRADE_TOKEN: _token, ...withoutPlatform } = completeEnvironment;
    expect(describeGatewayCollaborationConfiguration(withoutPlatform))
      .toEqual({ configured: false, reason: "platform_configuration_missing" });
    const { DATABASE_URL: _db, ...withoutDatabase } = completeEnvironment;
    expect(describeGatewayCollaborationConfiguration(withoutDatabase))
      .toEqual({ configured: false, reason: "owner_database_missing" });
    expect(loadGatewayCollaborationConfig(withoutDatabase)).not.toBeNull();
  });
});

describe("S20 organization precondition: fail-closed wiring", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function build(reason: "signing_configuration_missing" | "owner_database_missing") {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = new Hono();
    const upgradeWebSocket = (() => async () => new Response(null, { status: 500 })) as unknown as UpgradeWebSocket;
    let clock = 1_000;
    registerFailClosedCollaborationRoutes({ app, upgradeWebSocket, reason, now: () => clock });
    return { app, warn, advance: (ms: number) => { clock += ms; } };
  }

  it("mounts every collaboration route and denies with one generic body when signing configuration is missing", async () => {
    const { app, warn } = build("signing_configuration_missing");
    expect(warn).toHaveBeenCalledWith("[collaboration] wiring fail-closed", "signing_configuration_missing");
    const requests = [
      app.request("/api/collaboration/scopes/10000000-0000-4000-8000-000000000001"),
      app.request("/api/collaboration/runtimes/vps:x/scopes", { method: "POST", body: "{}" }),
      app.request("/api/collaboration/scopes/10000000-0000-4000-8000-000000000001/chat/requests", { method: "POST", body: "{}" }),
      app.request("/api/collaboration/invitations/10000000-0000-4000-8000-000000000002/accept", { method: "POST", body: "{}" }),
      app.request("/api/collaboration/scopes/10000000-0000-4000-8000-000000000001/members/user_x", { method: "DELETE" }),
      app.request("/ws/collaboration/scopes/10000000-0000-4000-8000-000000000001/events", {
        headers: { upgrade: "websocket", connection: "Upgrade" },
      }),
      app.request("/ws/collaboration/scopes/10000000-0000-4000-8000-000000000001/terminal"),
    ];
    for (const response of await Promise.all(requests)) {
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual({ error: "Collaboration unavailable" });
    }
  });

  it("applies the collaboration body limit to every mutating verb while fail-closed, DELETE included", async () => {
    const { app } = build("signing_configuration_missing");
    const oversized = "x".repeat(COLLABORATION_HTTP_BODY_LIMIT + 1);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await app.request("/api/collaboration/scopes/10000000-0000-4000-8000-000000000001/lifecycle", {
        method, body: oversized, headers: { "content-type": "application/json" },
      });
      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toEqual({ error: "Request too large" });
    }
    const bounded = await app.request("/api/collaboration/scopes/10000000-0000-4000-8000-000000000001/lifecycle", {
      method: "DELETE", body: "{}",
    });
    expect(bounded.status).toBe(503);
  });

  it("logs denials with the configuration reason at a bounded rate and never leaks it to clients", async () => {
    const { app, warn, advance } = build("owner_database_missing");
    warn.mockClear();
    await app.request("/api/collaboration/inbox");
    await app.request("/api/collaboration/shared");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[collaboration] request denied while fail-closed", "owner_database_missing");
    advance(61_000);
    const response = await app.request("/api/collaboration/shared");
    expect(warn).toHaveBeenCalledTimes(2);
    expect(await response.text()).not.toContain("owner_database_missing");
  });
});

describe("S20 organization precondition: membership evidence is the only gate", () => {
  const now = new Date("2026-09-20T12:00:00.000Z");
  const organizationId = "org_matrix_team";
  let fixture: CollaborationTestDatabase;
  let repository: CollaborationRepository;

  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fixture = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    repository = new CollaborationRepository(fixture.db, { now: () => now });
    await repository.createDirectScope({
      scopeId: collaborationIds.scope,
      organizationId: "org_matrix_team",
      ownerId: collaborationActors.owner,
      kind: "chat",
      resourceId: collaborationIds.chat,
      authorityRuntimeId: collaborationIds.runtime,
    });
    await fixture.db.updateTable("collaboration_scopes").set({ lifecycle: "shared", organization_id: organizationId })
      .where("id", "=", collaborationIds.scope).execute();
    await fixture.db.insertInto("collaboration_members").values({
      scope_id: collaborationIds.scope,
      actor_id: collaborationActors.editor,
      role: "editor",
      status: "accepted",
      organization_id: organizationId,
      invitation_id: null,
      invited_by: collaborationActors.owner,
      accepted_at: now.toISOString(),
      expires_at: null,
      revision: 1,
      joined_at: now.toISOString(),
      updated_at: now.toISOString(),
    }).execute();
  });

  afterEach(async () => {
    await fixture.destroy();
    vi.restoreAllMocks();
  });

  function source(reply: (input: { organizationId: string; actorId: string }) => Promise<
    { member: true; expiresAt: string } | { member: false }
  >): OrganizationMembershipSource & { calls: { organizationId: string; actorId: string }[] } {
    const calls: { organizationId: string; actorId: string }[] = [];
    return {
      calls,
      assertMembership: async (input) => {
        calls.push(input);
        return reply(input);
      },
    };
  }

  it("denies every actor, including the owner, while no membership source is registered", async () => {
    const precondition = createOrganizationPrecondition({ now: () => now });
    const authority = new CollaborationAuthority(repository, { now: () => now, organizationPrecondition: precondition });
    expect(precondition.describe()).toEqual({ source: "none" });
    for (const actorId of [collaborationActors.owner, collaborationActors.editor, collaborationActors.outsider]) {
      await expect(authority.authorize({ scopeId: collaborationIds.scope, actorId, action: "read" }))
        .rejects.toMatchObject({ code: "unavailable", message: "Collaboration unavailable" });
    }
    expect(console.warn).toHaveBeenCalledWith("[collaboration-org-precondition] denied", "no_membership_source");
  });

  it("allows only fresh positive evidence from the registered source, keyed by the scope's organization", async () => {
    const membership = source(async ({ actorId }) => actorId === collaborationActors.editor
      ? { member: true, expiresAt: new Date(now.getTime() + 20_000).toISOString() }
      : { member: false });
    const precondition = createOrganizationPrecondition({ now: () => now });
    precondition.registerSource(membership);
    expect(() => precondition.registerSource(membership)).toThrow();
    const authority = new CollaborationAuthority(repository, { now: () => now, organizationPrecondition: precondition });

    await expect(authority.authorize({
      scopeId: collaborationIds.scope, actorId: collaborationActors.editor, action: "read",
    })).resolves.toMatchObject({ role: "editor", organizationId });
    expect(membership.calls).toEqual([{ organizationId, actorId: collaborationActors.editor }]);

    // A valid session and existing scope membership are not enough once the organization says no.
    await fixture.db.insertInto("collaboration_members").values({
      scope_id: collaborationIds.scope, actor_id: collaborationActors.outsider, role: "viewer", status: "accepted",
      organization_id: organizationId, invitation_id: null, invited_by: collaborationActors.owner,
      accepted_at: now.toISOString(), expires_at: null, revision: 1, joined_at: now.toISOString(),
      updated_at: now.toISOString(),
    }).execute();
    await expect(authority.authorize({
      scopeId: collaborationIds.scope, actorId: collaborationActors.outsider, action: "read",
    })).rejects.toMatchObject({ code: "not_found" });
    expect(console.warn).toHaveBeenCalledWith("[collaboration-org-precondition] denied", "not_a_member");
  });

  it("treats expired evidence, source failures and a scope without an organization as denials", async () => {
    let reply: { member: true; expiresAt: string } | { member: false } | Error = {
      member: true, expiresAt: new Date(now.getTime() - 1).toISOString(),
    };
    const precondition = createOrganizationPrecondition({ now: () => now });
    precondition.registerSource(source(async () => {
      if (reply instanceof Error) throw reply;
      return reply;
    }));
    const authority = new CollaborationAuthority(repository, { now: () => now, organizationPrecondition: precondition });
    const authorize = () => authority.authorize({
      scopeId: collaborationIds.scope, actorId: collaborationActors.editor, action: "read",
    });

    await expect(authorize()).rejects.toMatchObject({ code: "not_found" });
    expect(console.warn).toHaveBeenCalledWith("[collaboration-org-precondition] denied", "evidence_expired");

    reply = new Error("upstream");
    await expect(authorize()).rejects.toMatchObject({ code: "unavailable" });
    expect(console.warn).toHaveBeenCalledWith("[collaboration-org-precondition] denied", "source_failure");

    reply = { member: true, expiresAt: new Date(now.getTime() + 20_000).toISOString() };
    await fixture.db.updateTable("collaboration_scopes").set({ organization_id: null })
      .where("id", "=", collaborationIds.scope).execute();
    await expect(authorize()).rejects.toMatchObject({ code: "not_found" });
    expect(console.warn).toHaveBeenCalledWith("[collaboration-org-precondition] denied", "no_organization_context");
  });

  it("logs each denial reason at most once per minute", async () => {
    let clock = now.getTime();
    const precondition = createOrganizationPrecondition({ now: () => new Date(clock) });
    const warn = console.warn as unknown as ReturnType<typeof vi.fn>;
    warn.mockClear();
    await expect(precondition.require({ organizationId, actorId: "user_a" })).rejects.toMatchObject({ code: "unavailable" });
    await expect(precondition.require({ organizationId, actorId: "user_b" })).rejects.toMatchObject({ code: "unavailable" });
    expect(warn).toHaveBeenCalledTimes(1);
    clock += 60_001;
    await expect(precondition.require({ organizationId, actorId: "user_c" })).rejects.toMatchObject({ code: "unavailable" });
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("S20 / T101: every scope and grant carries its organization", () => {
  const now = new Date("2026-09-20T12:00:00.000Z");
  let fixture: CollaborationTestDatabase;

  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fixture = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
  });

  afterEach(async () => {
    await fixture.destroy();
    vi.restoreAllMocks();
  });

  it("records the owning organization on the scope and the deriving organization on every grant", async () => {
    const repository = new CollaborationRepository(fixture.db, { now: () => now });
    const scope = await repository.createDirectScope({
      scopeId: collaborationIds.scope,
      ownerId: collaborationActors.owner,
      organizationId: "org_matrix_team",
      kind: "chat",
      resourceId: collaborationIds.chat,
      authorityRuntimeId: collaborationIds.runtime,
    });
    expect(scope.organizationId).toBe("org_matrix_team");
    await fixture.db.updateTable("collaboration_scopes").set({ lifecycle: "shared" })
      .where("id", "=", collaborationIds.scope).execute();
    const created = await repository.createInvitation({
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.owner,
      targetActorId: collaborationActors.editor,
      role: "editor",
      clientRequestId: "40000000-0000-4000-8000-000000000001",
      expectedRevision: 0,
      payloadHash: "a".repeat(64),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    });
    const rows = await fixture.db.selectFrom("collaboration_members")
      .select(["actor_id", "organization_id"]).where("scope_id", "=", created.scopeId).execute();
    expect(rows).toEqual(expect.arrayContaining([
      { actor_id: collaborationActors.owner, organization_id: "org_matrix_team" },
      { actor_id: collaborationActors.editor, organization_id: "org_matrix_team" },
    ]));
  });

  it("refuses to reuse a direct scope for another organization", async () => {
    const repository = new CollaborationRepository(fixture.db, { now: () => now });
    const input = {
      scopeId: collaborationIds.scope,
      ownerId: collaborationActors.owner,
      organizationId: "org_matrix_team",
      kind: "terminal" as const,
      resourceId: "terminal_release",
      authorityRuntimeId: collaborationIds.runtime,
    };
    await expect(repository.createDirectScope(input)).resolves.toMatchObject({ organizationId: "org_matrix_team" });
    await expect(repository.createDirectScope({ ...input, scopeId: "10000000-0000-4000-8000-000000000099", organizationId: "org_other_company" }))
      .rejects.toMatchObject({ code: "conflict" });
    expect(await fixture.db.selectFrom("collaboration_scopes").select("organization_id").execute())
      .toEqual([{ organization_id: "org_matrix_team" }]);
  });

  it("refuses to widen a pre-organization scope", async () => {
    const repository = new CollaborationRepository(fixture.db, { now: () => now });
    await repository.createDirectScope({
      scopeId: collaborationIds.scope,
      ownerId: collaborationActors.owner,
      organizationId: "org_matrix_team",
      kind: "chat",
      resourceId: collaborationIds.chat,
      authorityRuntimeId: collaborationIds.runtime,
    });
    await fixture.db.updateTable("collaboration_scopes").set({ lifecycle: "shared", organization_id: null })
      .where("id", "=", collaborationIds.scope).execute();
    await expect(repository.createInvitation({
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.owner,
      targetActorId: collaborationActors.editor,
      role: "editor",
      clientRequestId: "40000000-0000-4000-8000-000000000002",
      expectedRevision: 0,
      payloadHash: "a".repeat(64),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    })).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("S20 organization precondition: construction failures fail closed", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the runtime when construction and the partial-runtime step succeed", async () => {
    const runtime = { shutdown: vi.fn(async () => undefined) };
    const enable = vi.fn(async () => ({ available: true as const }));
    await expect(constructGatewayCollaborationOrFailClosed(async () => runtime, { onPartialRuntime: enable }))
      .resolves.toEqual({ ok: true, runtime });
    expect(enable).toHaveBeenCalledWith(runtime);
    expect(runtime.shutdown).not.toHaveBeenCalled();
  });

  it("maps a construction failure to the fail-closed reason with a generic log instead of throwing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(constructGatewayCollaborationOrFailClosed(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:5432 password=secret");
    })).resolves.toEqual({ ok: false, reason: "construction_failed" });
    expect(error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(error.mock.calls[0])).not.toContain("secret");
  });

  it("shuts down a partially built runtime when the follow-up step fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const runtime = { shutdown: vi.fn(async () => undefined) };
    await expect(constructGatewayCollaborationOrFailClosed(async () => runtime, {
      onPartialRuntime: async () => { throw new Error("inventory unavailable"); },
    })).resolves.toEqual({ ok: false, reason: "construction_failed" });
    expect(runtime.shutdown).toHaveBeenCalledOnce();
  });
});
