import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createClaudeChatProviderAdapter } from "../../packages/gateway/src/chat/claude-provider-adapter.js";
import { createMatrixMcpCapabilityRegistry, type MatrixMcpCapabilityIssuer } from "../../packages/gateway/src/chat/matrix-mcp-launch.js";

function fakeClaude() {
  return vi.fn(() => {
    const process = new EventEmitter();
    const stdout = new EventEmitter(), stderr = new EventEmitter();
    return Object.assign(process, { stdout, stderr, kill: vi.fn(), stdin: {
      write(line: string, callback?: (error?: Error | null) => void) {
        callback?.();
        if (JSON.parse(line).type === "user") queueMicrotask(() => {
          stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "result", subtype: "success", result: "ok", session_id: "session_fixture" })}\n`));
          process.emit("exit", 0, null);
        });
        return true;
      },
    } });
  });
}

async function run(input: { projectSlug?: string; sharedScopeId?: string; interactionMode?: string }) {
  const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: "owner_fixture" });
  const issued: Array<{ input: Parameters<MatrixMcpCapabilityIssuer["issue"]>[0]; token?: string }> = [];
  const issuer: MatrixMcpCapabilityIssuer = {
    issue(value) {
      const capability = registry.issue(value);
      // Keep the grant alive past the run so the test can read what it allows.
      issued.push({ input: value, ...(capability ? { token: capability.token } : {}) });
      return capability ? { ...capability, revoke: () => {} } : null;
    },
  };
  const adapter = createClaudeChatProviderAdapter({
    homePath: "/safe/home", spawnFn: fakeClaude(), resolveCredentialEnv: async () => ({}), matrixMcpCapabilityIssuer: issuer,
  });
  for await (const _ of adapter.start({
    owner: { type: "personal", ownerId: "owner_fixture" }, chatId: "chat_fixture", turnId: "cturn_fixture", runId: "run_fixture",
    prompt: "Work on the task", parts: [{ type: "text", text: "Work on the task" }],
    selection: { instanceId: "claude_code_default", model: "claude-haiku-4-5" },
    interactionMode: input.interactionMode ?? "default", permissionMode: "supervised", signal: new AbortController().signal,
    ...(input.projectSlug ? { projectSlug: input.projectSlug } : {}),
    ...(input.sharedScopeId ? { sharedScopeId: input.sharedScopeId } : {}),
  })) { /* Drain the native transport. */ }
  return { registry, issued };
}

// Fault detected: a chat run's token covered only integrations and Custom MCP, so its
// project board tools were refused by the gateway.
describe("Claude chat run board grant", () => {
  it("grants a project chat's run token its own board, as the chat", async () => {
    const { registry, issued } = await run({ projectSlug: "alpha" });
    try {
      expect(issued[0]!.input.board).toEqual({ chatId: "chat_fixture", projectSlug: "alpha" });
      const token = issued[0]!.token!;
      expect(registry.resolveRunContext(token, "POST", "/api/projects/alpha/tasks")?.board)
        .toEqual({ chatId: "chat_fixture", projectSlug: "alpha", readOnly: false });
      expect(registry.resolveRunContext(token, "GET", "/api/project-tasks/session")).not.toBeNull();
      expect(registry.resolveRunContext(token, "GET", "/api/projects/beta/tasks")).toBeNull();
      expect(registry.resolveRunContext(token, "DELETE", "/api/projects/alpha/tasks/task_1")).toBeNull();
    } finally { registry.close(); }
  });

  it("keeps a review run read-only and gives no board to a chat without a project or a shared chat", async () => {
    const review = await run({ projectSlug: "alpha", interactionMode: "review" });
    try {
      const token = review.issued[0]!.token!;
      expect(review.registry.resolveRunContext(token, "GET", "/api/projects/alpha/tasks")?.board?.readOnly).toBe(true);
      expect(review.registry.resolveRunContext(token, "POST", "/api/projects/alpha/tasks")).toBeNull();
    } finally { review.registry.close(); }
    for (const input of [{}, { projectSlug: "alpha", sharedScopeId: "scope_1" }]) {
      const { registry, issued } = await run(input);
      try {
        expect(issued[0]!.input.board).toBeUndefined();
        expect(registry.resolveRunContext(issued[0]!.token!, "GET", "/api/project-tasks/session")).toBeNull();
      } finally { registry.close(); }
    }
  });
});
