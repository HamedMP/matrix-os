import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  restoreEnvVarRefs,
} from "../../packages/gateway/src/config/env-preserve.js";

describe("T830: Config env-ref preservation", () => {
  beforeEach(() => {
    vi.stubEnv("TEST_API_KEY", "sk-secret-123");
    vi.stubEnv("DB_PASSWORD", "hunter2");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("restores ${VAR} when resolved value matches env", () => {
    const resolved = { apiKey: "sk-secret-123" };
    const original = { apiKey: "${TEST_API_KEY}" };
    const result = restoreEnvVarRefs(resolved, original);
    expect(result.apiKey).toBe("${TEST_API_KEY}");
  });

  it("traverses nested objects recursively", () => {
    const resolved = {
      channels: {
        telegram: { token: "sk-secret-123" },
      },
    };
    const original = {
      channels: {
        telegram: { token: "${TEST_API_KEY}" },
      },
    };
    const result = restoreEnvVarRefs(resolved, original) as typeof resolved;
    expect(result.channels.telegram.token).toBe("${TEST_API_KEY}");
  });

  it("leaves non-matching values as-is", () => {
    const resolved = { name: "My Bot", apiKey: "different-value" };
    const original = { name: "My Bot", apiKey: "${TEST_API_KEY}" };
    const result = restoreEnvVarRefs(resolved, original);
    expect(result.name).toBe("My Bot");
    expect(result.apiKey).toBe("different-value");
  });

  it("escape sequence $${VAR} becomes literal ${VAR}", () => {
    const resolved = { template: "${TEST_API_KEY}" };
    const original = { template: "$${TEST_API_KEY}" };
    const result = restoreEnvVarRefs(resolved, original);
    expect(result.template).toBe("$${TEST_API_KEY}");
  });

  it("handles array values correctly", () => {
    const resolved = { keys: ["sk-secret-123", "public-key"] };
    const original = { keys: ["${TEST_API_KEY}", "public-key"] };
    const result = restoreEnvVarRefs(resolved, original) as typeof resolved;
    expect(result.keys[0]).toBe("${TEST_API_KEY}");
    expect(result.keys[1]).toBe("public-key");
  });

  it("returns empty object for empty input", () => {
    expect(restoreEnvVarRefs({}, {})).toEqual({});
  });

  it("handles missing original gracefully", () => {
    const resolved = { newField: "value" };
    const result = restoreEnvVarRefs(resolved, {});
    expect(result.newField).toBe("value");
  });
});
