import { describe, it, expect } from "vitest";
import { createRemotePrefixMapper } from "../../src/daemon/remote-prefix.js";

describe("createRemotePrefixMapper", () => {
  describe("when gatewayFolder is empty (full-mirror mode)", () => {
    const m = createRemotePrefixMapper("");

    it("toRemote is identity", () => {
      expect(m.toRemote("agents/foo.md")).toBe("agents/foo.md");
      expect(m.toRemote(".claude/config.json")).toBe(".claude/config.json");
      expect(m.toRemote("")).toBe("");
    });

    it("toLocal is identity (no filter)", () => {
      expect(m.toLocal("agents/foo.md")).toBe("agents/foo.md");
      expect(m.toLocal("system/qmd/index.json")).toBe("system/qmd/index.json");
    });

    it("does not filter any remote path", () => {
      // Regression: earlier impl used basename-as-prefix which filtered
      // everything that didn't start with the sync folder name.
      expect(m.toLocal("anything/at/all.txt")).not.toBeNull();
    });
  });

  describe("when gatewayFolder is a subtree name", () => {
    const m = createRemotePrefixMapper("audit");

    it("toRemote adds the folder prefix", () => {
      expect(m.toRemote("foo.txt")).toBe("audit/foo.txt");
      expect(m.toRemote("sub/bar.md")).toBe("audit/sub/bar.md");
    });

    it("toLocal strips the prefix for in-scope paths", () => {
      expect(m.toLocal("audit/foo.txt")).toBe("foo.txt");
      expect(m.toLocal("audit/sub/bar.md")).toBe("sub/bar.md");
    });

    it("toLocal returns null for out-of-scope paths", () => {
      expect(m.toLocal("notes/foo.md")).toBeNull();
      expect(m.toLocal("foo.txt")).toBeNull();
    });

    it("does not match prefixes that aren't at a path boundary", () => {
      // "audits/..." is NOT under "audit/" -- the slash guard matters.
      expect(m.toLocal("audits/report.md")).toBeNull();
    });
  });

  describe("tolerates leading/trailing slashes in folder", () => {
    it("normalizes '/audit/' to 'audit'", () => {
      const m = createRemotePrefixMapper("/audit/");
      expect(m.toRemote("foo.txt")).toBe("audit/foo.txt");
      expect(m.toLocal("audit/foo.txt")).toBe("foo.txt");
    });

    it("normalizes '//' to empty (full-mirror)", () => {
      const m = createRemotePrefixMapper("//");
      expect(m.toRemote("foo.txt")).toBe("foo.txt");
      expect(m.toLocal("foo.txt")).toBe("foo.txt");
    });
  });
});
