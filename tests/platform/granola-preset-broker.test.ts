import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGranolaPresetBroker } from "../../packages/platform/src/granola-preset-broker.js";

const discoveredTools = [
  { name: "list_meetings", inputSchema: { type: "object", properties: {} } },
  { name: "get_meetings", inputSchema: { type: "object", properties: { meeting_id: {} } } },
  { name: "get_account_info", inputSchema: { type: "object", properties: {} } },
];

function createDependencies(status = "ready") {
  const row = {
    id: "granola-server",
    status,
    created_at: new Date("2026-09-08T12:00:00.000Z"),
    tools: discoveredTools,
  };
  return {
    row,
    broker: {
      getPreset: vi.fn().mockResolvedValue(row),
      ensurePreset: vi.fn().mockResolvedValue(row),
      activatePreset: vi.fn().mockResolvedValue({ ...row, status: "ready" }),
      callSelectedTool: vi.fn().mockResolvedValue({ meetings: [] }),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    oauth: {
      start: vi.fn().mockResolvedValue("https://granola.ai/oauth"),
    },
  };
}

describe("Granola preset broker", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("projects only actions backed by discovered tools", async () => {
    const dependencies = createDependencies();
    const broker = createGranolaPresetBroker(dependencies);

    await expect(broker.listAvailableActions("user-1", "granola")).resolves.toEqual([
      "list_notes",
      "get_note",
      "get_account",
    ]);
    await expect(broker.listAvailableActions("user-1", "other-service")).resolves.toBeNull();
  });

  it("fails closed while a disabled preset cannot be activated", async () => {
    const dependencies = createDependencies("disabled");
    dependencies.broker.activatePreset.mockRejectedValueOnce(new Error("provider unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      createGranolaPresetBroker(dependencies).listAvailableActions("user-1", "granola"),
    ).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      "[granola] capability activation pending:",
      "provider unavailable",
    );
  });

  it("owns the Granola connect, call, and disconnect lifecycle", async () => {
    const dependencies = createDependencies();
    const broker = createGranolaPresetBroker(dependencies);

    await expect(broker.connect("user-1", { id: "granola" })).resolves.toEqual({
      url: "https://granola.ai/oauth",
    });
    await expect(broker.call({
      userId: "user-1",
      service: { id: "granola" },
      actionId: "get_note",
      params: { noteId: "meeting-1" },
    })).resolves.toEqual({ meetings: [] });
    await expect(broker.disconnect("user-1", "granola-server")).resolves.toBe(true);

    expect(dependencies.oauth.start).toHaveBeenCalledWith("user-1", "granola-server");
    expect(dependencies.broker.callSelectedTool).toHaveBeenCalledWith({
      userId: "user-1",
      serverId: "granola-server",
      toolName: "get_meetings",
      arguments: { meeting_id: "meeting-1" },
      approvalGranted: true,
    });
    expect(dependencies.broker.remove).toHaveBeenCalledWith("user-1", "granola-server");
  });
});
