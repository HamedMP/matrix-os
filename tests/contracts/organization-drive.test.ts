import { describe, expect, it } from "vitest";
import {
  OrganizationDriveFileSchema,
  OrganizationDriveUploadRequestSchema,
  OrganizationDriveAuthoritySchema,
} from "../../packages/contracts/src/organization-drive.js";

describe("organization drive contracts", () => {
  it("binds authority to an immutable organization and runtime generation", () => {
    const authority = {
      organizationId: "org_example",
      runtimeId: "vps:00000000-0000-4000-8000-000000000001",
      generation: 1,
      quotaBytes: 1_000_000_000_000,
    };
    expect(OrganizationDriveAuthoritySchema.parse(authority)).toEqual(authority);
    expect(OrganizationDriveAuthoritySchema.safeParse({ ...authority, generation: 0 }).success).toBe(false);
    expect(OrganizationDriveAuthoritySchema.safeParse({ ...authority, organizationId: "ashbarbour" }).success).toBe(false);
  });

  it("rejects traversal, ambiguous separators, and oversized transfer declarations", () => {
    for (const path of ["../secret", "a/../secret", "/absolute", "a\\b", "a//b", "a/./b", "a/", "", "a\0b"]) {
      expect(OrganizationDriveUploadRequestSchema.safeParse({ path, size: 5, sha256: "a".repeat(64), requestId: "req_123" }).success).toBe(false);
    }
    expect(OrganizationDriveUploadRequestSchema.safeParse({ path: "reports/report.txt", size: 100 * 1024 ** 2, sha256: "a".repeat(64), requestId: "req_123" }).success).toBe(true);
    expect(OrganizationDriveUploadRequestSchema.safeParse({ path: "reports/report.txt", size: 101 * 1024 ** 2, sha256: "a".repeat(64), requestId: "req_123" }).success).toBe(false);
  });

  it("requires immutable content version and integrity metadata", () => {
    const file = {
      id: "00000000-0000-4000-8000-000000000001",
      organizationId: "org_example",
      path: "reports/report.txt",
      version: 1,
      size: 5,
      sha256: "a".repeat(64),
      updatedBy: "user_owner",
      updatedAt: "2026-09-25T00:00:00.000Z",
    };
    expect(OrganizationDriveFileSchema.parse(file)).toEqual(file);
    expect(OrganizationDriveFileSchema.safeParse({ ...file, sha256: "invalid" }).success).toBe(false);
  });
});
