import { afterEach, describe, expect, it, vi } from "vitest";
import { createPipedreamClient } from "../../packages/gateway/src/integrations/pipedream.js";

afterEach(() => vi.unstubAllGlobals());
describe("Jev bounded GET production SDK wiring", () => {
  it("reuses the real SDK rawAccessToken getter/cache and fixes owner/account on every request", async () => {
    const observed: { url: URL; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (raw: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(raw instanceof Request ? raw.url : String(raw));
      observed.push({ url, init });
      if (url.pathname === "/v1/oauth/token") return Response.json({
        access_token: "synthetic-access-token", token_type: "Bearer", expires_in: 3600,
      });
      if (url.pathname.includes("/proxy/")) return Response.json({ emailAddress: "me@example.test" });
      throw new Error("Unexpected synthetic endpoint");
    }));
    const client = await createPipedreamClient({ clientId: "synthetic-id", clientSecret: "synthetic-secret",
      projectId: "proj_fixture", environment: "production" });
    const bounded = Reflect.get(client, "boundedGmailGet");
    expect(typeof bounded).toBe("function");
    const input = { externalUserId: "owner_fixture", accountId: "apn_fixture", kind: "profile" };
    expect(await bounded(input)).toEqual({ emailAddress: "me@example.test" });
    expect(await bounded(input)).toEqual({ emailAddress: "me@example.test" });
    expect(observed.filter(({ url }) => url.pathname === "/v1/oauth/token")).toHaveLength(1);
    const reads = observed.filter(({ url }) => url.pathname.includes("/proxy/"));
    expect(reads).toHaveLength(2);
    for (const { url, init } of reads) {
      expect(url.searchParams.get("external_user_id")).toBe("owner_fixture");
      expect(url.searchParams.get("account_id")).toBe("apn_fixture");
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer synthetic-access-token");
      expect(init.method).toBe("GET");
      expect(init.redirect).toBe("error");
    }
  });
});
