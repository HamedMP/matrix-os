import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppAiRouteSelection } from "@matrix-os/contracts";
import { generateHostedBotsManagedText } from "../../packages/gateway/src/hosted-bots/managed-tools.js";
import { createHostedBotsManagedTools } from "../../packages/gateway/src/hosted-bots/managed-tool-catalog.js";

const route: AppAiRouteSelection = {
  harnessId: "matrix_ai", accountId: null, accessSourceId: "matrix_cloudflare", modelId: "@cf/zai-org/glm-5.3-flash",
};
const identity = { botId: "bot-qa", threadId: "thread-qa", sendId: "send-qa-abcdefghijkl" };
const tool = {
  name: "matrix_read_integration",
  description: "Read a connected app after Matrix approval",
  parameters: { type: "object", properties: { app: { type: "string" } }, required: ["app"] },
};
const requested = (name = tool.name) => ({
  choices: [{ finish_reason: "tool_calls", message: {
    content: null, tool_calls: [{ id: "call_1", type: "function", function: { name, arguments: '{"app":"google_drive"}' } }],
  } }],
});

function fixture(responses: unknown[], allowed = () => true) {
  const transport = vi.fn(async (_body: unknown) => responses.shift());
  const call = vi.fn(async () => ({ title: "Approved fixture" }));
  const options = {
    route, identity, prompt: "Use the configured tool", signal: new AbortController().signal,
    revalidate: async () => allowed(),
    tools: { list: async () => [tool], call },
    transport,
  };
  return { options, transport, call };
}

describe("Matrix-hosted managed provider tools", () => {
  it("executes only a catalog tool and returns the approved result to the same model", async () => {
    const { options, transport, call } = fixture([
      requested(), { choices: [{ finish_reason: "stop", message: { content: "Approved fixture" } }] },
    ]);
    expect(await generateHostedBotsManagedText(options)).toEqual({ text: "Approved fixture" });
    expect(call).toHaveBeenCalledExactlyOnceWith(tool.name, { app: "google_drive" }, identity, options.signal);
    expect(transport.mock.calls[0]?.[0]).toMatchObject({
      model: route.modelId, tool_choice: "auto", parallel_tool_calls: false,
      tools: [{ type: "function", function: tool }],
    });
    expect(transport.mock.calls[1]?.[0]).toMatchObject({
      messages: expect.arrayContaining([{ role: "tool", tool_call_id: "call_1", content: '{"title":"Approved fixture"}' }]),
    });
  });

  it("rejects model-supplied tool names absent from the Matrix catalog", async () => {
    const { options, call } = fixture([requested("run_terminal")]);
    await expect(generateHostedBotsManagedText(options)).rejects.toThrow("Unknown hosted Bot tool");
    expect(call).not.toHaveBeenCalled();
  });

  it("uses Anthropic tool blocks for the funded Claude route", async () => {
    const { options, transport, call } = fixture([
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_1", name: tool.name, input: { app: "google_drive" } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Approved fixture" }] },
    ]);
    expect(await generateHostedBotsManagedText({
      ...options, route: { ...route, accessSourceId: "matrix_included", modelId: "anthropic/claude-sonnet-5" },
    })).toEqual({ text: "Approved fixture" });
    expect(call).toHaveBeenCalledOnce();
    expect(transport.mock.calls[1]?.[0]).toMatchObject({
      messages: expect.arrayContaining([{ role: "user", content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: '{"title":"Approved fixture"}' },
      ] }]),
    });
  });

  it("rechecks route access after an approval wait before using the result", async () => {
    let allowed = true;
    const { options, transport, call } = fixture([requested()], () => allowed);
    call.mockImplementationOnce(async () => {
      allowed = false;
      return { title: "Revoked before model dispatch" };
    });
    await expect(generateHostedBotsManagedText(options)).rejects.toThrow("App AI access revoked");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("binds each model tool to the catalog's fixed target and preserves denial", async () => {
    const app = new Hono();
    const integration = vi.fn();
    const mcp = vi.fn();
    app.get("/integration/catalog", c => c.json({ services: [{ id: "google_drive", actions: [{
      id: "read_file", description: "Read a file", params: { fileId: { type: "string", required: true } },
    }] }] }));
    app.get("/mcp/catalog", c => c.json({ servers: [{
      id: "qa", name: "QA", tools: [{ name: "status", inputSchema: { type: "object" } }],
    }] }));
    app.post("/integration/read", async c => { integration(await c.req.json()); return c.json({ data: "approved" }); });
    app.post("/mcp/call", async c => { mcp(await c.req.json()); return c.json({ error: "forbidden" }, 403); });
    const tools = createHostedBotsManagedTools(app);
    const signal = new AbortController().signal;
    expect(await tools.list(signal)).toMatchObject([
      { name: "matrix_app_1", parameters: { required: ["fileId"] } }, { name: "matrix_mcp_1" },
    ]);
    expect(await tools.call("matrix_app_1", { fileId: "example" }, identity, signal)).toEqual({ data: "approved" });
    expect(integration).toHaveBeenCalledExactlyOnceWith({
      service: "google_drive", action: "read_file", params: { fileId: "example" },
    });
    expect(await tools.call("matrix_mcp_1", { tool: "incorrect-target" }, identity, signal))
      .toEqual({ error: "Matrix did not approve this tool request." });
    expect(mcp).toHaveBeenCalledExactlyOnceWith({ serverId: "qa", tool: "status", arguments: { tool: "incorrect-target" } });
  });
});
