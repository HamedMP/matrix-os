import { describe, expect, it, vi } from "vitest";
import {
  assertCollaborationPreconditions,
  assertMultiComputerMemberPreconditions,
  loadCollaborationIdentities,
  parseCollaborationIdentityEnvironment,
  verifyClerkFixtureUser,
} from "./collaboration-identities.js";

const environment = {
  CLERK_SECRET_KEY: "sk_test_fixture",
  COLLABORATION_E2E_ALLOWED_USER_IDS: "user_owner,user_member,user_outsider,user_guest",
  COLLABORATION_E2E_ORGANIZATION_ID: "org_fixture",
  COLLABORATION_E2E_OWNER_USER_ID: "user_owner",
  COLLABORATION_E2E_MEMBER_USER_ID: "user_member",
  COLLABORATION_E2E_OUTSIDER_USER_ID: "user_outsider",
  COLLABORATION_E2E_GUEST_USER_ID: "user_guest",
  PREVIEW_COLLABORATION_OWNER_USER_ID: "user_owner",
  MATRIX_COLLABORATION_E2E_BASE_URL: "https://preview.matrix-os.com",
  COLLABORATION_E2E_PREVIEW_PR_NUMBER: "1991",
};

function clerkUser(id: string, verified = true, flagged = true) {
  return {
    id,
    primary_email_address_id: `email_${id}`,
    email_addresses: [{ id: `email_${id}`, email_address: `${id}@example.invalid`, verification: { status: verified ? "verified" : "unverified" } }],
    public_metadata: { matrixE2e: flagged },
  };
}

describe("four-identity collaboration fixture", () => {
  it("accepts only the two reviewed platform origins and returns the exact preview handle", () => {
    expect(parseCollaborationIdentityEnvironment(environment).previewHandle).toBe("pr-1991");
    expect(parseCollaborationIdentityEnvironment({ ...environment, MATRIX_COLLABORATION_E2E_BASE_URL: "https://app.matrix-os.com" }).baseUrl).toBe("https://app.matrix-os.com");
    for (const baseUrl of ["https://owner.matrix-os.com", "http://app.matrix-os.com", "https://app.matrix-os.com/path", "https://app.matrix-os.com.evil.test"]) {
      expect(() => parseCollaborationIdentityEnvironment({ ...environment, MATRIX_COLLABORATION_E2E_BASE_URL: baseUrl })).toThrow();
    }
  });

  it("refuses roles outside the allowlist, duplicate roles, and mismatched preview ownership", () => {
    expect(() => parseCollaborationIdentityEnvironment({ ...environment, COLLABORATION_E2E_ALLOWED_USER_IDS: "user_owner,user_member" })).toThrow();
    expect(() => parseCollaborationIdentityEnvironment({ ...environment, COLLABORATION_E2E_GUEST_USER_ID: "user_owner" })).toThrow();
    expect(() => parseCollaborationIdentityEnvironment({ ...environment, PREVIEW_COLLABORATION_OWNER_USER_ID: "user_other" })).toThrow();
    expect(() => parseCollaborationIdentityEnvironment({ ...environment, PREVIEW_CLERK_USER_ID: "user_guest" })).toThrow();
  });

  it("refuses unknown users before making any Clerk request", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const config = parseCollaborationIdentityEnvironment(environment);
    await expect(verifyClerkFixtureUser(config, "user_customer", fetchImpl)).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("checks the primary address and matrixE2e marker before allowing sign-in", async () => {
    const config = parseCollaborationIdentityEnvironment(environment);
    for (const user of [clerkUser("user_member", false), clerkUser("user_member", true, false), clerkUser("user_other")]) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(user), { status: 200 }));
      await expect(verifyClerkFixtureUser(config, "user_member", fetchImpl)).rejects.toThrow();
    }
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(clerkUser("user_member")), { status: 200 }));
    expect(await verifyClerkFixtureUser(config, "user_member", fetchImpl)).toEqual({ id: "user_member", emailAddress: "user_member@example.invalid" });
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    const withUnverifiedSecondary = clerkUser("user_member");
    withUnverifiedSecondary.email_addresses.push({ id: "email_secondary", email_address: "second@example.invalid", verification: { status: "unverified" } });
    const secondaryFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(withUnverifiedSecondary), { status: 200 }));
    await expect(verifyClerkFixtureUser(config, "user_member", secondaryFetch)).resolves.toMatchObject({ id: "user_member" });
  });

  it("rejects a large Clerk response without reading it into memory", async () => {
    const config = parseCollaborationIdentityEnvironment(environment);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("x".repeat(65 * 1024), { status: 200 }));
    await expect(verifyClerkFixtureUser(config, "user_member", fetchImpl)).rejects.toThrow("could not be verified");
  });

  it("validates every role before any sign-in token can be minted", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const id = new URL(String(input)).pathname.split("/").at(-1)!;
      return new Response(JSON.stringify(clerkUser(id)), { status: 200 });
    });
    const result = await loadCollaborationIdentities(environment, fetchImpl);
    expect(Object.keys(result.users)).toEqual(["owner", "member", "outsider", "guest"]);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(fetchImpl.mock.calls.every(([input]) => String(input).includes("/v1/users/"))).toBe(true);
  });

  it("requires the preview in the owner's inventory and excludes preview access for machine-free roles", () => {
    const config = parseCollaborationIdentityEnvironment(environment);
    const good = {
      owner: { computers: [{ handle: "pr-1991" }], phase: "ready", organizations: [{ organizationId: "org_fixture", role: "org:admin" }], inboxCount: 0, sharedCount: 0 },
      member: { computers: [], phase: "plan_required", organizations: [{ organizationId: "org_fixture", role: "org:member" }], inboxCount: 0, sharedCount: 0 },
      outsider: { computers: [], phase: "plan_required", organizations: [], inboxCount: 0, sharedCount: 0 },
      guest: { computers: [], phase: "plan_required", organizations: [], inboxCount: 0, sharedCount: 0 },
    } as const;
    expect(() => assertCollaborationPreconditions(config, good)).not.toThrow();
    expect(() => assertCollaborationPreconditions(config, { ...good, owner: { ...good.owner, computers: [] } })).toThrow();
    expect(() => assertCollaborationPreconditions(config, { ...good, member: { ...good.member, computers: [{ handle: "pr-1991" }] } })).toThrow();
    expect(() => assertCollaborationPreconditions(config, { ...good, guest: { ...good.guest, phase: "ready" } })).toThrow();
    expect(() => assertCollaborationPreconditions(config, { ...good, outsider: { ...good.outsider, organizations: [{ organizationId: "org_fixture", role: "org:member" }] } })).toThrow();
    expect(() => assertCollaborationPreconditions(config, { ...good, guest: { ...good.guest, sharedCount: 1 } })).toThrow();
  });

  it("requires the optional multi-computer identity to remain an ordinary member", () => {
    const config = parseCollaborationIdentityEnvironment(environment);
    const member = { computers: [{ handle: "one" }, { handle: "two" }], phase: "ready", organizations: [{ organizationId: "org_fixture", role: "org:member" }], inboxCount: 0, sharedCount: 0 };
    expect(() => assertMultiComputerMemberPreconditions(config, member)).not.toThrow();
    expect(() => assertMultiComputerMemberPreconditions(config, { ...member, organizations: [{ organizationId: "org_fixture", role: "org:admin" }] })).toThrow();
    expect(() => assertMultiComputerMemberPreconditions(config, { ...member, computers: [{ handle: "one" }] })).toThrow();
  });
});
