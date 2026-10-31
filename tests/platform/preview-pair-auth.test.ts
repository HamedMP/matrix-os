import { describe, expect, it } from "vitest";
import { SignJWT, jwtVerify } from "jose";
import { issueSyncJwt } from "../../packages/platform/src/sync-jwt.js";
import { createClerkAuth } from "../../packages/platform/src/clerk-auth.js";
import * as auth from "../../packages/platform/src/preview-pair/auth.js";
const now = Math.floor(Date.now()/1000), controlKey = "c".repeat(40), previewKey = "p".repeat(40);
const controlIssuer = "https://control.clerk.accounts.dev", previewIssuer = "https://preview.clerk.accounts.dev";
const clerk = (secret: string, issuer: string) => createClerkAuth({ verifyToken: async token => (await jwtVerify(token,new TextEncoder().encode(secret),{issuer,algorithms:["HS256"]})).payload as any });
function verifier() { return (auth as any).createPreviewPairReaderAuthenticator({
  control: { clerk: clerk(controlKey, controlIssuer), issuer: controlIssuer, syncSecret: controlKey },
  preview: { clerk: clerk(previewKey, previewIssuer), issuer: previewIssuer, syncSecret: previewKey },
}); }
const request = (token: string, headers: Record<string,string>={}) => new Request("https://app.matrix-os.com/api/preview-pairs",{headers:{Authorization:`Bearer ${token}`,...headers}});
async function session(secret: string, issuer: string, exp=now+300) {
  return new SignJWT({sub:"user_fixture",sid:"sess_actual"}).setProtectedHeader({alg:"HS256"}).setIssuer(issuer).setIssuedAt(now).setExpirationTime(exp).sign(new TextEncoder().encode(secret));
}
describe("real pair reader credential verification", () => {
  it.each([[controlKey,controlIssuer,"control"],[previewKey,previewIssuer,"preview"]])("cryptographically assigns the identity domain", async (key,issuer,kind) => {
    expect(await verifier()(request(await session(key,issuer)))).toEqual({actorId:"user_fixture",kind,expiresAt:(now+300)*1000});
  });
  it.each([[controlKey,"control"],[previewKey,"preview"]])("accepts existing real-user Matrix device credentials",async (secret,kind) => {
    const jwt=await issueSyncJwt({secret,clerkUserId:"user_fixture",handle:"fixture",gatewayUrl:"https://app.matrix-os.com",sessionProvenance:"clerk-device"});
    expect(await verifier()(request(jwt.token))).toMatchObject({actorId:"user_fixture",kind});
  });
  it("does not promote a runtime token into a human principal",async () => {
    const jwt=await issueSyncJwt({secret:previewKey,clerkUserId:"user_fixture",handle:"fixture",gatewayUrl:"https://app.matrix-os.com"});
    await expect(verifier()(request(jwt.token))).rejects.toMatchObject({status:401});
  });
  it("ignores identity hints and rejects wrong issuer, signature, expired and malformed credentials",async () => {
    for(const token of [await session(controlKey,previewIssuer),await session("x".repeat(40),controlIssuer),await session(controlKey,controlIssuer,now-10),"not-a-token"])
      await expect(verifier()(request(token,{"X-Preview-Actor":"user_fixture","X-Preview-Kind":"control"}))).rejects.toMatchObject({status:401});
  });
  it("preserves a Preview identity even when a header claims control",async () => {
    const result=await verifier()(request(await session(previewKey,previewIssuer),{"X-Preview-Kind":"control"})); expect(result.kind).toBe("preview");
  });
  it("fails closed when identity domains share keys",() => {
    expect(() => (auth as any).createPreviewPairReaderAuthenticator({control:{issuer:controlIssuer,syncSecret:controlKey},preview:{issuer:previewIssuer,syncSecret:controlKey}})).toThrow();
  });
});
