import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Kysely, sql } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import {
  ContextVerificationError,
  createPermissionEvaluator,
  createRealtimeAuthorizationLease,
  ensureRuntime,
  findActiveRuntime,
  initializeRuntimeSpikeSchema,
  issueContextToken,
  verifyContextToken,
  type AuthorizableResource,
  type MembershipProof,
  type ResourceGrant,
  type RuntimeDatabase,
} from "../../spike/company-os-owner-context/model.js";

const TOKEN_KEY = new TextEncoder().encode(
  "company-os-spike-only-secret-with-at-least-32-bytes",
);
const NOW_SECONDS = 1_786_032_000;

const activeMembership: MembershipProof = {
  id: "mem_alice_acme",
  actorUserId: "user_alice",
  organizationId: "org_acme",
  role: "member",
  membershipVersion: 7,
  policyVersion: 11,
  status: "active",
};

async function issueOrgToken(
  overrides: Partial<Parameters<typeof issueContextToken>[0]> = {},
): Promise<string> {
  return issueContextToken({
    actorUserId: "user_alice",
    owner: { type: "organization", id: "org_acme" },
    runtimeId: "rtm_acme_primary",
    runtimeSlot: "primary",
    membershipId: activeMembership.id,
    organizationRole: activeMembership.role,
    membershipVersion: activeMembership.membershipVersion,
    policyVersion: activeMembership.policyVersion,
    issuer: "https://platform.matrix-os.test",
    audience: "matrix-gateway",
    issuedAt: NOW_SECONDS,
    expiresAt: NOW_SECONDS + 300,
    key: TOKEN_KEY,
    ...overrides,
  });
}

describe("Spike A: verifiable actor and owner context", () => {
  it("verifies a personal owner only when actor, owner, and runtime all match", async () => {
    const token = await issueContextToken({
      actorUserId: "user_alice",
      owner: { type: "user", id: "user_alice" },
      runtimeId: "rtm_alice_primary",
      runtimeSlot: "primary",
      issuer: "https://platform.matrix-os.test",
      audience: "matrix-gateway",
      issuedAt: NOW_SECONDS,
      expiresAt: NOW_SECONDS + 300,
      key: TOKEN_KEY,
    });

    const context = await verifyContextToken(token, {
      key: TOKEN_KEY,
      issuer: "https://platform.matrix-os.test",
      audience: "matrix-gateway",
      expectedRuntimeId: "rtm_alice_primary",
      expectedOwner: { type: "user", id: "user_alice" },
      now: NOW_SECONDS + 10,
      getMembership: async () => null,
    });

    expect(context.actorUserId).toBe("user_alice");
    expect(context.owner).toEqual({ type: "user", id: "user_alice" });
  });

  it("rechecks the org membership and policy versions before accepting an org token", async () => {
    const token = await issueOrgToken();

    const context = await verifyContextToken(token, {
      key: TOKEN_KEY,
      issuer: "https://platform.matrix-os.test",
      audience: "matrix-gateway",
      expectedRuntimeId: "rtm_acme_primary",
      expectedOwner: { type: "organization", id: "org_acme" },
      now: NOW_SECONDS + 10,
      getMembership: async () => activeMembership,
    });

    expect(context.organizationRole).toBe("member");
    expect(context.membershipVersion).toBe(7);
    expect(context.policyVersion).toBe(11);
  });

  it.each([
    ["another runtime", { expectedRuntimeId: "rtm_other_primary" }, activeMembership],
    ["another owner type", { expectedOwner: { type: "user", id: "user_alice" } }, activeMembership],
    ["missing membership", {}, null],
    ["revoked membership", {}, { ...activeMembership, status: "revoked" }],
    ["stale membership version", {}, { ...activeMembership, membershipVersion: 8 }],
    ["stale policy version", {}, { ...activeMembership, policyVersion: 12 }],
    ["stale role", {}, { ...activeMembership, role: "guest" }],
  ] as const)("rejects %s without revealing which check failed", async (_label, overrides, proof) => {
    const token = await issueOrgToken();
    await expect(
      verifyContextToken(token, {
        key: TOKEN_KEY,
        issuer: "https://platform.matrix-os.test",
        audience: "matrix-gateway",
        expectedRuntimeId: "rtm_acme_primary",
        expectedOwner: { type: "organization", id: "org_acme" },
        now: NOW_SECONDS + 10,
        getMembership: async () => proof,
        ...overrides,
      }),
    ).rejects.toMatchObject({ code: "invalid_context", message: "Owner context is not valid" });
  });

  it("rejects malformed owner identifiers before minting", async () => {
    await expect(issueOrgToken({ owner: { type: "organization", id: "../org_acme" } })).rejects.toBeInstanceOf(
      ContextVerificationError,
    );
  });

  it("rejects actor/owner confusion for a personal context", async () => {
    await expect(
      issueContextToken({
        actorUserId: "user_alice",
        owner: { type: "user", id: "user_bob" },
        runtimeId: "rtm_bob_primary",
        runtimeSlot: "primary",
        issuer: "https://platform.matrix-os.test",
        audience: "matrix-gateway",
        issuedAt: NOW_SECONDS,
        expiresAt: NOW_SECONDS + 300,
        key: TOKEN_KEY,
      }),
    ).rejects.toMatchObject({ code: "invalid_context" });
  });

  it("rejects an expired token", async () => {
    const token = await issueOrgToken({ expiresAt: NOW_SECONDS + 5 });
    await expect(
      verifyContextToken(token, {
        key: TOKEN_KEY,
        issuer: "https://platform.matrix-os.test",
        audience: "matrix-gateway",
        expectedRuntimeId: "rtm_acme_primary",
        expectedOwner: { type: "organization", id: "org_acme" },
        now: NOW_SECONDS + 10,
        getMembership: async () => activeMembership,
      }),
    ).rejects.toMatchObject({ code: "invalid_context" });
  });
});

