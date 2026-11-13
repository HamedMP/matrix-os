import { expect, it, vi } from "vitest";
import { BotToolRequestSchema, SharedBrowserActionSchema } from "@matrix-os/contracts";
import { createBotTools } from "../../packages/bot-runtime/src/tools.js";

it("gives Pi only a gated shared browser tool with bounded observed actions", async () => {
  const call = vi.fn().mockResolvedValue({ ok: true, content: [{ type: "text", text: '{"status":"agent"}' }] });
  const tools = createBotTools({ capabilities: ["browser.action"], broker: { tool: call } as never,
    state: { waitingForPerson: false, effectUnknown: false } });
  expect(tools.map(tool => tool.name)).toEqual(["shared_browser"]);
  const signal = new AbortController().signal;
  await tools[0]!.execute("browser_1", { action: "status" }, signal);
  expect(call).toHaveBeenCalledExactlyOnceWith({ toolCallId: "browser_1", capability: "browser.action", args: { action: "status" } }, signal);
  expect(call.mock.calls[0]?.[1]).toBe(signal);
  expect(tools[0]!.description).toMatch(/same.*Chrome/i);
  expect(tools[0]!.description).toMatch(/fresh.*snapshot/i);
});
it("rejects CDP, arbitrary evaluation, caller identity and unobserved clicks before dispatch", () => {
  for (const args of [{ action: "evaluate", expression: "document.cookie" }, { action: "status", ownerId: "other" },
    { action: "status", cdpUrl: "http://localhost:9222/json" }, { action: "click", ref: "button_1" }]) {
    expect(BotToolRequestSchema.safeParse({ toolCallId: "browser_bad", capability: "browser.action", args }).success).toBe(false);
  }
});

it("advertises executable observed click and original-download examples to the model", () => {
  const [tool] = createBotTools({ capabilities: ["browser.action"], broker: {} as never,
    state: { waitingForPerson: false, effectUnknown: false } });
  const examples = [...tool!.description.matchAll(/\{[^{}]+\}/g)].map(match => JSON.parse(match[0]));
  expect(examples.some(example => example.action === "download")).toBe(true);
  expect(examples.some(example => example.action === "click")).toBe(true);
  for (const example of examples) expect(SharedBrowserActionSchema.safeParse(example).success).toBe(true);
  expect(tool!.description).toMatch(/replace.*observationId.*ref/i);
});
