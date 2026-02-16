import { describe, it, expect } from "vitest";
import {
  isToolDenied,
  DEFAULT_DENY_LIST,
} from "../../packages/gateway/src/security/tool-deny.js";

describe("T827: Gateway tool deny list", () => {
  it("default deny list blocks spawn_agent", () => {
    expect(isToolDenied("spawn_agent")).toBe(true);
  });

  it("default deny list blocks manage_cron", () => {
    expect(isToolDenied("manage_cron")).toBe(true);
  });

  it("default deny list blocks sync_files", () => {
    expect(isToolDenied("sync_files")).toBe(true);
  });

  it("allows non-denied tools", () => {
    expect(isToolDenied("load_skill")).toBe(false);
    expect(isToolDenied("read_file")).toBe(false);
    expect(isToolDenied("remember")).toBe(false);
  });

  it("user policy deny merges with default deny", () => {
    expect(isToolDenied("custom_dangerous_tool", ["custom_dangerous_tool"])).toBe(true);
    expect(isToolDenied("spawn_agent", ["custom_dangerous_tool"])).toBe(true);
  });

  it("user policy allow does NOT override default deny (defense in depth)", () => {
    expect(isToolDenied("spawn_agent", [], ["spawn_agent"])).toBe(true);
  });

  it("exports DEFAULT_DENY_LIST for introspection", () => {
    expect(DEFAULT_DENY_LIST).toContain("spawn_agent");
    expect(DEFAULT_DENY_LIST).toContain("manage_cron");
    expect(DEFAULT_DENY_LIST).toContain("sync_files");
  });
});
