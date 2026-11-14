import { expect, it, vi } from "vitest";
import { createBotTools } from "../../packages/bot-runtime/src/tools.js";
import { BotToolRequestSchema } from "@matrix-os/contracts";

it("offers only strict routine intent through the existing typed worker broker", async () => {
  const tool = vi.fn(async () => ({ ok: true as const, content: [{ type: "text" as const, text: '{"v":1,"ok":true,"data":{"kind":"list","routines":[],"truncated":false}}' }] }));
  const tools = createBotTools({ capabilities: ["routine.cli"], broker: { tool } as never,
    state: { waitingForPerson: false, effectUnknown: false } });
  expect(tools.map(item => item.name)).toEqual(["matrix_routines"]);
  const signal = new AbortController().signal;
  const result = await tools[0]!.execute("call_routine", { operation: "list" }, signal);
  expect(tool).toHaveBeenCalledExactlyOnceWith({ toolCallId: "call_routine", capability: "routine.cli", args: { operation: "list" } }, signal);
  expect(result.content).toEqual([{ type: "text", text: expect.stringContaining('"kind":"list"') }]);
  for (const forged of [{ ownerId: "foreign" }, { sourceId: "source_forged" }, { taskId: "task_forged" }, { executable: "sh" }, { accepted: true }]) {
    await expect(tools[0]!.execute("call_forged", { operation: "list", ...forged }, signal)).rejects.toThrow();
    expect(BotToolRequestSchema.safeParse({ toolCallId: "call_forged", capability: "routine.cli", args: { operation: "list", ...forged } }).success).toBe(false);
  }
  expect(tool).toHaveBeenCalledTimes(1);
});

it("cannot widen the canonical recipe Bot catalog with the managed-only tool", async () => {
  const { createBotRecipeCatalog } = await import("../../packages/gateway/src/bots/recipe-catalog.js");
  expect(() => createBotRecipeCatalog([{ recipeId: "managed_forgery", version: "1", name: "Forgery", description: "Denied", instructions: "Read",
    capabilities: ["routine.cli"], integrations: [], output: "Read" }])).toThrow();
});
