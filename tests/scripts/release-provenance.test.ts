import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseReleaseProvenance } from "../../scripts/release-provenance.mjs";

describe("release PR provenance", () => {
  it("accepts a PR number and GitHub login", () => {
    expect(parseReleaseProvenance({ sourcePr: "1907", sourceAuthor: "octo-dev" }))
      .toEqual({ sourcePr: 1907, sourceAuthor: "octo-dev" });
    expect(parseReleaseProvenance({})).toEqual({});
    expect(parseReleaseProvenance({ sourcePr: "", sourceAuthor: "" })).toEqual({});
  });

  it.each([
    [{ sourcePr: "0" }],
    [{ sourcePr: "1907abc" }],
    [{ sourcePr: "1000000000" }],
    [{ sourceAuthor: "not a login" }],
    [{ sourceAuthor: "x".repeat(40) }],
  ])("rejects %j", (input) => {
    expect(() => parseReleaseProvenance(input)).toThrow(/source/);
  });

  it("refuses invalid provenance before publishing anything", () => {
    const result = spawnSync("bash", ["scripts/publish-release.sh", "v2026.09.28-pr1907-1-1-abcdef0", "--source-pr", "abc"], {
      encoding: "utf8",
      env: { ...process.env, HOST_BUNDLE_DIST_DIR: "/nonexistent" },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--source-pr");
  });
});
