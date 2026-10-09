import { describe, expect, it, vi } from "vitest";
import type { BotToolRequest } from "@matrix-os/contracts";
import type { BotBrokerClient } from "../../packages/bot-runtime/src/broker-client.js";
import { capabilityForToolName, createBotTools } from "../../packages/bot-runtime/src/tools.js";

const BRAIN_TOOLS = ["brain_search", "brain_why", "brain_timeline", "brain_claims", "brain_brief", "brain_conflicts"];

function broker(reply = "1. PR #12 - 2026-10-01 - Bot chats") {
  const requests: BotToolRequest[] = [];
  const client: BotBrokerClient = {
    loadSession: vi.fn(), saveSession: vi.fn(), event: vi.fn(),
    tool: vi.fn(async (request: BotToolRequest) => {
      requests.push(request);
      return { ok: true as const, content: [{ type: "text" as const, text: reply }] };
    }),
  };
  return { client, requests };
}

const tools = (capabilities: Parameters<typeof createBotTools>[0]["capabilities"], client = broker().client) =>
  createBotTools({ capabilities, broker: client, state: { waitingForPerson: false, effectUnknown: false } });

describe("brain read tools for bots", () => {
  it("shows exactly the six brain tools with brain.read and none without it", () => {
    expect(tools(["brain.read"]).map((tool) => tool.name)).toEqual(BRAIN_TOOLS);
    expect(tools(["artifact.read", "memory.search", "interaction.create"]).map((tool) => tool.name))
      .not.toEqual(expect.arrayContaining(["brain_search"]));
    expect(tools([]).length).toBe(0);
    for (const name of BRAIN_TOOLS) expect(capabilityForToolName(name)).toBe("brain.read");
  });

  it("offers no detail and no impact, and an optional project on every tool", () => {
    for (const tool of tools(["brain.read"])) {
      const schema = tool.parameters as unknown as { properties: Record<string, unknown>; required?: string[] };
      expect(Object.keys(schema.properties)).not.toContain("detail");
      expect(Object.keys(schema.properties)).toContain("project");
      expect(schema.required ?? []).not.toContain("project");
      expect(tool.description).toContain("Read-only");
    }
    expect(tools(["brain.read"]).map((tool) => tool.name)).not.toContain("brain_impact");
    const why = tools(["brain.read"]).find((tool) => tool.name === "brain_why")!;
    expect((why.parameters as unknown as { required: string[] }).required).toEqual(["path"]);
  });

  it("sends one brain.read request with the tool, the optional project and only the tool's own fields", async () => {
    const { client, requests } = broker();
    const search = tools(["brain.read"], client).find((tool) => tool.name === "brain_search")!;
    const result = await search.execute("toolu_01", { query: "bot chats", limit: 5, project: "matrix-os", owner: "user_x" }, undefined);
    expect(result.content).toEqual([{ type: "text", text: "1. PR #12 - 2026-10-01 - Bot chats" }]);
    expect(requests).toEqual([{
      toolCallId: "toolu_01", capability: "brain.read",
      args: { tool: "search", project: "matrix-os", input: { query: "bot chats", limit: 5 } },
    }]);
    const brief = tools(["brain.read"], client).find((tool) => tool.name === "brain_brief")!;
    await brief.execute("toolu_02", { window: "week" }, undefined);
    expect(requests[1]).toMatchObject({ args: { tool: "brief", input: { window: "week" } } });
    expect(requests[1]!.args).not.toHaveProperty("project");
  });

  it("refuses a bad project before it reaches the broker", async () => {
    const { client, requests } = broker();
    const timeline = tools(["brain.read"], client).find((tool) => tool.name === "brain_timeline")!;
    await expect(timeline.execute("toolu_03", { entity: "file:a.ts", project: "../x" }, undefined)).rejects.toThrow("Fix: project");
    expect(requests).toEqual([]);
  });
});
