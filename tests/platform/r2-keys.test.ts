import { describe, expect, it } from "vitest";

import {
  buildFileKey,
  buildManifestKey,
} from "../../packages/platform/src/r2-keys.js";

describe("platform R2 key helpers", () => {
  it("builds scoped sync keys for a valid owner", () => {
    expect(buildManifestKey("user_123")).toBe("matrixos-sync/user_123/manifest.json");
    expect(buildFileKey("user_123", "notes/./today.md")).toBe(
      "matrixos-sync/user_123/files/notes/today.md",
    );
  });

  it("rejects path traversal and invalid owner ids", () => {
    expect(() => buildFileKey("user_123", "../secrets.txt")).toThrow("Invalid sync path");
    expect(() => buildManifestKey("user/123")).toThrow("Invalid sync user id");
  });
});
