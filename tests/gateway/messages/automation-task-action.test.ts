import { describe, expect, it, vi } from "vitest";
import { createAutomationActionRunner } from "../../../packages/gateway/src/messages/automation-actions.js";

describe("automation task action", () => {
  it("creates a scoped Matrix OS task from a matching message", async () => {
    const createTask = vi.fn().mockResolvedValue("task_1");
    const createDraft = vi.fn();
    const runner = createAutomationActionRunner({ createTask, createDraft });

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
    expect(createDraft).not.toHaveBeenCalled();
  });

  it("persists a scoped draft reply from a matching message", async () => {
    const createTask = vi.fn();
    const createDraft = vi.fn().mockResolvedValue("reply_1");
    const runner = createAutomationActionRunner({ createTask, createDraft });

    const result = await runner({
      ownerId: "user_a",
      ruleId: "auto_0123456789abcdef0123456789abcdef",
      roomId: "!room:matrixos.local",
      body: "deadline tomorrow",
      action: { type: "draft_reply", bodyTemplate: "I saw: {body}" },
    });

    expect(result).toEqual({ ok: true, draftReplyId: "reply_1" });
    expect(createDraft).toHaveBeenCalledWith({
      ownerId: "user_a",
      roomId: "!room:matrixos.local",
      ruleId: "auto_0123456789abcdef0123456789abcdef",
      body: "I saw: deadline tomorrow",
    });
    expect(createTask).not.toHaveBeenCalled();
  });

  it("uses action-specific template caps for task titles and draft bodies", async () => {
    const createTask = vi.fn().mockResolvedValue("task_1");
    const createDraft = vi.fn().mockResolvedValue("reply_1");
    const runner = createAutomationActionRunner({ createTask, createDraft });
    const longBody = "x".repeat(900);

    await runner({
      ownerId: "user_a",
      ruleId: "auto_0123456789abcdef0123456789abcdef",
      roomId: "!room:matrixos.local",
      body: longBody,
      action: { type: "create_task", titleTemplate: "{body}" },
    });
    await runner({
      ownerId: "user_a",
      ruleId: "auto_0123456789abcdef0123456789abcdef",
      roomId: "!room:matrixos.local",
      body: longBody,
      action: { type: "draft_reply", bodyTemplate: "{body}" },
    });

    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ title: "x".repeat(160) }));
    expect(createDraft).toHaveBeenCalledWith(expect.objectContaining({ body: longBody }));
  });
});
