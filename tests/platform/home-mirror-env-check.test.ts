import { describe, it, expect, vi } from "vitest";
import {
  checkHomeMirrorS3Env,
  checkUnsafeDefaultSecrets,
} from "../../packages/platform/src/main.js";

describe("checkHomeMirrorS3Env (startup assertion for silent-failure #6)", () => {
  it("returns [] and does not log when MATRIX_HOME_MIRROR is not 'true'", () => {
    const log = vi.fn();
    const missing = checkHomeMirrorS3Env({}, log);
    expect(missing).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it("returns [] and does not log when MATRIX_HOME_MIRROR=true and trusted sync storage is configured", () => {
    const log = vi.fn();
    const missing = checkHomeMirrorS3Env(
      {
        MATRIX_HOME_MIRROR: "true",
        S3_ENDPOINT: "http://minio:9000",
        S3_ACCESS_KEY_ID: "minioadmin",
        S3_SECRET_ACCESS_KEY: "minioadmin",
        S3_BUCKET: "matrixos",
        PLATFORM_SECRET: "platform-secret-123",
      },
      log,
    );
    expect(missing).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it("accepts R2 accountId instead of an explicit endpoint", () => {
    const log = vi.fn();
    const missing = checkHomeMirrorS3Env(
      {
        MATRIX_HOME_MIRROR: "true",
        R2_ACCOUNT_ID: "acc_123",
        R2_ACCESS_KEY_ID: "minioadmin",
        R2_SECRET_ACCESS_KEY: "minioadmin",
        R2_BUCKET: "matrixos",
        PLATFORM_SECRET: "platform-secret-123",
      },
      log,
    );
    expect(missing).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it("warns with all missing requirement names when MATRIX_HOME_MIRROR=true and trusted sync storage is missing", () => {
    const log = vi.fn();
    const missing = checkHomeMirrorS3Env(
      { MATRIX_HOME_MIRROR: "true" },
      log,
    );
    expect(missing).toEqual([
      "S3_ENDPOINT/R2_ENDPOINT or R2_ACCOUNT_ID",
      "S3_ACCESS_KEY_ID/R2_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY/R2_SECRET_ACCESS_KEY",
      "S3_BUCKET/R2_BUCKET",
      "PLATFORM_SECRET",
    ]);
    expect(log).toHaveBeenCalledOnce();
    const msg = log.mock.calls[0][0];
    expect(msg).toContain("MATRIX_HOME_MIRROR=true");
    expect(msg).toContain("trusted sync storage is incomplete");
    expect(msg).toContain("S3_ENDPOINT/R2_ENDPOINT or R2_ACCOUNT_ID");
    expect(msg).toContain("S3_BUCKET/R2_BUCKET");
    expect(msg).toContain("PLATFORM_SECRET");
  });

  it("warns with only the subset of missing vars when some are present", () => {
    const log = vi.fn();
    const missing = checkHomeMirrorS3Env(
      {
        MATRIX_HOME_MIRROR: "true",
        S3_ENDPOINT: "http://minio:9000",
        S3_BUCKET: "matrixos",
        PLATFORM_SECRET: "platform-secret-123",
        // missing S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY
      },
      log,
    );
    expect(missing).toEqual([
      "S3_ACCESS_KEY_ID/R2_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY/R2_SECRET_ACCESS_KEY",
    ]);
    expect(log).toHaveBeenCalledOnce();
    const msg = log.mock.calls[0][0];
    expect(msg).toContain(
      "S3_ACCESS_KEY_ID/R2_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY/R2_SECRET_ACCESS_KEY",
    );
    // Should NOT mention the vars that are present.
    expect(msg).not.toContain("S3_ENDPOINT/R2_ENDPOINT or R2_ACCOUNT_ID,");
    expect(msg).not.toContain("S3_BUCKET/R2_BUCKET.");
  });

  it("does not throw (warning only, platform can still serve non-sync routes)", () => {
    const log = vi.fn();
    expect(() =>
      checkHomeMirrorS3Env({ MATRIX_HOME_MIRROR: "true" }, log),
    ).not.toThrow();
  });
});

describe("checkUnsafeDefaultSecrets", () => {
  it("allows dev defaults outside production", () => {
    const log = vi.fn();
    const problems = checkUnsafeDefaultSecrets(
      {
        NODE_ENV: "development",
        PLATFORM_SECRET: "dev-secret",
        PLATFORM_JWT_SECRET: "dev-platform-jwt-secret-please-change-32",
      },
      log,
    );

    expect(problems).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it("flags missing or known dev defaults in production", () => {
    const log = vi.fn();
    const problems = checkUnsafeDefaultSecrets(
      {
        NODE_ENV: "production",
        PLATFORM_SECRET: "dev-secret",
        PLATFORM_JWT_SECRET: "dev-platform-jwt-secret-please-change-32",
      },
      log,
    );

    expect(problems).toEqual(["PLATFORM_SECRET", "PLATFORM_JWT_SECRET"]);
    expect(log).toHaveBeenCalledOnce();
  });

  it("flags a missing PLATFORM_JWT_SECRET in production", () => {
    const log = vi.fn();
    const problems = checkUnsafeDefaultSecrets(
      {
        NODE_ENV: "production",
        PLATFORM_SECRET: "platform-secret-123",
      },
      log,
    );

    expect(problems).toEqual(["PLATFORM_JWT_SECRET"]);
    expect(log).toHaveBeenCalledOnce();
  });
});
