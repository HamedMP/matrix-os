import { describe, it, expect, vi } from "vitest";
import { checkHomeMirrorS3Env } from "../../packages/platform/src/main.js";

describe("checkHomeMirrorS3Env (startup assertion for silent-failure #6)", () => {
  it("returns [] and does not log when MATRIX_HOME_MIRROR is not 'true'", () => {
    const log = vi.fn();
    const missing = checkHomeMirrorS3Env({}, log);
    expect(missing).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it("returns [] and does not log when MATRIX_HOME_MIRROR=true and all S3 vars are set", () => {
    const log = vi.fn();
    const missing = checkHomeMirrorS3Env(
      {
        MATRIX_HOME_MIRROR: "true",
        S3_ENDPOINT: "http://minio:9000",
        S3_ACCESS_KEY_ID: "minioadmin",
        S3_SECRET_ACCESS_KEY: "minioadmin",
        S3_BUCKET: "matrixos",
      },
      log,
    );
    expect(missing).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it("warns with all missing var names when MATRIX_HOME_MIRROR=true and every S3 var is missing", () => {
    const log = vi.fn();
    const missing = checkHomeMirrorS3Env(
      { MATRIX_HOME_MIRROR: "true" },
      log,
    );
    expect(missing).toEqual([
      "S3_ENDPOINT",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
      "S3_BUCKET",
    ]);
    expect(log).toHaveBeenCalledOnce();
    const msg = log.mock.calls[0][0];
    expect(msg).toContain("MATRIX_HOME_MIRROR=true");
    expect(msg).toContain("S3 credentials are incomplete");
    expect(msg).toContain("S3_ENDPOINT");
    expect(msg).toContain("S3_BUCKET");
  });

  it("warns with only the subset of missing vars when some are present", () => {
    const log = vi.fn();
    const missing = checkHomeMirrorS3Env(
      {
        MATRIX_HOME_MIRROR: "true",
        S3_ENDPOINT: "http://minio:9000",
        S3_BUCKET: "matrixos",
        // missing S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY
      },
      log,
    );
    expect(missing).toEqual(["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]);
    expect(log).toHaveBeenCalledOnce();
    const msg = log.mock.calls[0][0];
    expect(msg).toContain("S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY");
    // Should NOT mention the vars that are present.
    expect(msg).not.toContain("S3_ENDPOINT,");
    expect(msg).not.toContain("S3_BUCKET.");
  });

  it("does not throw (warning only, platform can still serve non-sync routes)", () => {
    const log = vi.fn();
    expect(() =>
      checkHomeMirrorS3Env({ MATRIX_HOME_MIRROR: "true" }, log),
    ).not.toThrow();
  });
});