describe("Spike B: generic runtime ownership and idempotency", () => {
  let pglite: InstanceType<typeof KyselyPGlite>;
  let db: Kysely<RuntimeDatabase>;

  beforeEach(async () => {
    pglite = await KyselyPGlite.create();
    db = new Kysely<RuntimeDatabase>({ dialect: pglite.dialect });
    await initializeRuntimeSpikeSchema(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("represents current user-owned primary lookups without changing the invariant", async () => {
    const created = await ensureRuntime(db, {
      owner: { type: "user", id: "user_alice" },
      runtimeSlot: "primary",
      runtimeClass: "production",
    });

    const found = await findActiveRuntime(db, { type: "user", id: "user_alice" }, "primary");
    expect(found?.runtimeId).toBe(created.runtimeId);
    expect(found?.owner).toEqual({ type: "user", id: "user_alice" });
  });

  it("converges concurrent organization creates to one active primary runtime", async () => {
    const results = await Promise.all(
      Array.from({ length: 24 }, () =>
        ensureRuntime(db, {
          owner: { type: "organization", id: "org_acme" },
          runtimeSlot: "primary",
          runtimeClass: "production",
        }),
      ),
    );

    expect(new Set(results.map((result) => result.runtimeId))).toHaveLength(1);
    const count = await db
      .selectFrom("company_os_spike_runtimes")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("owner_type", "=", "organization")
      .where("owner_id", "=", "org_acme")
      .where("runtime_slot", "=", "primary")
      .where("deleted_at", "is", null)
      .executeTakeFirstOrThrow();
    expect(Number(count.count)).toBe(1);
  });

  it("recovers a failed provisioning attempt once and converges retries", async () => {
    const first = await ensureRuntime(db, {
      owner: { type: "organization", id: "org_acme" },
      runtimeSlot: "primary",
      runtimeClass: "production",
    });
    await db
      .updateTable("company_os_spike_runtimes")
      .set({ status: "failed" })
      .where("runtime_id", "=", first.runtimeId)
      .execute();

    const retried = await Promise.all(
      Array.from({ length: 8 }, () =>
        ensureRuntime(db, {
          owner: { type: "organization", id: "org_acme" },
          runtimeSlot: "primary",
          runtimeClass: "production",
        }),
      ),
    );

    expect(new Set(retried.map((result) => result.runtimeId))).toEqual(new Set([first.runtimeId]));
    expect(new Set(retried.map((result) => result.provisioningGeneration))).toEqual(new Set([2]));
    expect(retried[0]?.status).toBe("provisioning");
  });

  it("authorizes a member through membership without making them runtime owner", async () => {
    await sql`
      INSERT INTO company_os_spike_memberships
        (membership_id, organization_id, actor_user_id, role, status, membership_version, policy_version)
      VALUES
        (${activeMembership.id}, ${activeMembership.organizationId}, ${activeMembership.actorUserId},
         ${activeMembership.role}, ${activeMembership.status}, ${activeMembership.membershipVersion},
         ${activeMembership.policyVersion})
    `.execute(db);
    const runtime = await ensureRuntime(db, {
      owner: { type: "organization", id: "org_acme" },
      runtimeSlot: "primary",
      runtimeClass: "production",
    });

    const membership = await db
      .selectFrom("company_os_spike_memberships")
      .selectAll()
      .where("organization_id", "=", runtime.owner.id)
      .where("actor_user_id", "=", "user_alice")
      .where("status", "=", "active")
      .executeTakeFirst();
    expect(membership?.membership_id).toBe(activeMembership.id);
    expect(runtime.owner).toEqual({ type: "organization", id: "org_acme" });
    expect(runtime.owner.id).not.toBe("user_alice");
  });

  it("does not resolve a user-owned preview as an organization runtime", async () => {
    await ensureRuntime(db, {
      owner: { type: "user", id: "user_alice" },
      runtimeSlot: "pr-999",
      runtimeClass: "preview",
    });

    await expect(findActiveRuntime(db, { type: "organization", id: "org_acme" }, "pr-999")).resolves.toBeNull();
  });
});

describe("Spike C: reusable resource authorization and revocation", () => {
  const resources: AuthorizableResource[] = [
    { id: "res_vault", owner: { type: "organization", id: "org_acme" }, parentId: null, kind: "vault" },
    { id: "res_team", owner: { type: "organization", id: "org_acme" }, parentId: "res_vault", kind: "collection" },
    { id: "res_founders", owner: { type: "organization", id: "org_acme" }, parentId: "res_vault", kind: "collection" },
    { id: "res_project", owner: { type: "organization", id: "org_acme" }, parentId: "res_vault", kind: "project" },
    { id: "res_alice_private", owner: { type: "user", id: "user_alice" }, parentId: null, kind: "vault" },
    { id: "res_bob_private", owner: { type: "user", id: "user_bob" }, parentId: null, kind: "vault" },
  ];
  let grants: ResourceGrant[];
  let membershipVersions: Map<string, number>;

  beforeEach(() => {
    grants = [
      { id: "grant_alice_vault", resourceId: "res_vault", subjectUserId: "user_alice", effect: "allow", role: "viewer", version: 1 },
      { id: "grant_alice_founders_deny", resourceId: "res_founders", subjectUserId: "user_alice", effect: "deny", role: "viewer", version: 1 },
      { id: "grant_alice_project", resourceId: "res_project", subjectUserId: "user_alice", effect: "allow", role: "editor", version: 1 },
    ];
    membershipVersions = new Map([["user_alice", 1], ["user_bob", 1]]);
  });

  function evaluator() {
    return createPermissionEvaluator({
      resources,
      getGrants: () => grants,
      getOrganizationRole: (actor, orgId) => {
        if (orgId !== "org_acme") return null;
        return actor === "user_bob" ? "admin" : actor === "user_alice" ? "member" : null;
      },
      getMembershipPolicyVersion: (actor) => membershipVersions.get(actor) ?? null,
    });
  }

  it("allows Team, denies Founders, and allows explicit Project Alpha editing", () => {
    const authz = evaluator();
    expect(authz.decide({ actorUserId: "user_alice", resourceId: "res_team", operation: "read" }).allowed).toBe(true);
    expect(authz.decide({ actorUserId: "user_alice", resourceId: "res_founders", operation: "read" }).allowed).toBe(false);
    expect(authz.decide({ actorUserId: "user_alice", resourceId: "res_project", operation: "write" }).allowed).toBe(true);
  });

  it("lets an org admin administer org resources without crossing into private owners", () => {
    const authz = evaluator();
    expect(authz.decide({ actorUserId: "user_bob", resourceId: "res_team", operation: "administer" }).allowed).toBe(true);
    expect(authz.decide({ actorUserId: "user_bob", resourceId: "res_alice_private", operation: "read" }).allowed).toBe(false);
    expect(authz.decide({ actorUserId: "user_bob", resourceId: "res_bob_private", operation: "administer" }).allowed).toBe(false);
  });

  it("uses deterministic nearest-grant inheritance with deny winning at equal depth", () => {
    grants.push({
      id: "grant_alice_founders_allow",
      resourceId: "res_founders",
      subjectUserId: "user_alice",
      effect: "allow",
      role: "editor",
      version: 2,
    });
    const decision = evaluator().decide({ actorUserId: "user_alice", resourceId: "res_founders", operation: "read" });
    expect(decision).toMatchObject({ allowed: false, reason: "explicit_deny", matchedResourceId: "res_founders" });
  });

  it("returns one non-enumerating error for missing and forbidden resources", () => {
    const authz = evaluator();
    for (const resourceId of ["res_founders", "res_does_not_exist"]) {
      expect(() => authz.assert({ actorUserId: "user_alice", resourceId, operation: "read" })).toThrowError(
        expect.objectContaining({ code: "resource_not_found", message: "Resource not found" }),
      );
    }
  });

  it("reuses one decision for files, app data, and AI retrieval", () => {
    const authz = evaluator();
    for (const surface of ["files", "app_data", "ai_retrieval"] as const) {
      expect(authz.decide({ actorUserId: "user_alice", resourceId: "res_team", operation: "read", surface })).toMatchObject({
        allowed: true,
        surface,
      });
    }
  });

  it("invalidates the next read, write, and realtime authorization check after revoke", () => {
    const authz = evaluator();
    const lease = createRealtimeAuthorizationLease({
      evaluator: authz,
      actorUserId: "user_alice",
      resourceId: "res_project",
      operation: "write",
      policyVersion: 1,
    });
    expect(lease.check()).toEqual({ allowed: true, close: false });

    grants = grants.filter((grant) => grant.id !== "grant_alice_project" && grant.id !== "grant_alice_vault");
    membershipVersions.set("user_alice", 2);

    expect(authz.decide({ actorUserId: "user_alice", resourceId: "res_project", operation: "read" }).allowed).toBe(false);
    expect(authz.decide({ actorUserId: "user_alice", resourceId: "res_project", operation: "write" }).allowed).toBe(false);
    expect(lease.check()).toEqual({ allowed: false, close: true });
  });
});
