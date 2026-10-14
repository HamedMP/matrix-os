import { expect, it, vi } from "vitest";
import { BotToolRequestSchema } from "@matrix-os/contracts";
import { createBotTools } from "../../packages/bot-runtime/src/tools.js";

it("gives Pi only a gated shared browser tool with bounded observed actions", async () => {
  const call = vi.fn(async () => ({ ok: true as const, content: [{ type: "text" as const, text: '{"status":"agent"}' }] }));
  const tools = createBotTools({ capabilities: ["browser.action"], broker: { tool: call } as never,
    state: { waitingForPerson: false, effectUnknown: false } });
  expect(tools.map(tool => tool.name)).toEqual(["shared_browser"]);
  await tools[0]!.execute("browser_1", { action: "status" }, new AbortController().signal);
  expect(call).toHaveBeenCalledWith(expect.objectContaining({ capability: "browser.action", args: { action: "status" } }));
  expect(tools[0]!.description).toMatch(/same.*Chrome/i);
  expect(tools[0]!.description).toMatch(/fresh.*snapshot/i);
});
it("rejects CDP, arbitrary evaluation, caller identity and unobserved clicks before dispatch", () => {
  for (const args of [{ action: "evaluate", expression: "document.cookie" }, { action: "status", ownerId: "other" },
    { action: "status", cdpUrl: "http://localhost:9222/json" }, { action: "click", ref: "button_1" }]) {
    expect(BotToolRequestSchema.safeParse({ toolCallId: "browser_bad", capability: "browser.action", args }).success).toBe(false);
  }
});
