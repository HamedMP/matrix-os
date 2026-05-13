import { describe, expect, it, vi } from "vitest";
import { createAutomationActionRunner } from "../../../packages/gateway/src/messages/automation-actions.js";

describe("automation task action", () => {
  it("creates a scoped Matrix OS task from a matching message", async () => {
    const createTask = vi.fn().mockResolvedValue("task_1");
    const runner = createAutomationActionRunner({ createTask });

    const result = await runner({
      ownerId: "user_a",
      ruleId: "auto_0123456789abcdef0123456789abcdef",
      roomId: "!room:matrixos.local",
      body: "deadline tomorrow",
      action: { type: "create_task", titleTemplate: "Follow up: {body}" },
    });

    expect(result).toEqual({ ok: true, taskId: "task_1" });
    expect(createTask).toHaveBeenCalledWith({
      ownerId: "user_a",
      title: "Follow up: deadline tomorrow",
    });
  });
});
