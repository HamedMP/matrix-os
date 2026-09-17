import { describe, expect, it } from "vitest";
import { SyncStateSchema, type LocalFileState } from "../../src/daemon/types.js";
import {
  classifyMappingIssue,
  mappingCapabilities,
} from "../../src/daemon/mapping-session.js";

const base = {
  id: "11111111-1111-4111-8111-111111111111",
  label: "Project",
  localRoot: "/tmp/project",
  remotePrefix: "projects/project",
  enabled: true,
  propagateDeletes: false,
  excludes: [],
};

describe("mapping session policy", () => {
  it.each([
    ["two_way", true, true],
    ["to_matrix", true, false],
    ["to_local", false, true],
  ] as const)("enforces %s direction", (direction, upload, download) => {
    expect(mappingCapabilities({ ...base, direction })).toEqual({ upload, download });
  });

  it("persists retained deletion evidence instead of treating absence as a tombstone", () => {
    const file: LocalFileState = {
      hash: `sha256:${"a".repeat(64)}`,
      lastSyncedHash: `sha256:${"a".repeat(64)}`,
      mtime: 1,
      size: 1,
      retainedDeletion: "local",
    };

    expect(SyncStateSchema.parse({
      manifestVersion: 1,
      lastSyncAt: 1,
      files: { "file.txt": file },
    }).files["file.txt"]?.retainedDeletion).toBe("local");
  });

  it.each([
    [Object.assign(new Error("permission denied"), { code: "EACCES" }), "permission"],
    [Object.assign(new Error("disk quota"), { code: "EDQUOT" }), "disk_full"],
    [new Error("Presign request failed: 413"), "oversized"],
    [Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" }), "network"],
    [new Error("unexpected"), "unknown"],
  ] as const)("classifies a bounded mapping issue without exposing raw errors", (error, expected) => {
    expect(classifyMappingIssue(error)).toBe(expected);
  });
});
