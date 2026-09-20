import { describe, expect, it, vi } from "vitest";
import { createHermesChatProviderAdapter } from "../../packages/gateway/src/chat/hermes-provider-adapter.js";
import { fakeGateway, baseInput } from "./hermes-test-gateway.js";

async function runTool(name: string, args: unknown, result: unknown) {
  const gateway = fakeGateway();
  const adapter = createHermesChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn: gateway.spawnFn });
  const promise = (async () => { const events = []; for await (const event of adapter.start(baseInput)) events.push(event); return events; })();
  await vi.waitFor(() => expect(gateway.requests.some(r => r.method === "prompt.submit")).toBe(true));
  gateway.event("tool.start", { tool_id: "tool_test", name, args });
  // Official completions may omit the original arguments.
  gateway.event("tool.complete", { tool_id: "tool_test", result });
  gateway.event("message.complete", { text: "Done.", status: "complete" });
  return promise;
}

describe("Hermes safe tool output publication", () => {
  it.each([
    ["terminal", { command: "printf safe" }, { output: "ALPHA\nBETA", exit_code: 0 }, "ALPHA\nBETA"],
    ["terminal", { command: "exit 7" }, { output: "EXPECTED_FAILURE", exit_code: 7 }, "EXPECTED_FAILURE"],
    ["read_file", { path: "/opt/matrix/app/BUNDLE_VERSION" }, { content: "v2026.09.20-pr1767" }, "v2026.09.20-pr1767"],
    ["mcp_weather", { city: "London" }, { content: [{ type: "text", text: "Sunny" }] }, "Sunny"],
  ])("publishes bounded %s result under the same activity id", async (name, args, result, text) => {
    const events = await runTool(name, args, result);
    expect(events).toContainEqual({ type: "tool.output", toolCallId: "tool_test", text, truncated: false });
  });
  it("retains private start context when completion omits arguments", async () => {
    const events = await runTool("read_file", { path: ".env" }, { content: "opaque-private-value" });
    expect(JSON.stringify(events)).not.toContain("opaque-private-value");
  });
  it("does not publish arbitrary result objects or private text", async () => {
    for (const result of [{ output: "api_key=secret-value" }, { password: "opaque-private-value" }]) {
      const events = await runTool("terminal", { command: "printf safe" }, result);
      expect(JSON.stringify(events)).not.toMatch(/secret-value|opaque-private-value/);
    }
  });
  it("reports truncation and filters secrets beyond the visible bound", async () => {
    const events = await runTool("terminal", { command: "printf safe" }, { output: "x".repeat(5000) });
    expect(events).toContainEqual({ type: "tool.output", toolCallId: "tool_test", text: "x".repeat(4000), truncated: true });
    const privateEvents = await runTool("terminal", { command: "printf safe" }, { output: "x".repeat(5000) + " api_key=hidden" });
    expect(JSON.stringify(privateEvents)).not.toContain("x".repeat(4000));
  });
});
