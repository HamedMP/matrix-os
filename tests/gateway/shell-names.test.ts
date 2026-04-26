import { describe, expect, it } from "vitest";
import {
  validateLayoutName,
  validateProfileName,
  validateSessionName,
  resolveShellCwd,
} from "../../packages/gateway/src/shell/names.js";

describe("shell name and path validation", () => {
  it("accepts safe session, layout, and profile slugs", () => {
    expect(validateSessionName("main")).toBe("main");
    expect(validateLayoutName("dev-workspace-1")).toBe("dev-workspace-1");
    expect(validateProfileName("local")).toBe("local");
  });

  it("rejects unsafe identifiers", () => {
    for (const value of ["Main", "-main", "main_", "../main", "a".repeat(65)]) {
      expect(() => validateSessionName(value)).toThrow("invalid_session_name");
      expect(() => validateLayoutName(value)).toThrow("invalid_layout_name");
      expect(() => validateProfileName(value)).toThrow("invalid_profile_name");
    }
  });

  it("resolves cwd inside the owner home", () => {
    expect(resolveShellCwd("~/projects/app", "/home/alice")).toBe(
      "/home/alice/projects/app",
    );
    expect(resolveShellCwd("work", "/home/alice")).toBe("/home/alice/work");
  });

  it("rejects cwd outside the owner home", () => {
    expect(() => resolveShellCwd("/etc", "/home/alice")).toThrow("invalid_cwd");
    expect(() => resolveShellCwd("../bob", "/home/alice")).toThrow("invalid_cwd");
  });
});
