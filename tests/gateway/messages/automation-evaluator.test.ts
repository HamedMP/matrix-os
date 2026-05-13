import { describe, expect, it, vi } from "vitest";
import { evaluateAutomationRules } from "../../../packages/gateway/src/messages/automation-evaluator.js";

describe("automation evaluator", () => {
  it("runs matching rules only when room automation permission is enabled", async () => {
    const runAction = vi.fn().mockResolvedValue({ ok: true });
    const result = await evaluateAutomationRules({
      event: {
        ownerId: "user_a",
        roomId: "!room:matrixos.local",
        body: "deadline tomorrow",
      },
      permission: {
        ownerId: "user_a",
        roomId: "!room:matrixos.local",
        readEnabled: true,
        replyEnabled: false,
        automationEnabled: true,
        mentionOnly: false,
        revision: 2,
        createdAt: "2026-05-13T00:00:00.000Z",
        updatedAt: "2026-05-13T00:00:00.000Z",
      },
      rules: [{
        id: "auto_0123456789abcdef0123456789abcdef",
        ownerId: "user_a",
        name: "Deadlines",
        scope: "room",
        roomId: "!room:matrixos.local",
        trigger: { type: "text_contains", value: "deadline" },
        action: { type: "create_task", titleTemplate: "Follow up: {body}" },
        status: "enabled",
        createdAt: "2026-05-13T00:00:00.000Z",
        updatedAt: "2026-05-13T00:00:00.000Z",
      }],
      runAction,
    });

    expect(result.executed).toBe(1);
    expect(runAction).toHaveBeenCalledWith(expect.objectContaining({
      ruleId: "auto_0123456789abcdef0123456789abcdef",
      action: { type: "create_task", titleTemplate: "Follow up: {body}" },
    }));
  });

  it("does not run rules without automation permission", async () => {
    const runAction = vi.fn();
    const result = await evaluateAutomationRules({
      event: { ownerId: "user_a", roomId: "!room:matrixos.local", body: "deadline tomorrow" },
      permission: null,
      rules: [],
      runAction,
    });

    expect(result.executed).toBe(0);
    expect(runAction).not.toHaveBeenCalled();
  });
});
