import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { createClaudeChatProviderAdapter } from "../../packages/gateway/src/chat/claude-provider-adapter.js";
import { createMatrixMcpCapabilityRegistry } from "../../packages/gateway/src/chat/matrix-mcp-launch.js";
import { contextPrompt } from "../../packages/gateway/src/chat/agent-context.js";
import type { ChatRunContext } from "@matrix-os/contracts";

const context: ChatRunContext = {
  version: 1, requestHash: "a".repeat(64), chats: [],
  agent: { id: "bot_12345678", revision: 1, name: "Synthetic recipe", instructions: "Produce a public summary.",
    recipe: { skills: [], integrations: [{ service: "gmail" }], output: "Public source links" } },
};

it.each([
  { mode: "default", permission: "supervised", ownerMatches: true, scope: "call" },
  { mode: "review", permission: "full_access", ownerMatches: true, scope: "discovery" },
  { mode: "default", permission: "supervised", ownerMatches: false, scope: null },
])("projects successful $scope authority into the actual Claude stdin prompt", async ({ mode, permission, ownerMatches, scope }) => {
  const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: ownerMatches ? "owner_fixture" : "other_owner" });
  const frames: Array<{ type: string; message?: { content: string } }> = [];
  const spawnFn = vi.fn(() => {
    const process = new EventEmitter();
    const stdout = new EventEmitter(), stderr = new EventEmitter();
    return Object.assign(process, { stdout, stderr, kill: vi.fn(), stdin: {
      write(line: string, callback?: (error?: Error | null) => void) {
        const frame = JSON.parse(line); frames.push(frame); callback?.();
        if (frame.type === "user") queueMicrotask(() => {
          stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "result", subtype: "success", result: "synthetic", session_id: "session_fixture" })}\n`));
          process.emit("exit", 0, null);
        });
        return true;
      },
    } });
  });
  const adapter = createClaudeChatProviderAdapter({
    homePath: "/safe/home", spawnFn, resolveCredentialEnv: async () => ({}), matrixMcpCapabilityIssuer: registry,
  });
  try {
    for await (const _ of adapter.start({
      owner: { type: "personal", ownerId: "owner_fixture" }, chatId: "chat_fixture", turnId: "cturn_fixture", runId: "run_fixture",
      prompt: contextPrompt("Find public documentation", context, { deferIntegrationGuidance: true }), context,
      parts: [{ type: "text", text: "Find public documentation" }], selection: { instanceId: "claude_code_default", model: "claude-haiku-4-5" },
      interactionMode: mode, permissionMode: permission, signal: new AbortController().signal,
    })) { /* Drain the native transport. */ }
    const prompt = frames.find(frame => frame.type === "user")!.message!.content;
    expect(prompt).not.toContain("call list_integration_inventory");
    expect(prompt).toContain("Selected integration dependencies are unavailable through this route");
    if (scope) {
      expect(prompt).toContain("list_custom_mcp_servers");
      expect(prompt).toContain("describe_custom_mcp_server");
      if (scope === "call") expect(prompt).toContain("call_custom_mcp_tool");
      else {
        expect(prompt).not.toContain("call_custom_mcp_tool");
        expect(prompt).toContain("discovery only");
      }
    } else {
      expect(prompt).not.toContain("list_custom_mcp_servers");
      expect(prompt).toContain("No Matrix tools are available for this run");
    }
  } finally { registry.close(); }
});
