import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AppStoreDownloadGrantSchema, AppStoreReviewDecisionSchema, AppStoreStatusSchema, AppStoreVersionStatusSchema } from "../../packages/contracts/src/app-store";
import { signStoreApproval, verifyStoreApproval } from "../../packages/contracts/src/app-store-signing";

const keys = generateKeyPairSync("ed25519");
const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const payload = {
  versionId: "6f84f223-bd35-4e4d-ad4a-2fb7bd9174fa", version: "1.0.0",
  source: { sha256: "a".repeat(64), size: 100 }, capabilitiesDigest: "b".repeat(64),
  manifest: { name: "Garden", description: "Habit garden", version: "1.0.0", runtime: "vite" as const, permissions: [] },
};
describe("source approvals and local builds", () => {
  it("signs the reviewed source and verifies with an authenticated platform key", () => {
    const approval = signStoreApproval(payload, { keyId: "store-v1", privateKey });
    expect(verifyStoreApproval(payload, approval, [{ keyId: "store-v1", publicKey }])).toBe(true);
    expect(verifyStoreApproval({ ...payload, version: "2.0.0" }, approval, [{ keyId: "store-v1", publicKey }])).toBe(false);
    expect(verifyStoreApproval({ ...payload, manifest: { ...payload.manifest, name: "Other" } }, approval, [{ keyId: "store-v1", publicKey }])).toBe(false);
    expect(verifyStoreApproval(payload, approval, [])).toBe(false);
    expect(verifyStoreApproval(payload, { ...approval, signature: "invalid" }, [{ keyId: "store-v1", publicKey }])).toBe(false);
  });
  it("grants source without platform-built dist and requires a signature", () => {
    const approval = signStoreApproval(payload, { keyId: "store-v1", privateKey });
    const grant = { ...payload, source: { ...payload.source, url: "https://objects.example.com/source" }, approval,
      capabilities: { integrations: { required: [], optional: [] }, permissions: [], tables: [] } };
    expect(AppStoreDownloadGrantSchema.safeParse(grant).success).toBe(true);
    expect(AppStoreDownloadGrantSchema.safeParse({ ...grant, approval: undefined }).success).toBe(false);
    expect(AppStoreDownloadGrantSchema.safeParse({ ...grant, dist: grant.source }).success).toBe(false);
  });
  it("publishes after source review and removes platform build states/actions", () => {
    expect(AppStoreVersionStatusSchema.safeParse("published").success).toBe(true);
    expect(AppStoreVersionStatusSchema.safeParse("building").success).toBe(false);
    expect(AppStoreVersionStatusSchema.safeParse("build_failed").success).toBe(false);
    expect(AppStoreReviewDecisionSchema.safeParse({ type: "retry_build" }).success).toBe(false);
    expect(AppStoreStatusSchema.safeParse({ enabled: true, reviewer: false, signingKeys: [{ keyId: "store-v1", publicKey }] }).success).toBe(true);
  });
});
