import { describe, expect, it, vi } from "vitest";
import {
  CollaborationIdentifierResolutionError,
  PlatformCollaborationIdentifierResolver,
  normalizeCollaborationIdentifier,
} from "../../packages/platform/src/collaboration/identifier-resolver.js";

const owner = {
  actorId: "user_3DOZzxV9EqJVo3J0QCSK6XDn0Nh",
  displayName: "Nima Naderi",
};

describe("platform collaboration identifier resolution", () => {
  it("classifies bounded actor IDs, normalized emails, and usernames without fuzzy rewriting", () => {
    expect(normalizeCollaborationIdentifier(`  ${owner.actorId}  `)).toEqual({
      kind: "actor_id",
      value: owner.actorId,
    });
    expect(normalizeCollaborationIdentifier("  Person@Example.COM ")).toEqual({
      kind: "email",
      value: "person@example.com",
    });
    expect(normalizeCollaborationIdentifier(" NimaNaderi ")).toEqual({
      kind: "username",
      value: "nimanaderi",
    });
    expect(normalizeCollaborationIdentifier(" @NimaNaderi ")).toEqual({
      kind: "username",
      value: "nimanaderi",
    });
    expect(normalizeCollaborationIdentifier(" 7Nima ")).toEqual({ kind: "username", value: "7nima" });
    for (const malformed of ["@", "@a", "@@nimanaderi", "nima naderi", "person@", "x".repeat(64), "x".repeat(321)]) {
      expect(() => normalizeCollaborationIdentifier(malformed)).toThrow(CollaborationIdentifierResolutionError);
    }
  });

  it("resolves an exact internal actor ID without calling the identity provider", async () => {
    const fetchImpl = vi.fn();
    const resolver = resolverFixture({ fetchImpl });
    await expect(resolver.resolve(owner.actorId)).resolves.toEqual(owner);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("resolves username casing and one optional leading at-sign by exact normalized Matrix username", async () => {
    const listAccountsByUsername = vi.fn(async (username: string) => username === "nimanaderi" ? [owner] : []);
    const resolver = resolverFixture({ listAccountsByUsername });
    await expect(resolver.resolve("NimaNaderi")).resolves.toEqual(owner);
    await expect(resolver.resolve("@NIMANADERI")).resolves.toEqual(owner);
    expect(listAccountsByUsername).toHaveBeenNthCalledWith(1, "nimanaderi");
    expect(listAccountsByUsername).toHaveBeenNthCalledWith(2, "nimanaderi");
  });

  it("resolves only an exact verified Clerk email to an existing Matrix account", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe("https://api.clerk.com/v1/users");
      expect(url.searchParams.get("email_address")).toBe("person@example.com");
      expect(init).toMatchObject({ method: "GET", redirect: "error" });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Response.json([
        clerkUser(owner.actorId, "Person@Example.com", "verified"),
        clerkUser("user_partial", "person@example.com.invalid", "verified"),
        clerkUser("user_unverified", "person@example.com", "unverified"),
      ]);
    });
    const resolver = resolverFixture({ fetchImpl });
    await expect(resolver.resolve(" PERSON@example.COM ")).resolves.toEqual(owner);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("returns the same safe failure for unknown, ambiguous, duplicate, or inaccessible identifiers", async () => {
    const failures = [
      resolverFixture({ listAccountsByUsername: async () => [] }).resolve("unknownuser"),
      resolverFixture({ listAccountsByUsername: async () => [owner, { ...owner, actorId: "user_duplicate" }] })
        .resolve("nimanaderi"),
      resolverFixture({ listAccountsByUsername: async () => [owner, owner] }).resolve("nimanaderi"),
      resolverFixture({
        fetchImpl: async () => Response.json([
          clerkUser(owner.actorId, "person@example.com", "verified"),
          clerkUser("user_duplicate", "PERSON@example.com", "verified"),
        ]),
      }).resolve("person@example.com"),
      resolverFixture({
        fetchImpl: async () => Response.json([
          clerkUser(owner.actorId, "person@example.com", "verified"),
          clerkUser(owner.actorId, "PERSON@example.com", "verified"),
        ]),
      }).resolve("person@example.com"),
      resolverFixture({
        getAccountByActorId: async () => null,
        fetchImpl: async () => Response.json([clerkUser("user_inaccessible", "person@example.com", "verified")]),
      }).resolve("person@example.com"),
    ];
    for (const failure of failures) {
      await expect(failure).rejects.toMatchObject({
        name: "CollaborationIdentifierResolutionError",
        message: "Invitation target is unavailable",
      });
    }
  });

  it("does not expose identity-provider errors", async () => {
    const resolver = resolverFixture({
      fetchImpl: async () => new Response("Clerk database exploded", { status: 503 }),
    });
    await expect(resolver.resolve("person@example.com")).rejects.toMatchObject({
      message: "Invitation target is unavailable",
    });
  });
});

function resolverFixture(overrides: Partial<ConstructorParameters<typeof PlatformCollaborationIdentifierResolver>[0]> = {}) {
  return new PlatformCollaborationIdentifierResolver({
    clerkSecretKey: "sk_test_secret",
    getAccountByActorId: async (actorId) => actorId === owner.actorId ? owner : null,
    listAccountsByUsername: async (username) => username === "nimanaderi" ? [owner] : [],
    fetchImpl: async () => Response.json([]),
    ...overrides,
  });
}

function clerkUser(actorId: string, emailAddress: string, verificationStatus: string) {
  return {
    id: actorId,
    username: "nimanaderi",
    first_name: "Nima",
    last_name: "Naderi",
    primary_email_address_id: `email_${actorId}`,
    email_addresses: [{
      id: `email_${actorId}`,
      email_address: emailAddress,
      verification: { status: verificationStatus },
    }],
  };
}
