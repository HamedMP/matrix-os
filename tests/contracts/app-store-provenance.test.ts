import { describe, expect, it } from "vitest";
import { AppStoreInstallRecordSchema } from "../../packages/contracts/src/app-store-gateway";

describe("installer provenance", () => {
  const record = { listingSlug: "habit-garden", appSlug: "habit-garden", versionId: "6f84f223-bd35-4e4d-ad4a-2fb7bd9174fa", version: "1.0.0",
    sourceSha256: "a".repeat(64), installedSourceSha256: "b".repeat(64), distSha256: "c".repeat(64),
    toolchain: { nodeVersion: "v24.13.1", pnpmVersion: "10.33.4", policyDigest: "d".repeat(64) },
    capabilities: { integrations: { required: [], optional: [] }, permissions: [], tables: [] },
    installedAt: "2026-10-18T12:00:00Z", updatedAt: "2026-10-18T12:00:00Z" };
  it("records reviewed bytes separately from normalized editable source and local output", () => {
    expect(AppStoreInstallRecordSchema.parse(record)).toEqual(record);
    expect(AppStoreInstallRecordSchema.safeParse({ ...record, installedSourceSha256: undefined }).success).toBe(false);
    expect(AppStoreInstallRecordSchema.safeParse({ ...record, toolchain: undefined }).success).toBe(false);
    expect(AppStoreInstallRecordSchema.safeParse({ ...record, toolchain: { ...record.toolchain, policyDigest: "invalid" } }).success).toBe(false);
  });
});
