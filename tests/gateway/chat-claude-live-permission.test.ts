import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createClaudeChatProviderAdapter } from "../../packages/gateway/src/chat/claude-provider-adapter.js";
import type { CanonicalCliSpawn } from "../../packages/gateway/src/chat/cli-process.js";
import type { CustomMcpApprovalClient } from "../../packages/gateway/src/chat/custom-mcp-approval-client.js";
import type { CanonicalProviderRunEvent } from "../../packages/gateway/src/chat/provider-adapter.js";

type Frame = { type: string; request_id?: string; request?: { subtype: string; mode?: string; settings?: unknown }; response?: { response: unknown } };

describe("Claude live owner permission control", () => {
  it("waits for native mode and sandbox acknowledgements before releasing a waiting tool", async () => {
    const writes: Frame[] = [];
    const spawnFn = vi.fn<CanonicalCliSpawn>(() => {
      const child = new EventEmitter() as ReturnType<CanonicalCliSpawn>;
      child.stdout = new EventEmitter() as typeof child.stdout;
      child.stderr = new EventEmitter() as typeof child.stderr;
      const emit = (frame: unknown) => queueMicrotask(() => child.stdout!.emit("data", Buffer.from(`${JSON.stringify(frame)}\n`)));
      child.kill = vi.fn(() => { queueMicrotask(() => child.emit("exit", 0, null)); return true; });
      child.stdin = { write(chunk: string, callback?: (error?: Error | null) => void) {
        const frame = JSON.parse(chunk) as Frame;
        writes.push(frame);
        callback?.();
        if (frame.type === "user") emit({ type: "control_request", request_id: "native_shell", request: {
          subtype: "can_use_tool", tool_name: "Bash", input: { command: "pwd" },
        } });
        if (frame.type === "control_request") emit({ type: "control_response", response: {
          subtype: "success", request_id: frame.request_id,
          response: frame.request?.subtype === "set_permission_mode" ? { mode: frame.request.mode } : {},
        } });
        return true;
      }, end() {} } as typeof child.stdin;
      return child;
    });
    const controller = new AbortController();
    const owner = { type: "personal" as const, ownerId: "owner_claude" };
    const adapter = createClaudeChatProviderAdapter({
      homePath: "/home/matrix/home", spawnFn, resolveCredentialEnv: async () => ({}),
      customMcpApprovalClient: { verifyIntegrationDecision: vi.fn(async () => true) } as unknown as CustomMcpApprovalClient,
    });
    const events: CanonicalProviderRunEvent[] = [];
    const consuming = (async () => {
      for await (const event of adapter.start({
        owner, chatId: "chat_live", turnId: "cturn_live", runId: "run_live",
        prompt: "Inspect the current directory", parts: [{ type: "text", text: "Inspect the current directory" }],
        selection: { instanceId: "claude_code_default", model: "claude-sonnet-4-5" },
        interactionMode: "default", permissionMode: "supervised", signal: controller.signal,
      })) events.push(event);
    })();
    try {
      await vi.waitFor(() => expect(events.some(event => event.type === "approval.requested")).toBe(true));
      const liveAdapter = adapter as typeof adapter & { setPermissionMode?: (input: {
        owner: typeof owner; chatId: string; runId: string; clientRequestId: string; permissionMode: "full_access";
      }) => Promise<void> };
      await liveAdapter.setPermissionMode?.({ owner, chatId: "chat_live", runId: "run_live",
        clientRequestId: "req_live_permission", permissionMode: "full_access" });
      expect(writes.filter(frame => frame.type === "control_request").map(frame => frame.request)).toEqual([
        { subtype: "apply_flag_settings", settings: { sandbox: { enabled: false } } },
        { subtype: "set_permission_mode", mode: "bypassPermissions" },
      ]);
      expect(writes.filter(frame => frame.type === "control_response").map(frame => frame.response?.response))
        .toContainEqual({ behavior: "allow", updatedInput: { command: "pwd" } });
      expect(spawnFn.mock.calls[0]?.[1]).toContain("--allow-dangerously-skip-permissions");
    } finally {
      controller.abort();
      await consuming;
    }
  });
});
