import { describe, expect, it, vi } from "vitest";
import { createBotTools, capabilityForToolName } from "../../packages/bot-runtime/src/tools.js";

describe("Pi Jev inbox tool", () => {
  const tools = (broker: unknown, capabilities: string[] = ["jev.inbox"]) => createBotTools({ capabilities: capabilities as never,
    broker: broker as never, state: { waitingForPerson: false, effectUnknown: false } });
  it("only advertises the dedicated tool when admitted", () => {
    expect(tools({}).map((tool) => tool.name)).toEqual(["jev_inbox"]);
    expect(tools({}, []).map((tool) => tool.name)).not.toContain("jev_inbox");
    expect(capabilityForToolName("jev_inbox")).toBe("jev.inbox");
    expect(tools({})[0].parameters.type).toBe("object");
    expect(JSON.stringify(tools({})[0].parameters)).not.toMatch(/apiKey|ownerId|connectionId|verified/);
  });
  it("dispatches server-bound batch operations without credentials or account selectors", async () => {
    const tool = vi.fn().mockResolvedValue({ ok: true, content: [{ type: "text", text: "confirmed" }] });
    const result = await tools({ tool })[0].execute("call_1", { operation: "batch_start", maxThreads: 30 });
    expect(tool).toHaveBeenCalledWith({ toolCallId: "call_1", capability: "jev.inbox", args: { operation: "batch_start", maxThreads: 30 } });
    expect(result.content).toEqual([{ type: "text", text: "confirmed" }]);
  });
  it("rejects arbitrary write instructions before reaching the broker", async () => {
    const tool = vi.fn();
    await expect(tools({ tool })[0].execute("call_2", { operation: "batch_start", labels: ["INBOX"] })).rejects.toThrow(/not valid/);
    expect(tool).not.toHaveBeenCalled();
  });
});
