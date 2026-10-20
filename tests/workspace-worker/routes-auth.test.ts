import { afterEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createWorkspaceAuthenticator } from "../../packages/workspace-worker/src/auth.js";

afterEach(() => vi.unstubAllGlobals());
describe("fixed issuer shared workspace authentication", () => {
  it("verifies Clerk signature, issuer, audience and server derived subject", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = { ...await exportJWK(publicKey), kid: "test", alg: "RS256", use: "sig" };
    const network = vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", network);
    const auth = createWorkspaceAuthenticator({ clerk: { issuer: "https://clerk.preview.test", audience: "matrix-shared-preview" } });
    const token = (audience: string, issuer = "https://clerk.preview.test") => new SignJWT({}).setProtectedHeader({ alg: "RS256", kid: "test" }).setSubject("user_verified").setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime("5m").sign(privateKey);
    const request = async (audience: string, issuer?: string) => new Request("https://workspace.test/api/layout", { headers: { authorization: `Bearer ${await token(audience, issuer)}`, "x-owner-id": "victim" } });
    expect(await auth(await request("matrix-shared-preview"))).toBe("user_verified");
    expect(await auth(await request("another-app"))).toBeNull();
    expect(await auth(await request("matrix-shared-preview", "https://attacker.test"))).toBeNull();
    expect(network.mock.calls).toHaveLength(1);
    expect(String((network.mock.calls[0] as unknown[])[0])).toBe("https://clerk.preview.test/.well-known/jwks.json");
  });
  it("rejects attacker signatures and unconfigured auth", async () => {
    const auth = createWorkspaceAuthenticator({});
    expect(await auth(new Request("https://workspace.test", { headers: { authorization: "Bearer anything", "x-owner-id": "victim" } }))).toBeNull();
  });
  it("shares signing keys across request authenticators for one trusted issuer", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = {...await exportJWK(publicKey),kid:"cache",alg:"RS256",use:"sig"};
    const network=vi.fn(async()=>new Response(JSON.stringify({keys:[jwk]})));
    vi.stubGlobal("fetch",network);
    const options={clerk:{issuer:"https://shared-cache.preview.test",audience:"matrix-preview"}};
    const token=await new SignJWT({}).setProtectedHeader({alg:"RS256",kid:"cache"}).setSubject("user_cached").setIssuer(options.clerk.issuer).setAudience(options.clerk.audience).setIssuedAt().setExpirationTime("5m").sign(privateKey);
    const request=new Request("https://workspace.test",{headers:{authorization:`Bearer ${token}`}});
    expect(await createWorkspaceAuthenticator(options)(request)).toBe("user_cached");
    expect(await createWorkspaceAuthenticator(options)(request)).toBe("user_cached");
    expect(network).toHaveBeenCalledTimes(1);
  });
  it("maps only an exact fixed preview bearer to one owner, including unicode rejection", async () => {
    const token = "a".repeat(32);
    const auth = createWorkspaceAuthenticator({ previewBearer: { token, ownerId: "preview_owner" } });
    const request = (value: string) => new Request("https://workspace.test", { headers: { authorization: `Bearer ${value}`, "x-owner-id": "victim" } });
    expect(await auth(request(token))).toBe("preview_owner");
    expect(await auth(request("a".repeat(31) + "b"))).toBeNull();
    expect(await auth(request("a".repeat(31) + "é"))).toBeNull();
  });
});
