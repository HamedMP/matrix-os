import { describe, expect, it, vi } from "vitest";
import { ClerkOrganizationAdminClient } from "../../packages/platform/src/organizations/clerk-admin-client.js";

const actorId = "user_creator000000000000000";
const requestId = "a77b8e1c-6112-4250-93d8-650d6fca8174";
const orgId = "org_found000000000000000000";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("Clerk organization administration", () => {
  it("creates with a private request marker and no slug", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => json({ id: orgId, name: "A team" }));
    const client = new ClerkOrganizationAdminClient({ secretKey: "sk_test", fetchImpl: fetchImpl as typeof fetch });
    expect(await client.createOrganization({ actorId, name: "A team", requestId })).toEqual({ organizationId: orgId });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.clerk.com/v1/organizations");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body as string)).toEqual({ name: "A team", created_by: actorId, private_metadata: { matrixCreateRequestId: requestId } });
  });

  it("finds only the exact marker across membership pages, even when names match", async () => {
    const memberships = Array.from({ length: 101 }, (_, index) => ({
      organization: { id: `org_${String(index).padStart(24, "0")}`, name: "A team", created_at: 1_000_000 },
    }));
    const fetchImpl = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("organization_memberships")) {
        const offset = Number(parsed.searchParams.get("offset"));
        return json({ data: memberships.slice(offset, offset + 100), total_count: memberships.length });
      }
      return json({ id: parsed.pathname.split("/").at(-1), private_metadata: {
        matrixCreateRequestId: parsed.pathname.endsWith("00000100") ? requestId : "elsewhere",
      } });
    });
    const client = new ClerkOrganizationAdminClient({ secretKey: "sk_test", fetchImpl: fetchImpl as typeof fetch });
    expect(await client.findCreatedOrganization({ actorId, requestId, createdAt: new Date(900_000) }))
      .toEqual({ kind: "found", organizationId: "org_000000000000000000000100" });
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes("offset=100"))).toBe(true);
  });

  it("treats a failed page and a membership cap as inconclusive", async () => {
    const page = Array.from({ length: 100 }, (_, index) => ({ organization: { id: `org_${String(index).padStart(24, "0")}`, created_at: 1_000_000 } }));
    const failing = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("organization_memberships")) {
        return parsed.searchParams.get("offset") === "0" ? json({ data: page, total_count: 101 }) : json({ error: "Clerk unavailable" }, 503);
      }
      return json({ id: parsed.pathname.split("/").at(-1), private_metadata: {} });
    });
    const client = new ClerkOrganizationAdminClient({ secretKey: "sk_test", fetchImpl: failing as typeof fetch });
    expect(await client.findCreatedOrganization({ actorId, requestId, createdAt: new Date(900_000) })).toEqual({ kind: "inconclusive" });
    const capped = new ClerkOrganizationAdminClient({ secretKey: "sk_test", fetchImpl: vi.fn(async () => json({ data: page, total_count: 1_001 })) as typeof fetch });
    expect(await capped.findCreatedOrganization({ actorId, requestId, createdAt: new Date(900_000) })).toEqual({ kind: "inconclusive" });
  });
});
