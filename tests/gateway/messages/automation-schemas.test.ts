import { describe, expect, it } from "vitest";
import { AutomationRuleCreateRequestSchema } from "../../../packages/gateway/src/messages/schemas.js";

describe("automation schemas", () => {
  it("accepts bounded discriminated trigger and action payloads", () => {
    const parsed = AutomationRuleCreateRequestSchema.parse({
      name: "Deadlines",
      scope: "room",
      roomId: "!room:matrixos.local",
      trigger: { type: "text_contains", value: "deadline" },
      action: { type: "create_task", titleTemplate: "Follow up: {body}" },
    });

    expect(parsed.action.type).toBe("create_task");
  });

  it("rejects unknown action payloads and overlong trigger values", () => {
    expect(() => AutomationRuleCreateRequestSchema.parse({
      name: "Bad",
      scope: "all_permitted",
      trigger: { type: "text_contains", value: "x".repeat(300) },
      action: { type: "shell_exec", command: "rm -rf /" },
    })).toThrow();
  });

  it("rejects network and account scopes until scoped dispatch is implemented", () => {
    for (const scope of ["network", "account"] as const) {
      expect(() => AutomationRuleCreateRequestSchema.parse({
        name: "Unsupported",
        scope,
        trigger: { type: "text_contains", value: "deadline" },
        action: { type: "create_task", titleTemplate: "Follow up: {body}" },
      })).toThrow(/network and account automation scopes are not available yet/);
    }
  });
});
