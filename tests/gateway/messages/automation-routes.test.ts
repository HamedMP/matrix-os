import { describe, expect, it, vi } from "vitest";
import { createMessagingTestApp, createRepositoryMock, ownerId, now } from "./helpers.js";

const ruleId = "auto_0123456789abcdef0123456789abcdef";

describe("automation routes", () => {
  it("creates, lists, pauses, and deletes automation rules", async () => {
    const rule = {
      id: ruleId,
      ownerId,
      name: "Deadlines",
      scope: "room",
      roomId: "!room:matrixos.local",
      trigger: { type: "text_contains", value: "deadline" },
      action: { type: "create_task", titleTemplate: "Follow up: {body}" },
      status: "enabled",
      createdAt: now,
      updatedAt: now,
    };
    const createAutomationRule = vi.fn().mockResolvedValue(rule);
    const listAutomationRules = vi.fn().mockResolvedValue({ items: [rule] });
    const pauseAutomationRule = vi.fn().mockResolvedValue({ ...rule, status: "paused" });
    const deleteAutomationRule = vi.fn().mockResolvedValue({ ruleId, status: "disabled" });
    const repository = createRepositoryMock({
      createAutomationRule,
      listAutomationRules,
      pauseAutomationRule,
      deleteAutomationRule,
    });
    const app = createMessagingTestApp(repository);

    const createRes = await app.request("/api/messages/automation/rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Deadlines",
        scope: "room",
        roomId: "!room:matrixos.local",
        trigger: { type: "text_contains", value: "deadline" },
        action: { type: "create_task", titleTemplate: "Follow up: {body}" },
      }),
    });
    expect(createRes.status).toBe(201);
    expect(createAutomationRule).toHaveBeenCalledWith(expect.objectContaining({ ownerId, name: "Deadlines" }));

    const listRes = await app.request("/api/messages/automation/rules");
    expect(listRes.status).toBe(200);
    await expect(listRes.json()).resolves.toMatchObject({ rules: [{ id: ruleId }] });

    const pauseRes = await app.request(`/api/messages/automation/rules/${ruleId}/pause`, { method: "POST" });
    expect(pauseRes.status).toBe(200);
    expect(pauseAutomationRule).toHaveBeenCalledWith({ ownerId, ruleId });

    const deleteRes = await app.request(`/api/messages/automation/rules/${ruleId}`, { method: "DELETE" });
    expect(deleteRes.status).toBe(200);
    expect(deleteAutomationRule).toHaveBeenCalledWith({ ownerId, ruleId });
  });
});
